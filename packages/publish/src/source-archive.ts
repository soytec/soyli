import { posix } from 'node:path';
import { sourceArchive } from '../../remix/src/archive';
import { MAX_SOURCE_FILES } from './limits';

export type SourceArchiveAlias = { path: string; target: string; executable: boolean };
const ARCHIVE_LIMIT = 50 * 1024 * 1024;
const EXPANDED_LIMIT = 40 * 1024 * 1024;
const decoder = new TextDecoder('utf-8', { fatal: true });
const encoder = new TextEncoder();
const text = (bytes: Uint8Array) => decoder.decode(bytes).replace(/\0.*$/s, '');
function octal(bytes: Uint8Array) {
  const value = text(bytes).trim();
  if (!/^[0-7]+$/.test(value)) throw new Error('Invalid source archive number');
  const number = parseInt(value, 8);
  if (!Number.isSafeInteger(number)) throw new Error('Invalid source archive number');
  return number;
}
function validPath(path: string) {
  return (
    Boolean(path) &&
    path.length <= 200 &&
    !path.startsWith('/') &&
    !/[\\\s\u0000-\u001f\u007f]/.test(path) &&
    !path
      .split('/')
      .some(
        (part) =>
          !part ||
          part === '.' ||
          part === '..' ||
          /^(?:\.git|\.napplet-space|node_modules|\.env(?:\..*)?|.*\.(?:nsec|ncryptsec|pem|key))$/i.test(
            part,
          ),
      )
  );
}
function gitLinkPath(bytes: Uint8Array) {
  // Only Git's single, byte-counted linkpath record is needed for a >100-byte
  // symlink target. No path, size, mode or other PAX overrides are interpreted.
  if (!bytes.length || bytes.length > 1024) throw new Error('Invalid source archive link metadata');
  const value = decoder.decode(bytes);
  const match = /^([1-9][0-9]{0,3}) linkpath=(.*)\n$/.exec(value);
  if (!match || match[0] !== value || Number(match[1]) !== bytes.length || match[2].length > 200)
    throw new Error('Unsupported source archive link metadata');
  return match[2];
}
type Entry = {
  path: string;
  type: number;
  size: number;
  mode: number;
  offset: number;
  paddedEnd: number;
  link: string;
};

/** Only for Git archives from the exact tree already accepted by inspectHistory.
 * Git retains source aliases; the portable remix archive contains regular files.
 * The untrusted archive reader deliberately continues to reject every link.
 */
export function materializeSourceArchive(
  bytes: Uint8Array,
  aliases: readonly SourceArchiveAlias[],
): Uint8Array {
  if (!bytes.length || bytes.length > ARCHIVE_LIMIT || bytes.length % 512)
    throw new Error('Invalid source archive');
  if (aliases.length > MAX_SOURCE_FILES)
    throw new Error(`Source archive exceeds the ${MAX_SOURCE_FILES} source file limit.`);
  const approved = new Map<string, SourceArchiveAlias>();
  for (const alias of aliases) {
    if (
      !validPath(alias.path) ||
      !validPath(alias.target) ||
      typeof alias.executable !== 'boolean' ||
      approved.has(alias.path)
    )
      throw new Error('Invalid or duplicate source archive alias');
    approved.set(alias.path, alias);
  }
  const entries: Entry[] = [],
    byPath = new Map<string, Entry>();
  let terminator = -1,
    fileCount = 0,
    expanded = 0,
    outputSize = bytes.length,
    pendingLink: string | undefined;
  for (let offset = 0; offset < bytes.length;) {
    const header = bytes.subarray(offset, offset + 512);
    if (header.every((byte) => byte === 0)) {
      if (pendingLink !== undefined) throw new Error('Source archive link metadata has no entry');
      if (bytes.length - offset < 1024 || !bytes.subarray(offset).every((byte) => byte === 0))
        throw new Error('Invalid source archive terminator');
      terminator = offset;
      break;
    }
    const checksum = header.reduce(
      (sum, byte, index) => sum + (index >= 148 && index < 156 ? 32 : byte),
      0,
    );
    if (checksum !== octal(header.subarray(148, 156)))
      throw new Error('Source archive checksum mismatch');
    const size = octal(header.subarray(124, 136));
    const paddedEnd = offset + 512 + Math.ceil(size / 512) * 512;
    if (!Number.isSafeInteger(paddedEnd) || paddedEnd > bytes.length)
      throw new Error('Truncated source archive');
    const type = header[156];
    if (pendingLink !== undefined && type !== 50)
      throw new Error('Source archive link metadata does not describe an approved alias');
    if (type === 120) {
      pendingLink = gitLinkPath(bytes.subarray(offset + 512, offset + 512 + size));
      outputSize -= paddedEnd - offset;
      offset = paddedEnd;
      continue;
    }
    if (type !== 0 && type !== 48 && type !== 50 && type !== 53 && type !== 103)
      throw new Error('Source archive special entries are not supported');
    const name = text(header.subarray(0, 100)),
      prefix = text(header.subarray(345, 500));
    const path = `${prefix ? prefix + '/' : ''}${name}`.replace(/\/$/, '');
    const entry = {
      path,
      type,
      size,
      mode: octal(header.subarray(100, 108)),
      offset,
      paddedEnd,
      link: pendingLink ?? text(header.subarray(157, 257)),
    };
    if (pendingLink !== undefined && !approved.has(path))
      throw new Error('Source archive link metadata does not describe an approved alias');
    pendingLink = undefined;
    // Git's global pax header is retained as uninterpreted commit metadata.
    if (type !== 103) {
      if (!validPath(path)) throw new Error('Unsafe source archive path');
      if (byPath.has(path)) throw new Error('Duplicate source archive path');
      if ((type === 53 || type === 50) && size)
        throw new Error('Invalid source archive link or directory');
      byPath.set(path, entry);
      if (type !== 53 && ++fileCount > MAX_SOURCE_FILES)
        throw new Error(`Source archive exceeds the ${MAX_SOURCE_FILES} source file limit.`);
      if (type !== 50 && type !== 53) expanded += size;
    }
    entries.push(entry);
    offset = paddedEnd;
  }
  if (terminator < 0) throw new Error('Incomplete source archive');
  const targets = new Map<string, Entry>();
  for (const entry of entries) {
    if (entry.type !== 50) {
      if (entry.type !== 103 && approved.has(entry.path))
        throw new Error('Source archive alias is not a link');
      continue;
    }
    const alias = approved.get(entry.path);
    if (!alias) throw new Error('Source archive contains an unapproved link');
    let current = entry;
    const visited = new Set<string>();
    while (current.type === 50) {
      if (visited.has(current.path)) throw new Error('Source archive contains a cyclic link');
      visited.add(current.path);
      if (
        !approved.has(current.path) ||
        !current.link ||
        current.link.startsWith('/') ||
        /[\\\s\u0000-\u001f\u007f]/.test(current.link)
      )
        throw new Error('Invalid source archive link target');
      const path = posix.normalize(posix.join(posix.dirname(current.path), current.link));
      if (!validPath(path)) throw new Error('Unsafe source archive link target');
      const next = byPath.get(path);
      if (!next) throw new Error('Source archive link target is missing');
      current = next;
    }
    if (
      (current.type !== 0 && current.type !== 48) ||
      current.path !== alias.target ||
      Boolean(current.mode & 0o111) !== alias.executable
    )
      throw new Error('Source archive alias does not match its verified regular target');
    targets.set(entry.path, current);
    expanded += current.size;
    outputSize += Math.ceil(current.size / 512) * 512;
  }
  if (targets.size !== approved.size) throw new Error('Source archive alias is missing');
  if (expanded > EXPANDED_LIMIT)
    throw new Error('Source archive exceeds the 40 MiB expanded source limit.');
  if (outputSize > ARCHIVE_LIMIT)
    throw new Error('Source archive exceeds the 50 MiB archive limit.');
  if (!aliases.length) {
    sourceArchive(bytes);
    return bytes;
  }

  // All counts and duplicated byte budgets are checked before allocation.
  const output = new Uint8Array(outputSize);
  let offset = 0;
  for (const entry of entries) {
    const target = entry.type === 50 ? targets.get(entry.path) : undefined;
    if (!target) {
      output.set(bytes.subarray(entry.offset, entry.paddedEnd), offset);
      offset += entry.paddedEnd - entry.offset;
      continue;
    }
    const header = bytes.slice(entry.offset, entry.offset + 512);
    header.set(
      encoder.encode(
        `${(approved.get(entry.path)!.executable ? 0o755 : 0o644).toString(8).padStart(7, '0')}\0`,
      ),
      100,
    );
    header.set(encoder.encode(`${target.size.toString(8).padStart(11, '0')}\0`), 124);
    header[156] = 48;
    header.fill(0, 157, 257);
    header.fill(32, 148, 156);
    const checksum = header.reduce((sum, byte) => sum + byte, 0);
    header.set(encoder.encode(`${checksum.toString(8).padStart(6, '0')}\0 `), 148);
    output.set(header, offset);
    output.set(
      bytes.subarray(target.offset + 512, target.offset + 512 + target.size),
      offset + 512,
    );
    offset += 512 + Math.ceil(target.size / 512) * 512;
  }
  output.set(bytes.subarray(terminator), offset);
  sourceArchive(output);
  return output;
}
