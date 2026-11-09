/** MIME types this client can read as a source archive. */
export const SOURCE_ARCHIVE_MIMES = ['application/x-tar'] as const;
export type SourceArchiveReference = { url: URL; hash: string; mime: string };

/**
 * The signed `source-archive` reference of a manifest.
 *
 * NIP-5D (PR 2303 at c041f84): `["source-archive", <https-url>, <sha256>, <mime>]`,
 * an absolute HTTPS URL without credentials or fragment, the digest of the archive
 * bytes before decompression, and the MIME type. Earlier soyLI releases wrote
 * `["source-archive", <url ending in sha256>]`; that form remains readable.
 *
 * @returns `null` when no reference is present. Throws when the field is malformed,
 * repeated, or names a format this client cannot read; callers treat that as
 * unusable optional metadata, never as a playback failure.
 */
export function sourceArchiveReference(tags: string[][]): SourceArchiveReference | null {
  const refs = tags.filter((tag) => tag[0] === 'source-archive');
  if (!refs.length) return null;
  const tag = refs[0];
  if (refs.length !== 1 || typeof tag[1] !== 'string' || !tag[1] || tag[1].length > 4096)
    throw new Error('Invalid source archive reference.');
  const url = new URL(tag[1]);
  if (url.username || url.password || url.hash)
    throw new Error('Invalid source archive reference.');
  if (tag.length === 4) {
    const [, , hash, mime] = tag;
    if (url.protocol !== 'https:' || !/^[a-f0-9]{64}$/.test(hash))
      throw new Error('Invalid source archive reference.');
    if (!(SOURCE_ARCHIVE_MIMES as readonly string[]).includes(mime))
      throw new Error(`Unsupported source archive format: ${mime.slice(0, 80)}`);
    return { url, hash, mime };
  }
  const hash = /\/([a-f0-9]{64})(?:\.tar)?$/.exec(url.pathname)?.[1];
  if (tag.length !== 2 || !hash || !['https:', 'http:'].includes(url.protocol))
    throw new Error('Invalid source archive reference.');
  return { url, hash, mime: 'application/x-tar' };
}

function single(tags: string[][], name: string) {
  const found = tags.filter((tag) => tag[0] === name);
  return found.length === 1 && found[0].length === 2 && typeof found[0][1] === 'string'
    ? found[0][1]
    : null;
}

/**
 * The manifest's `source` location, or `null` when it is absent, malformed or
 * repeated (NIP-5D Source: clients MUST ignore such a field). Accepts absolute
 * `http`, `https`, `ssh`, `git` or `nostr` URLs and Git's scp-like SSH syntax.
 */
export function manifestSourceLocation(tags: string[][]) {
  const value = single(tags, 'source');
  if (!value || value.length > 4096) return null;
  if (/^(?:[^@\s/:]+@)?[^\s/:]+:[^\s/][^\s]*$/.test(value) && !value.includes('://')) return value;
  try {
    return ['http:', 'https:', 'ssh:', 'git:', 'nostr:'].includes(new URL(value).protocol)
      ? value
      : null;
  } catch {
    return null;
  }
}

/** A full lowercase Git commit ID pinned by `source-commit`, only beside a Git `source`. */
export function manifestSourceCommit(tags: string[][]) {
  const commit = single(tags, 'source-commit');
  if (!commit || !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(commit)) return null;
  return manifestSourceLocation(tags) ? commit : null;
}
