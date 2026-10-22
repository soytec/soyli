import { RelayPool, type RelayOptions } from 'applesauce-relay';
import { take, takeUntil, takeWhile, timer, fromEvent } from 'rxjs';
import { matchFilters, type Filter } from 'nostr-tools';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { realpathSync } from 'node:fs';
import ipaddr from 'ipaddr.js';
import { publicIp, publicLookup } from './blossom';
import { verifiedEvent, type SignedEvent } from '../../protocol/src';
import { appReferences, referenceAddress, latestMetadata } from '../../protocol/src/preview';

// Bun's built-in ws substitute ignores lookup/maxPayload. Load the pinned implementation
// from its actual entry file so DNS checks run at connection time under both Bun and Node.
const require = createRequire(import.meta.url);
declare const NAPPLET_STANDALONE: boolean | undefined;
const NodeWebSocket: typeof import('ws').WebSocket = require(
  typeof NAPPLET_STANDALONE !== 'undefined' && NAPPLET_STANDALONE
    ? join(dirname(realpathSync(process.execPath)), 'lib/ws/index.js')
    : join(dirname(require.resolve('ws/package.json')), 'index.js'),
);
export function previewRelayUrl(value: string) {
  const url = new URL(value);
  const hostname = url.hostname.replace(/^\[|\]$/g, '');
  if (
    value.length > 256 ||
    url.protocol !== 'wss:' ||
    (url.port && url.port !== '443') ||
    url.username ||
    url.password ||
    url.hash ||
    (ipaddr.isValid(hostname) && !publicIp(hostname))
  )
    throw new Error('Invalid public metadata relay');
  return url.href;
}
export class PreviewWebSocket extends NodeWebSocket {
  constructor(url: string, protocols?: string | string[]) {
    super(previewRelayUrl(url), protocols, {
      lookup: publicLookup,
      handshakeTimeout: 3000,
      maxPayload: 65536,
      perMessageDeflate: false,
      followRedirects: false,
      finishRequest(request) {
        // Bun can deliver a queued timeout after a request error. ws clears
        // its request reference on error, so its timeout handler would then
        // throw outside the relay observable and terminate the web process.
        request.once('error', () => {
          request.setTimeout(0);
          request.removeAllListeners('timeout');
        });
        request.end();
      },
    });
  }
}

/** Finite read-only Applesauce queries. No AUTH, signing, publication or recursive link following. */
export async function queryPreviewMetadata(
  manifests: SignedEvent[],
  relays: string[],
  signal: AbortSignal,
  options: { pool?: RelayPool; timeoutMs?: number } = {},
) {
  const refs = [
    ...new Map(
      manifests.flatMap(appReferences).map((ref) => [referenceAddress(ref), ref]),
    ).values(),
  ].slice(0, 100);
  if (!refs.length || signal.aborted) return [];
  const pool =
    options.pool ??
    new RelayPool({ WebSocket: PreviewWebSocket as unknown as RelayOptions['WebSocket'] });
  const destinations = [
    ...new Set([...relays, ...refs.map((r) => r.relay).filter((r): r is string => !!r)]),
  ]
    .filter((r) => {
      try {
        previewRelayUrl(r);
        return true;
      } catch {
        return false;
      }
    })
    .slice(0, 12);
  const found = new Map<string, SignedEvent>();
  async function query(filters: Filter[]) {
    const jobs = destinations.flatMap((relay) => {
      const chunks = [];
      for (let i = 0; i < filters.length; i += 20)
        chunks.push({ relay, filters: filters.slice(i, i + 20) });
      return chunks;
    });
    await Promise.all(
      Array.from({ length: Math.min(4, jobs.length) }, async () => {
        for (let job = jobs.shift(); job && !signal.aborted; job = jobs.shift()) {
          await new Promise<void>((resolve) => {
            pool
              .req([job.relay], job.filters)
              .pipe(
                takeWhile((m) => m.type !== 'EOSE' && m.type !== 'CLOSED', true),
                take(250),
                takeUntil(timer(options.timeoutMs ?? 3000)),
                takeUntil(fromEvent(signal, 'abort')),
              )
              .subscribe({
                next: (message) => {
                  if (message.type !== 'EVENT' || found.size >= 400) return;
                  try {
                    if (new TextEncoder().encode(JSON.stringify(message.event)).length > 16384)
                      return;
                    const event = verifiedEvent(message.event);
                    if (
                      event.created_at <= Date.now() / 1000 + 600 &&
                      matchFilters(job!.filters, event)
                    )
                      found.set(event.id, event);
                  } catch {
                    /* Ignore forged or unrelated relay data. */
                  }
                },
                error: () => resolve(),
                complete: () => resolve(),
              });
          });
        }
      }),
    );
  }
  try {
    await query(
      refs.map((r) => ({ kinds: [r.kind], authors: [r.pubkey], '#d': [r.identifier], limit: 3 })),
    );
    const profiles = [
      ...new Set(
        refs
          .map((r) => latestMetadata(r, [...found.values()]))
          .filter((e) => e?.kind === 31990 && e.content === '')
          .map((e) => e!.pubkey),
      ),
    ];
    if (profiles.length) await query([{ kinds: [0], authors: profiles, limit: profiles.length }]);
    return [...found.values()];
  } finally {
    pool.close();
  }
}
