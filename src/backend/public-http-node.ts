import { publicNodeWorker } from './public-node-worker.ts';

/** Node retains TLS hostname verification with the same guarded DNS lookup. */
export function fetchPublicBytesInNode(url: URL, signal: AbortSignal, maxBytes: number) {
  return publicNodeWorker(
    'src/backend/public-http-worker.ts',
    { url: url.href, maxBytes },
    signal,
    maxBytes,
    'download public HTTPS bytes',
  );
}
