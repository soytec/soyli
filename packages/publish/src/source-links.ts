import { lstat, readlink } from 'node:fs/promises';
import { join } from 'node:path';
import { PublishError } from './config';
import { MAX_SOURCE_FILES } from './limits';

type SourceReaderChecks = {
  regularFile(root: string, path: string, limit: number): Promise<Uint8Array>;
  checkSource(path: string, bytes: Uint8Array): void;
};

type SourceLinkTree = {
  entries: ReadonlyMap<string, 'file' | 'link'>;
  directories: ReadonlySet<string>;
  readLink(path: string): Promise<Uint8Array>;
  checkSource(path: string, bytes: Uint8Array): void;
  checkDirectory?(path: string): Promise<void>;
};

const empty = new Uint8Array();

function checkPath(path: string) {
  if (
    !path ||
    path.length > 200 ||
    path.startsWith('/') ||
    /^[a-z]:/i.test(path) ||
    path.split('/').some((part) => !part || part === '.' || part === '..') ||
    /[\\\s\u0000-\u001f\u007f\ufffd]/.test(path)
  )
    throw new PublishError('SOURCE_PATH', 'Unsupported source file path.');
}

/** Resolve file aliases against one public source selection or one committed tree. */
export function createSourceLinkResolver(tree: SourceLinkTree) {
  const checkDirectory = async (path: string) => {
    if (!tree.directories.has(path) || tree.entries.has(path))
      throw new PublishError('SOURCE_PATH', 'Source link traverses a non-directory.');
    await tree.checkDirectory?.(path);
  };
  return async (start: string): Promise<string> => {
    const trail = new Set<string>();
    let path = start;
    for (;;) {
      checkPath(path);
      tree.checkSource(path, empty);
      const parts = path.split('/');
      for (let index = 1; index < parts.length; index++) {
        const parent = parts.slice(0, index).join('/');
        tree.checkSource(parent, empty);
        await checkDirectory(parent);
      }
      const kind = tree.entries.get(path);
      if (!kind)
        throw new PublishError(
          'SOURCE_PATH',
          'Source link target must be a selected public regular file; missing, ignored, unselected and directory targets are not supported.',
        );
      if (kind === 'file') return path;
      if (trail.has(path)) throw new PublishError('SOURCE_PATH', 'Cyclic source file alias.');
      if (trail.size >= MAX_SOURCE_FILES)
        throw new PublishError(
          'SOURCE_PATH',
          'Source file alias chain exceeds its supported limit.',
        );
      trail.add(path);
      const bytes = await tree.readLink(path);
      // Scan the link itself too, without ever including its raw target in errors.
      tree.checkSource(path, bytes);
      let target: string;
      try {
        target = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
      } catch {
        throw new PublishError('SOURCE_PATH', 'Source link target must be valid UTF-8.');
      }
      if (
        !target ||
        target.length > 200 ||
        target.startsWith('/') ||
        /^[a-z]:/i.test(target) ||
        /[\\\s\u0000-\u001f\u007f\ufffd]/.test(target)
      )
        throw new PublishError(
          'SOURCE_PATH',
          'Source link target must be a short relative file path.',
        );
      const resolved = parts.slice(0, -1);
      const targetParts = target.split('/');
      for (const [index, part] of targetParts.entries()) {
        if (!part) throw new PublishError('SOURCE_PATH', 'Empty source link path component.');
        if (part === '.') continue;
        if (part === '..') {
          if (!resolved.length)
            throw new PublishError('SOURCE_PATH', 'Source link escapes the public source tree.');
          resolved.pop();
          continue;
        }
        resolved.push(part);
        const candidate = resolved.join('/');
        checkPath(candidate);
        // Check each step before a following ../ could erase a forbidden path.
        tree.checkSource(candidate, empty);
        if (index < targetParts.length - 1) await checkDirectory(candidate);
      }
      path = resolved.join('/');
    }
  };
}

/** Filesystem reader used only for selected public source; config/artifact readers stay strict. */
export async function createSourceFileReader(
  root: string,
  selected: ReadonlySet<string>,
  checks: SourceReaderChecks,
) {
  if (selected.size > MAX_SOURCE_FILES)
    throw new PublishError(
      'SOURCE_LIMIT',
      `The public source selection exceeds ${MAX_SOURCE_FILES} files.`,
    );
  const entries = new Map<string, 'file' | 'link'>();
  const directories = new Set<string>();
  const inspectParents = async (path: string) => {
    const parts = path.split('/');
    for (let index = 1; index < parts.length; index++) {
      const parent = parts.slice(0, index).join('/');
      checks.checkSource(parent, empty);
      const stat = await lstat(join(root, parent));
      if (!stat.isDirectory() || stat.isSymbolicLink())
        throw new PublishError(
          'SOURCE_PATH',
          'Public source paths cannot traverse directory links or other non-directories.',
        );
      directories.add(parent);
    }
  };
  for (const path of selected) {
    checkPath(path);
    checks.checkSource(path, empty);
    try {
      await inspectParents(path);
      const stat = await lstat(join(root, path));
      if (stat.isSymbolicLink()) entries.set(path, 'link');
      else if (stat.isFile()) entries.set(path, 'file');
      else
        throw new PublishError(
          'SOURCE_PATH',
          'Selected public source must be a regular file or a safe file alias.',
        );
    } catch (cause) {
      // Tracked deletions can be checkpointed; an alias to a deleted file is
      // still rejected by the resolver instead of being silently omitted.
      if ((cause as NodeJS.ErrnoException).code !== 'ENOENT') throw cause;
    }
  }
  const resolve = createSourceLinkResolver({
    entries,
    directories,
    checkSource: checks.checkSource,
    checkDirectory: async (path) => {
      const stat = await lstat(join(root, path));
      if (!stat.isDirectory() || stat.isSymbolicLink())
        throw new PublishError(
          'SOURCE_PATH',
          'Public source paths cannot traverse directory links or other non-directories.',
        );
    },
    readLink: async (path) => {
      await inspectParents(path);
      return new Uint8Array(await readlink(join(root, path), { encoding: 'buffer' }));
    },
  });
  return async (path: string, limit: number): Promise<Uint8Array> => {
    checkPath(path);
    if (!selected.has(path))
      throw new PublishError('SOURCE_PATH', 'File is outside the selected public source.');
    if (!entries.has(path)) {
      const bytes = await checks.regularFile(root, path, limit);
      checks.checkSource(path, bytes);
      return bytes;
    }
    try {
      const target = await resolve(path);
      const bytes = await checks.regularFile(root, target, limit);
      checks.checkSource(target, bytes);
      checks.checkSource(path, bytes);
      return bytes;
    } catch (cause) {
      if (entries.get(path) !== 'link') throw cause;
      if ((cause as NodeJS.ErrnoException).code === 'ENOENT')
        throw new PublishError(
          'SOURCE_PATH',
          `Source alias ${path} or its target disappeared while reading. Restore the selected target or remove the broken alias before saving a checkpoint.`,
          'check',
          false,
          cause,
        );
      if (!(cause instanceof PublishError)) throw cause;
      throw new PublishError(
        cause.code,
        `Cannot publish source alias ${path}: ${cause.message}`,
        'check',
        false,
        cause,
      );
    }
  };
}
