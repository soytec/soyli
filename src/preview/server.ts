import { relatedAssetHtml } from '../../packages/assets/src/related';
import { diagnose, formatDiagnostic } from '../../packages/diagnostics/src';
import { manageProject, editProject } from '../manager';
import type { Workshop } from '../workshop';
import { readBytes } from '../../packages/client/src/bytes';
import { readAssets, assetBytes, assetMime } from '../../packages/assets/src';
import { readBinding } from '../../packages/publish/src/binding';
import { recordingSchema, type Recording } from '../../packages/publish/src/config';
import { videoBytesResponse } from '../../packages/backend/src/preview-videos';
import { z } from 'zod';
import { MAX_READ_ARTIFACT_BYTES, sha256 } from '../../packages/protocol/src/artifact';
import { missingDomains } from '../../packages/runtime/src/capabilities';
import type { PreviewAssets } from './assets';
import { builtRequirements } from '../../packages/publish/src/artifact';
import { regularFile } from '../../packages/publish/src/project';
import { fileURLToPath } from 'node:url';
import { listingPreview, listingImage, listingVideo } from './listing';
import type { Network } from '../../packages/identity/src/signer';
import type { BackendProvider } from '../../packages/multiplayer/src/client';
import { backendConfig } from '../../packages/multiplayer/src/contracts';
import { backendProject } from '../backend';
import { projectIdentity } from '../../packages/publish/src/config';

const relayUrl = z
  .string()
  .max(2048)
  .transform((value) => new URL(value))
  .refine(
    (url) => ['ws:', 'wss:'].includes(url.protocol) && !url.username && !url.password && !url.hash,
  )
  .transform((url) => url.href);
const configSchema = z.object({
  title: z.string().max(256).optional(),
  archetypes: z.array(z.string().max(256)).max(32).default([]),
  intents: z
    .array(
      z.object({
        intent: z.string().max(1024),
        parameters: z.array(z.string().max(128)).max(32).default([]),
      }),
    )
    .max(64)
    .default([]),
  backend: backendConfig.optional(),
  previewId: z.uuid(),
  entry: z.enum(['index.html', 'dist/index.html']),
  requires: z
    .array(z.string().regex(/^[a-z]+$/))
    .max(32)
    .default([]),
  relays: z.array(relayUrl).max(8).default([]),
  servers: z.array(z.url().max(2048)).max(8).default([]),
});
export type PreviewRevision = {
  intentCatalogId: string;
  intentTags: string[][];
  title: string;
  backend?: BackendProvider;
  backendAliases?: BackendProvider[];
  id: string;
  artifactHash: string;
  servers: string[];
  uploadServers: string[];
  hostIdentity: string;
  backendIdentity?: string;
  requires: string[];
  relays: string[];
};

/** Local source is the authority here: no publisher keys or fabricated relay events. */
export function startPreviewServer(
  root: URL,
  port = Number(process.env.PORT ?? 4173),
  announce = true,
  assets?: PreviewAssets,
  listing: {
    network: Network;
    readOnly?: boolean;
    backend?: BackendProvider;
    capture?: (interactive?: boolean) => Promise<unknown>;
    record?: (settings: Recording, interactive?: boolean) => Promise<unknown>;
    workshop?: Workshop;
  } = { network: 'public' },
) {
  let capturing = false;
  const managerToken = crypto.randomUUID();
  async function revision() {
    // BunFile caches stat/size: create fresh handles after every editor save.
    const configFile = Bun.file(new URL('napplet.json', root));
    if (configFile.size > 16384) throw new Error('Project configuration is too large.');
    const portableText = await configFile.text();
    const binding = await readBinding(fileURLToPath(root));
    const configText = JSON.stringify({ ...JSON.parse(portableText), ...(binding?.project ?? {}) });
    const config = configSchema.parse(JSON.parse(configText));
    const originalBytes = await regularFile(
      fileURLToPath(root),
      config.entry,
      MAX_READ_ARTIFACT_BYTES,
    );
    const managed = await readAssets(fileURLToPath(root));
    const bytes = await relatedAssetHtml(originalBytes, managed);
    if (bytes.length > MAX_READ_ARTIFACT_BYTES || configText.length > 16384)
      throw new Error('Project exceeds preview limits.');
    const artifactHash = await sha256(bytes);
    const backend = listing.backend ? await backendProject(fileURLToPath(root)) : undefined;
    const info: PreviewRevision = {
      intentCatalogId: `soy:local-preview:${config.previewId}`,
      title: config.title ?? 'Local preview',
      intentTags: [
        ...config.archetypes.map((role) => ['z', role]),
        ...config.intents.map((i) => ['i', i.intent, ...i.parameters]),
      ],
      backend: listing.backend,
      backendAliases: listing.backend && config.backend?.provider ? [config.backend.provider] : [],
      id: await sha256(`${artifactHash}:${configText}:${JSON.stringify(managed)}`),
      artifactHash,
      hostIdentity: `local-preview:${config.previewId}:${artifactHash}`,
      ...(backend
        ? {
            backendIdentity: `${backend.pubkey}:35129:${projectIdentity(backend.project)}:${artifactHash}`,
          }
        : {}),
      requires: [
        ...new Set([
          ...config.requires,
          ...(managed.assets.some((a) => a.storage === 'external') ? ['resource'] : []),
          ...(config.entry === 'dist/index.html' ? await builtRequirements(bytes) : []),
        ]),
      ],
      relays: [...new Set([...(listing.backend?.relays ?? []), ...config.relays])],
      uploadServers: config.servers,
      servers: managed.assets.length ? [server.url.origin, ...config.servers] : config.servers,
    };
    return { info, bytes, servers: config.servers };
  }
  const noStore = { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' };
  const server = Bun.serve({
    idleTimeout: 60,
    hostname: '127.0.0.1',
    port,
    async fetch(request): Promise<Response> {
      const url = new URL(request.url);
      // Restrict local build files and capture actions to this preview origin.
      if (
        !['127.0.0.1', 'localhost'].includes(url.hostname) ||
        url.port !== server.url.port ||
        (request.headers.has('Origin') && request.headers.get('Origin') !== url.origin)
      )
        return new Response('Forbidden', { status: 403, headers: noStore });
      if (listing.readOnly && request.method !== 'GET')
        return new Response('This frozen preview is read-only.', { status: 405, headers: noStore });
      try {
        if (url.pathname.startsWith('/workshop')) {
          if (!listing.workshop) return new Response('Not found', { status: 404 });
          if (request.headers.get('X-Soyli-Token') !== managerToken)
            return new Response('Forbidden', { status: 403, headers: noStore });
          if (request.method === 'GET') {
            if (url.pathname === '/workshop')
              return Response.json(await listing.workshop.snapshot(), { headers: noStore });
            if (url.pathname === '/workshop/diff')
              return Response.json(
                await listing.workshop.diff(
                  url.searchParams.get('revision') ?? '',
                  url.searchParams.get('path') ?? '',
                ),
                { headers: noStore },
              );
            if (url.pathname === '/workshop/cover' || url.pathname === '/workshop/video') {
              const video = url.pathname.endsWith('/video');
              const bytes = listing.workshop.media(video ? 'video' : 'preview');
              return new Response(bytes ? new Uint8Array(bytes) : null, {
                status: bytes ? 200 : 404,
                headers: { ...noStore, 'Content-Type': video ? 'video/webm' : 'image/png' },
              });
            }
          }
          if (request.method === 'POST' && url.pathname === '/workshop') {
            if (request.headers.get('Origin') !== url.origin)
              return new Response('Forbidden', { status: 403 });
            if (capturing) return new Response('Capture running', { status: 409 });
            const bytes = await readBytes(new Response(request.body), 8192);
            return Response.json(
              await listing.workshop.start(
                JSON.parse(new TextDecoder().decode(bytes)),
                server.url.origin,
              ),
              { status: 202, headers: noStore },
            );
          }
          return new Response('Not found', { status: 404 });
        }
        if (url.pathname.startsWith('/manager')) {
          if (
            request.headers.get('X-Soyli-Token') !== managerToken &&
            !url.pathname.startsWith('/manager/asset/') &&
            url.pathname !== '/manager/presentation'
          )
            return new Response('Forbidden', { status: 403, headers: noStore });
          if (url.pathname === '/manager' && request.method === 'GET')
            return Response.json(await manageProject(fileURLToPath(root), listing.network), {
              headers: noStore,
            });
          if (url.pathname === '/manager' && request.method === 'POST') {
            if (request.headers.get('Origin') !== url.origin)
              return new Response('Forbidden', { status: 403 });
            if (capturing) return new Response('Capture already running', { status: 409 });
            const body = await readBytes(new Response(request.body), 14 * 1024 * 1024 + 8192);
            return Response.json(
              await (
                listing.workshop
                  ? listing.workshop.edit.bind(listing.workshop)
                  : async (fn: () => Promise<unknown>) => fn()
              )(() =>
                editProject(
                  fileURLToPath(root),
                  listing.network,
                  JSON.parse(new TextDecoder().decode(body)),
                ),
              ),
              { headers: noStore },
            );
          }
          if (url.pathname === '/manager/presentation' && request.method === 'GET') {
            const file = url.searchParams.get('file') ?? '';
            // Only root capture names are exposed; regularFile rejects links and traversal.
            if (!/^(?:preview|presentation)[a-zA-Z0-9._-]*\.(png|webm)$/.test(file))
              return new Response('Not found', { status: 404 });
            const bytes = await regularFile(fileURLToPath(root), file, 5 * 1024 * 1024);
            const mime = assetMime(bytes);
            if (mime !== 'image/png' && mime !== 'video/webm')
              return new Response('Invalid capture', { status: 400 });
            return new Response(bytes, {
              headers: {
                ...noStore,
                'Content-Type': mime,
                'Content-Security-Policy': "default-src 'none'; sandbox",
              },
            });
          }
          if (/^\/manager\/asset\/[a-f0-9]{64}$/.test(url.pathname) && request.method === 'GET') {
            const asset = (await readAssets(fileURLToPath(root))).assets.find(
              (a) => a.hash === url.pathname.split('/').pop(),
            );
            if (!asset) return new Response('Not found', { status: 404 });
            return new Response(await assetBytes(fileURLToPath(root), asset), {
              headers: {
                ...noStore,
                'Content-Type': asset.mime,
                'Content-Security-Policy': "default-src 'none'; sandbox",
              },
            });
          }
          return new Response('Not found', { status: 404 });
        }
        if (
          [
            '/listing/capture',
            '/listing/record',
            '/listing/capture-live',
            '/listing/record-live',
          ].includes(url.pathname) &&
          request.method === 'POST'
        ) {
          // Only an explicit action in this host can write a selected screenshot.
          if (request.headers.get('Origin') !== url.origin)
            return new Response('Forbidden', { status: 403, headers: noStore });
          const record = url.pathname.startsWith('/listing/record');
          const interactive = url.pathname.endsWith('-live');
          if (record ? !listing.record : !listing.capture)
            return new Response('Capture unavailable', { status: 404, headers: noStore });
          if (capturing || listing.workshop?.busy)
            return new Response('Capture already running', { status: 409, headers: noStore });
          server.timeout(request, 0); // The interactive capture has its own five-minute deadline.
          capturing = true;
          const capture = <T>(fn: () => Promise<T>) =>
            listing.workshop ? listing.workshop.edit(fn) : fn();
          try {
            if (record) {
              if (Number(request.headers.get('Content-Length') ?? 0) > 8192)
                throw new Error('Recording recipe too large.');
              const body = new TextDecoder().decode(
                await readBytes(new Response(request.body), 8192),
              );
              if (body.length > 8192) throw new Error('Recording recipe too large.');
              return Response.json(
                await capture(() =>
                  listing.record!(recordingSchema.parse(JSON.parse(body)), interactive),
                ),
                {
                  headers: noStore,
                },
              );
            }
            return Response.json(await capture(() => listing.capture!(interactive)), {
              headers: noStore,
            });
          } finally {
            capturing = false;
          }
        }
        if (request.method !== 'GET')
          return new Response('Method not allowed', { status: 405, headers: noStore });
        if (url.pathname === '/listing')
          return Response.json(
            await listingPreview(
              fileURLToPath(root),
              listing.network,
              !!listing.capture,
              !!listing.record,
            ),
            { headers: noStore },
          );
        if (url.pathname === '/listing/preview.webm')
          return videoBytesResponse((await listingVideo(fileURLToPath(root))).bytes, request);
        if (url.pathname === '/listing/preview.png')
          return new Response((await listingImage(fileURLToPath(root))).bytes, {
            headers: {
              ...noStore,
              'Content-Type': 'image/png',
              'Content-Security-Policy': "default-src 'none'; sandbox",
            },
          });
        if (/^\/[a-f0-9]{64}$/.test(url.pathname)) {
          const asset = (await readAssets(fileURLToPath(root))).assets.find(
            (a) => a.hash === url.pathname.slice(1),
          );
          if (!asset) return new Response('Not found', { status: 404 });
          return new Response(await assetBytes(fileURLToPath(root), asset), {
            headers: {
              ...noStore,
              'Content-Type': asset.mime,
              'Content-Security-Policy': "default-src 'none'; sandbox",
            },
          });
        }
        if (url.pathname === '/revision')
          return Response.json((await revision()).info, { headers: noStore });
        if (/^\/artifacts\/[a-f0-9]{64}$/.test(url.pathname)) {
          const current = await revision();
          if (url.pathname.endsWith('/' + current.info.artifactHash))
            return new Response(current.bytes, {
              headers: {
                ...noStore,
                'Content-Type': 'application/octet-stream',
                'Content-Security-Policy': "default-src 'none'; sandbox",
              },
            });
        }
        if (url.pathname === '/runtime.js')
          return new Response(assets?.client ?? Bun.file(new URL('.napplet/client.js', root)), {
            headers: { ...noStore, 'Content-Type': 'text/javascript; charset=utf-8' },
          });
        if (url.pathname === '/')
          return new Response(
            (assets?.html ?? (await Bun.file(new URL('.napplet/preview.html', root)).text()))
              .replace(
                '<html lang="en">',
                `<html lang="en"><meta name="soyli-token" content="${managerToken}">`,
              )
              .replace(
                '<meta name="viewport"',
                `<meta name="soyli-workshop" content="${!!listing.workshop}"><meta name="viewport"`,
              ),
            {
              headers: {
                ...noStore,
                'Content-Type': 'text/html; charset=utf-8',
                'Content-Security-Policy':
                  // srcdoc inherits this policy too; its own stricter CSP removes
                  // 'self' and all network access while allowing embedded code.
                  `script-src 'self' 'unsafe-inline' 'wasm-unsafe-eval'; frame-src 'self'${listing.workshop ? ' http://127.0.0.1:*' : ''}; object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors ${listing.workshop ? "'none'" : "'self' http://127.0.0.1:* http://localhost:*"}`,
              },
            },
          );
        return new Response('Not found', { status: 404, headers: noStore });
      } catch (error) {
        const diagnostic = diagnose(error, 'local preview');
        return Response.json(
          {
            error: formatDiagnostic(diagnostic),
            diagnostic,
          },
          { status: 400, headers: noStore },
        );
      }
    },
  });
  if (announce) console.log(`Local napplet preview: ${server.url}`);
  return server;
}
