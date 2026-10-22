import { mkdir, rename, readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { sha256, type SignedEvent } from '../../protocol/src';
import { appReferences, latestMetadata } from '../../protocol/src/preview';
import {
  descriptorVideos,
  validatedVideo,
  inspectPreviewVideo,
  MAX_VIDEO_BYTES,
  type CachedVideo,
} from '../../protocol/src/preview-video';
import { fetchPublicBytes, publicResourceUrl } from './blossom';
import { manifestVideoSources } from '../../protocol/src/presentation';

type Entry = { manifest: SignedEvent; video?: CachedVideo | null };
export async function cachedVideoBytes(directory: string, video: CachedVideo) {
  const file = Bun.file(join(directory, 'previews', `${video.hash}.webm`));
  try {
    if (!(await file.exists()) || file.size !== video.bytes || file.size > MAX_VIDEO_BYTES)
      return null;
    const bytes = await file.bytes();
    if ((await sha256(bytes)) !== video.hash) return null;
    const info = inspectPreviewVideo(bytes);
    return info.width === video.width &&
      info.height === video.height &&
      info.durationMs === video.durationMs
      ? bytes
      : null;
  } catch {
    return null;
  }
}
// The operator may designate the same loopback CAS used for executable artifacts.
// Events supply only a signed hash, never an arbitrary local destination or path.
function localVideoUrl(origin: string, hash: string) {
  const url = new URL(origin);
  if (
    url.origin !== origin ||
    url.protocol !== 'http:' ||
    !['127.0.0.1', '[::1]'].includes(url.hostname) ||
    url.username ||
    url.password
  )
    throw new Error('Invalid local video cache origin');
  return new URL(`/${hash}`, url);
}
async function fetchLocalVideo(url: URL, signal: AbortSignal) {
  const response = await fetch(url, { signal, redirect: 'error' });
  if (
    !response.ok ||
    !response.body ||
    Number(response.headers.get('content-length')) > MAX_VIDEO_BYTES
  ) {
    await response.body?.cancel();
    throw new Error('Video not in local cache');
  }
  const reader = response.body.getReader(),
    chunks: Uint8Array[] = [];
  let length = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.length;
      if (length > MAX_VIDEO_BYTES) throw new Error('Video exceeds limit');
      chunks.push(value);
    }
  } finally {
    await reader.cancel();
  }
  return new Uint8Array(Buffer.concat(chunks));
}

export async function indexPreviewVideos(
  directory: string,
  entries: Entry[],
  metadata: SignedEvent[],
  signal: AbortSignal,
  options: {
    download?: (url: URL, signal: AbortSignal, maxBytes: number) => Promise<Uint8Array>;
    previous?: Entry[];
    localOrigin?: string;
  } = {},
) {
  const path = join(directory, 'previews');
  await mkdir(path, { recursive: true });
  const queue = [...entries];
  let remaining = 20 * 1024 * 1024;
  const downloaded = new Map<string, Promise<Omit<CachedVideo, 'descriptor' | 'url'>>>();
  await Promise.all(
    Array.from({ length: Math.min(2, queue.length) }, async () => {
      for (let entry = queue.shift(); entry && !signal.aborted; entry = queue.shift()) {
        entry.video = null;
        const candidates = [
          ...manifestVideoSources(entry.manifest).map((v) => ({
            ...v,
            descriptor: entry.manifest,
          })),
          ...appReferences(entry.manifest).flatMap((ref) => {
            const descriptor = latestMetadata(ref, metadata);
            return descriptor
              ? descriptorVideos(descriptor).map((v) => ({ ...v, descriptor }))
              : [];
          }),
        ];
        for (const { url, hash, descriptor } of candidates) {
          if (signal.aborted) break;
          try {
            const local = options.localOrigin ? localVideoUrl(options.localOrigin, hash) : null;
            const supplied = new URL(url);
            const fromLocal =
              !!local &&
              supplied.origin === local.origin &&
              !supplied.username &&
              !supplied.password &&
              !supplied.search &&
              !supplied.hash &&
              [local.pathname, `${local.pathname}.webm`].includes(supplied.pathname);
            const target = fromLocal ? local! : publicResourceUrl(url);
            const pathHash = /\/([a-f0-9]{64})(?:\.[a-z0-9]{1,8})?$/.exec(target.pathname)?.[1];
            if (pathHash && pathHash !== hash) continue;
            const old = options.previous
              ?.map((e) => e.video)
              .find((v) => v?.descriptor.id === descriptor.id && v.url === url && v.hash === hash);
            if (
              old &&
              validatedVideo(entry.manifest, old) &&
              (await cachedVideoBytes(directory, old))
            ) {
              entry.video = old;
              break;
            }
            const key = `${hash}:${url}`;
            let task = downloaded.get(key);
            if (!task) {
              if (remaining < MAX_VIDEO_BYTES) break;
              remaining -= MAX_VIDEO_BYTES;
              task = (async () => {
                const downloadSignal = AbortSignal.any([signal, AbortSignal.timeout(5000)]);
                let bytes: Uint8Array | undefined;
                if (local && !options.download) {
                  try {
                    const candidate = await fetchLocalVideo(local, downloadSignal);
                    if ((await sha256(candidate)) === hash) bytes = candidate;
                  } catch {
                    /* Use public signed URL if the configured CAS has no valid copy. */
                  }
                }
                if (!bytes) {
                  if (fromLocal && !options.download) throw new Error('Video not in local cache');
                  if (local && !options.download) {
                    if (remaining < MAX_VIDEO_BYTES) throw new Error('Video budget exhausted');
                    remaining -= MAX_VIDEO_BYTES;
                  }
                  bytes = await (options.download ?? fetchPublicBytes)(
                    target,
                    downloadSignal,
                    MAX_VIDEO_BYTES,
                  );
                }
                if (
                  signal.aborted ||
                  bytes.length > MAX_VIDEO_BYTES ||
                  (await sha256(bytes)) !== hash
                )
                  throw new Error('Invalid preview video');
                remaining += MAX_VIDEO_BYTES - bytes.length;
                const info = inspectPreviewVideo(bytes);
                const temporary = join(path, `${hash}.${crypto.randomUUID()}.tmp`);
                try {
                  await Bun.write(temporary, bytes);
                  await rename(temporary, join(path, `${hash}.webm`));
                } finally {
                  await rm(temporary, { force: true });
                }
                return { hash, bytes: bytes.length, ...info };
              })();
              downloaded.set(key, task);
            }
            entry.video = { descriptor, url, ...(await task) };
            break;
          } catch {
            /* An unavailable clip never changes playback or the static image. */
          }
        }
      }
    }),
  );
}
export async function prunePreviewVideos(
  directory: string,
  entries: Array<{ video?: CachedVideo | null }>,
) {
  const retained = new Set(entries.map((e) => e.video?.hash));
  for (const name of await readdir(join(directory, 'previews')).catch(() => [] as string[])) {
    if (/^[a-f0-9]{64}\.webm$/.test(name) && !retained.has(name.slice(0, -5)))
      await rm(join(directory, 'previews', name));
  }
}

/** Same-origin cached bytes only; normal byte ranges support browser media seeking. */
export function videoBytesResponse(
  bytes: Uint8Array,
  request: Request,
  mime: 'video/webm' | 'video/mp4' = 'video/webm',
) {
  const headers: Record<string, string> = {
    'Content-Type': mime,
    'X-Content-Type-Options': 'nosniff',
    'Cache-Control': 'no-store',
    'Accept-Ranges': 'bytes',
    'Access-Control-Allow-Origin': '*',
    'Content-Security-Policy': "default-src 'none'; media-src 'self'; sandbox",
  };
  let start = 0,
    end = bytes.length - 1,
    status = 200;
  const range = request.headers.get('range');
  if (range) {
    const match = /^bytes=(\d*)-(\d*)$/.exec(range);
    if (!match || (!match[1] && !match[2]))
      return new Response(null, {
        status: 416,
        headers: { ...headers, 'Content-Range': `bytes */${bytes.length}` },
      });
    start = match[1] ? Number(match[1]) : Math.max(0, bytes.length - Number(match[2]));
    end = match[1] && match[2] ? Math.min(end, Number(match[2])) : end;
    if (
      !Number.isSafeInteger(start) ||
      !Number.isSafeInteger(end) ||
      start > end ||
      start >= bytes.length
    )
      return new Response(null, {
        status: 416,
        headers: { ...headers, 'Content-Range': `bytes */${bytes.length}` },
      });
    headers['Content-Range'] = `bytes ${start}-${end}/${bytes.length}`;
    status = 206;
  }
  headers['Content-Length'] = String(end - start + 1);
  return new Response(
    request.method === 'HEAD' ? null : new Uint8Array(bytes.subarray(start, end + 1)),
    { status, headers },
  );
}
