import { z } from 'zod';
import { eventSchema, type SignedEvent } from './index';
import { appReferences, latestMetadata } from './preview';
import { verifiedEvent } from './index';
import { manifestVideoSources } from './presentation';

export const MAX_VIDEO_BYTES = 5 * 1024 * 1024;
export const MAX_VIDEO_MS = 12000;
export const videoInfoSchema = z.object({
  width: z.number().int().min(1).max(1200),
  height: z.number().int().min(1).max(750),
  durationMs: z.number().positive().max(MAX_VIDEO_MS),
});

/** Bounded WebM/VP8 container admission, not a claim that every compressed frame decodes.
 * Only one silent video track; no lacing, codec switching or encrypted tracks. */
export function inspectPreviewVideo(bytes: Uint8Array) {
  const fail = () => {
    throw new Error('Use a silent VP8 WebM up to 12 seconds, 1200 × 750 and 5 MiB.');
  };
  if (!bytes.length || bytes.length > MAX_VIDEO_BYTES) return fail();
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let elements = 0;
  function vint(offset: number, id = false) {
    if (offset >= bytes.length || !bytes[offset]) return fail();
    const width = Math.clz32(bytes[offset]) - 24 + 1;
    if (width > (id ? 4 : 8) || offset + width > bytes.length) return fail();
    let value = id ? bytes[offset] : bytes[offset] & (0xff >> width);
    let unknown = !id && value === 0xff >> width;
    for (let i = 1; i < width; i++) {
      value = value * 256 + bytes[offset + i];
      unknown &&= bytes[offset + i] === 255;
    }
    if (!unknown && !Number.isSafeInteger(value)) return fail();
    return { value, width, unknown };
  }
  type Element = { id: number; start: number; end: number };
  function children(start: number, end: number): Element[] {
    const result: Element[] = [];
    while (start < end) {
      if (++elements > 5000) return fail();
      const id = vint(start, true),
        size = vint(start + id.width);
      const data = start + id.width + size.width;
      const next = size.unknown && id.value === 0x18538067 ? end : data + size.value;
      if ((size.unknown && id.value !== 0x18538067) || next > end || next < data) return fail();
      result.push({ id: id.value, start: data, end: next });
      start = next;
    }
    return result;
  }
  function one(items: Element[], id: number) {
    const found = items.filter((e) => e.id === id);
    if (found.length !== 1) return fail();
    return found[0];
  }
  function uint(e: Element) {
    if (e.end - e.start < 1 || e.end - e.start > 6) return fail();
    let n = 0;
    for (let i = e.start; i < e.end; i++) n = n * 256 + bytes[i];
    return n;
  }
  const text = (e: Element) => new TextDecoder().decode(bytes.subarray(e.start, e.end));
  const root = children(0, bytes.length);
  const header = one(root, 0x1a45dfa3),
    segment = one(root, 0x18538067);
  if (
    root.length !== 2 ||
    root[0] !== header ||
    text(one(children(header.start, header.end), 0x4282)) !== 'webm'
  )
    return fail();
  const parts = children(segment.start, segment.end);
  // Attachments and chapters are unnecessary for a short preview.
  if (parts.some((e) => [0x1941a469, 0x1043a770].includes(e.id))) return fail();
  const info = one(parts, 0x1549a966),
    tracks = one(parts, 0x1654ae6b);
  const information = children(info.start, info.end);
  const scaleElement = information.find((e) => e.id === 0x2ad7b1);
  const scale = scaleElement ? uint(scaleElement) : 1000000;
  if (scale < 1 || scale > 10000000) return fail();
  const duration = one(information, 0x4489);
  const durationMs =
    ((duration.end - duration.start === 8
      ? view.getFloat64(duration.start)
      : duration.end - duration.start === 4
        ? view.getFloat32(duration.start)
        : fail()) *
      scale) /
    1000000;
  const entries = children(tracks.start, tracks.end).filter((e) => e.id === 0xae);
  if (entries.length !== 1) return fail();
  const track = children(entries[0].start, entries[0].end);
  const number = uint(one(track, 0xd7));
  if (
    uint(one(track, 0x83)) !== 1 ||
    text(one(track, 0x86)) !== 'V_VP8' ||
    track.some((e) => e.id === 0x6d80)
  )
    return fail();
  const video = one(track, 0xe0),
    dimensions = children(video.start, video.end);
  const width = uint(one(dimensions, 0xb0)),
    height = uint(one(dimensions, 0xba));
  const result = videoInfoSchema.parse({ width, height, durationMs });
  let frames = 0,
    lastTime = -1,
    keyframe = false;
  for (const cluster of parts.filter((e) => e.id === 0x1f43b675)) {
    const blocks = children(cluster.start, cluster.end),
      base = uint(one(blocks, 0xe7));
    for (const block of blocks) {
      if (block.id === 0xa0) return fail(); // BlockGroup/codec-state is outside this initial profile.
      if (block.id !== 0xa3) continue;
      if (++frames > 600) return fail();
      const n = vint(block.start),
        p = block.start + n.width;
      if (n.value !== number || n.unknown || p + 4 > block.end || bytes[p + 2] & 6) return fail();
      const time = ((base + view.getInt16(p)) * scale) / 1000000;
      if (time < lastTime || time < 0 || time > durationMs + 100) return fail();
      lastTime = time;
      const data = p + 3;
      if (!(bytes[data] & 1)) {
        if (
          data + 10 > block.end ||
          bytes[data + 3] !== 0x9d ||
          bytes[data + 4] !== 1 ||
          bytes[data + 5] !== 0x2a ||
          (view.getUint16(data + 6, true) & 0x3fff) !== width ||
          (view.getUint16(data + 8, true) & 0x3fff) !== height
        )
          return fail();
        keyframe = true;
      }
      if (!keyframe) return fail();
    }
  }
  if (!frames || !keyframe || lastTime > MAX_VIDEO_MS) return fail();
  return result;
}

/** NIP-92 attachments on a linked software descriptor. The URL must also occur in content.
 * x is required by this client's bounded preview profile, not by napplet playback. */
export function descriptorVideos(descriptor: SignedEvent) {
  if (descriptor.kind !== 32267) return [];
  const urls = new Set(descriptor.content.match(/https?:\/\/[^\s<>"`]+/g) ?? []);
  const candidates: { url: string; hash: string }[] = [];
  const tags = descriptor.tags.filter((t) => t[0] === 'imeta');
  for (const tag of tags.slice(0, 8)) {
    const fields = new Map<string, string>();
    let duplicate = false;
    for (const value of tag.slice(1)) {
      const space = value.indexOf(' ');
      if (space < 1) continue;
      const key = value.slice(0, space);
      if (fields.has(key)) duplicate = true;
      fields.set(key, value.slice(space + 1));
    }
    const url = fields.get('url'),
      hash = fields.get('x');
    if (
      duplicate ||
      !url ||
      !urls.has(url) ||
      fields.get('m') !== 'video/webm' ||
      !hash ||
      !/^[a-f0-9]{64}$/.test(hash)
    )
      continue;
    if (tags.filter((t) => t.includes(`url ${url}`)).length !== 1) continue;
    candidates.push({ url, hash });
  }
  return candidates.slice(0, 2);
}
export const cachedVideoSchema = videoInfoSchema.extend({
  descriptor: eventSchema,
  url: z.string().max(4096),
  hash: z.string().regex(/^[a-f0-9]{64}$/),
  bytes: z.number().int().positive().max(MAX_VIDEO_BYTES),
});
export type CachedVideo = z.infer<typeof cachedVideoSchema>;
export function validatedVideo(manifest: SignedEvent, input: unknown): CachedVideo | null {
  try {
    const video = cachedVideoSchema.parse(input);
    if (video.descriptor.id === manifest.id) {
      const descriptor = verifiedEvent(video.descriptor);
      return manifestVideoSources(manifest).some(
        (v) => v.url === video.url && v.hash === video.hash,
      )
        ? { ...video, descriptor }
        : null;
    }
    if (!appReferences(manifest).some((ref) => latestMetadata(ref, [video.descriptor])))
      return null;
    return descriptorVideos(video.descriptor).some(
      (v) => v.url === video.url && v.hash === video.hash,
    )
      ? video
      : null;
  } catch {
    return null;
  }
}
