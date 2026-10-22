import { MAX_SOURCE_FILES } from '../../publish/src/limits';

/** Bounded Git tar reader. Never delegate untrusted extraction to tar or a shell. */
export function sourceArchive(bytes: Uint8Array) {
  if (bytes.length > 50 * 1024 * 1024 || bytes.length % 512)
    throw new Error('Invalid source archive');
  const files = new Map<string, Uint8Array>();
  let total = 0,
    ended = false;
  const text = (b: Uint8Array) =>
    new TextDecoder('utf-8', { fatal: true }).decode(b).replace(/\0.*$/s, '');
  const octal = (b: Uint8Array) => {
    const n = text(b).trim();
    if (!/^[0-7]+$/.test(n)) throw new Error('Invalid archive number');
    return parseInt(n, 8);
  };
  for (let offset = 0; offset < bytes.length;) {
    const h = bytes.subarray(offset, offset + 512);
    if (h.every((n) => n === 0)) {
      ended = true;
      break;
    }
    const checksum = [...h].reduce((sum, n, i) => sum + (i >= 148 && i < 156 ? 32 : n), 0);
    if (checksum !== octal(h.subarray(148, 156))) throw new Error('Archive checksum mismatch');
    const size = octal(h.subarray(124, 136));
    const end = offset + 512 + size;
    if (!Number.isSafeInteger(size) || size < 0 || end > bytes.length)
      throw new Error('Truncated source archive');
    const type = h[156],
      name = text(h.subarray(0, 100)),
      prefix = text(h.subarray(345, 500));
    const path = `${prefix ? prefix + '/' : ''}${name}`.replace(/\/$/, '');
    // Git's global pax header is metadata, never interpreted as an extraction path.
    if (type !== 103) {
      if (
        !path ||
        path.length > 200 ||
        path.startsWith('/') ||
        /[\\\s\u0000-\u001f\u007f]/.test(path) ||
        path
          .split('/')
          .some(
            (p) =>
              !p ||
              p === '.' ||
              p === '..' ||
              /^(?:\.git|\.napplet-space|node_modules|\.env(?:\..*)?|.*\.(?:nsec|ncryptsec|pem|key))$/i.test(
                p,
              ),
          )
      )
        throw new Error('Unsafe source archive path');
      if (type !== 0 && type !== 48 && type !== 53)
        throw new Error('Source archive links and special entries are not supported');
      if (type === 53 && size) throw new Error('Invalid archive directory');
      if (type !== 53) {
        if (files.has(path)) throw new Error('Duplicate source file');
        total += size;
        if (files.size >= MAX_SOURCE_FILES)
          throw new Error(`Source archive exceeds the ${MAX_SOURCE_FILES} source file limit.`);
        if (total > 40 * 1024 * 1024)
          throw new Error('Source archive exceeds the 40 MiB expanded source limit.');
        files.set(path, bytes.slice(offset + 512, end));
      }
    }
    offset += 512 + Math.ceil(size / 512) * 512;
  }
  if (!ended || !files.size) throw new Error('Incomplete source archive');
  // A file must never also be used as another file's parent directory.
  for (const path of files.keys()) {
    const parts = path.split('/');
    while (parts.pop() && parts.length)
      if (files.has(parts.join('/'))) throw new Error('Conflicting source paths');
  }
  return files;
}
