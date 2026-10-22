import { publicNodeWorker } from './public-node-worker';

/** Node retains TLS hostname verification with the same guarded DNS lookup. */
export function fetchPublicBytesInNode(url: URL, signal: AbortSignal, maxBytes: number) {
  return publicNodeWorker(
    'packages/backend/src/public-http-worker.ts',
    { url: url.href, maxBytes },
    signal,
    maxBytes,
    'download public HTTPS bytes',
  );
}
