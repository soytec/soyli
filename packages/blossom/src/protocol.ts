import { verifiedEvent, type SignedEvent } from '../../protocol/src';

export const BLOSSOM_SPEC = 'b5bd2801d1763aa635fc8fea7a76597e0eb18990';
export const HASH = /^[a-f0-9]{64}$/;
export const MAX_BLOB_BYTES = 50 * 1024 * 1024;
export type BlobDescriptor = {
  url: string;
  sha256: string;
  size: number;
  type: string;
  uploaded: number;
};
export type BlossomAction = 'upload' | 'delete' | 'list';
export class BlossomError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}
export function blossomOrigin(input: string, local = false) {
  const url = new URL(input);
  const loopback = ['127.0.0.1', '[::1]'].includes(url.hostname);
  if (
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.pathname !== '/' ||
    (local ? url.protocol !== 'http:' || !loopback : url.protocol !== 'https:')
  )
    throw new Error(
      local
        ? 'Local Blossom must use a literal loopback HTTP origin.'
        : 'Blossom must use a root HTTPS origin without credentials.',
    );
  return url.origin;
}
/** BUD-11 authorization. Server scopes come from configuration, never request/Forwarded headers. */
export function authorize(
  header: string | null,
  action: BlossomAction,
  domain: string,
  hash?: string,
  now = Math.floor(Date.now() / 1000),
) {
  if (!header || header.length > 16384)
    throw new BlossomError(401, 'A Nostr authorization token is required');
  const match = /^Nostr ([a-zA-Z0-9_+\/-]+={0,2})$/i.exec(header);
  if (!match) throw new BlossomError(401, 'Invalid authorization encoding');
  let event: SignedEvent;
  try {
    // Emit base64url in clients; also accept canonical legacy base64 for existing clients.
    const bytes = Buffer.from(match[1], 'base64');
    if (
      bytes.length > 12000 ||
      bytes.toString('base64url') !==
        match[1].replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '')
    )
      throw new Error('Non-canonical base64');
    event = verifiedEvent(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)));
  } catch {
    throw new BlossomError(401, 'Invalid signed authorization token');
  }
  const tags = (name: string) => event.tags.filter((t) => t[0] === name);
  const verbs = tags('t');
  const expires = tags('expiration');
  const servers = tags('server');
  const hashes = tags('x');
  if (
    event.kind !== 24242 ||
    !event.content.trim() ||
    event.created_at > now ||
    verbs.length !== 1 ||
    verbs[0].length !== 2 ||
    verbs[0][1] !== action ||
    expires.length !== 1 ||
    expires[0].length !== 2 ||
    !/^\d{1,12}$/.test(expires[0][1]) ||
    Number(expires[0][1]) <= now
  )
    throw new BlossomError(401, 'Authorization action or lifetime is invalid');
  if (
    servers.some(
      (t) =>
        t.length !== 2 || (t[1] !== '[::1]' && !/^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/.test(t[1])),
    ) ||
    (servers.length && !servers.some((t) => t[1] === domain))
  )
    throw new BlossomError(401, 'Authorization is not valid for this server');
  if (
    hashes.some((t) => t.length !== 2 || !HASH.test(t[1])) ||
    (action !== 'list' && (!hash || !hashes.some((t) => t[1] === hash)))
  )
    throw new BlossomError(401, 'Authorization is not valid for this blob');
  return event;
}
export function mimeType(input: string | null) {
  if (!input) return 'application/octet-stream';
  const mime = input.split(';')[0].trim().toLowerCase();
  if (mime.length > 127 || !/^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/.test(mime))
    throw new BlossomError(400, 'Invalid content type');
  return mime;
}
export function extension(type: string) {
  return (
    (
      {
        'text/html': 'html',
        'text/plain': 'txt',
        'text/css': 'css',
        'application/javascript': 'js',
        'application/json': 'json',
        'application/zip': 'zip',
        'application/pdf': 'pdf',
        'image/png': 'png',
        'image/jpeg': 'jpg',
        'image/webp': 'webp',
        'image/gif': 'gif',
        'image/avif': 'avif',
        'image/svg+xml': 'svg',
        'audio/mpeg': 'mp3',
        'audio/ogg': 'ogg',
        'audio/wav': 'wav',
        'video/mp4': 'mp4',
        'video/webm': 'webm',
      } as Record<string, string>
    )[type] ?? 'bin'
  );
}
