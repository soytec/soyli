import { sourceGit } from '../packages/grasp/src/client';
import { lstat, readlink } from 'node:fs/promises';
import { join } from 'node:path';
import { regularFile, checkSource, MAX_SOURCE_BYTES } from '../packages/publish/src/project';
import { createSourceFileReader } from '../packages/publish/src/source-links';
import { MAX_SOURCE_FILES } from '../packages/publish/src/limits';
import { sha256 } from '../packages/protocol/src';

/** Snapshot bytes, the index and HEAD: an editor save must invalidate a reviewed action. */
export async function workingTree(directory: string) {
  const git = (args: string[]) => sourceGit(directory, ['-c', 'core.fsmonitor=false', ...args]);
  const head = await git(['rev-parse', '--verify', 'HEAD']).catch(() => null);
  const paths = [
    ...new Set(
      (await git(['ls-files', '-z', '--cached', '--others', '--exclude-standard']))
        .split('\0')
        .filter(Boolean),
    ),
  ].sort();
  if (paths.length > MAX_SOURCE_FILES)
    throw new Error(`Keep the project within the ${MAX_SOURCE_FILES} source file limit.`);
  let total = 0;
  const files: { path: string; hash: string | null; bytes: number; link?: string }[] = [];
  const readSource = await createSourceFileReader(directory, new Set(paths), {
    regularFile,
    // A status snapshot hashes content but never displays it. Diff review below
    // performs the content scan before returning any source to the local UI.
    checkSource: (path) => checkSource(path, new Uint8Array()),
  });
  for (const path of paths) {
    try {
      const bytes = await readSource(path, MAX_SOURCE_BYTES);
      total += bytes.length;
      if (total > MAX_SOURCE_BYTES) throw new Error('Source exceeds 40 MiB.');
      const link = (await lstat(join(directory, path))).isSymbolicLink()
        ? await sha256(
            new Uint8Array(await readlink(join(directory, path), { encoding: 'buffer' })),
          )
        : undefined;
      // Equal target bytes do not mean equal source: retargeting a Git alias
      // must invalidate the approval token just like any other Git edit.
      files.push({
        path,
        hash: await sha256(bytes),
        bytes: bytes.length,
        ...(link ? { link } : {}),
      });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      files.push({ path, hash: null, bytes: 0 });
    }
  }
  const index = await git(['ls-files', '--stage', '-z']);
  const changed = new Set(
    (await git(['ls-files', '-z', '--others', '--exclude-standard'])).split('\0').filter(Boolean),
  );
  const diff = head
    ? ['diff', '--name-only', '-z', 'HEAD', '--']
    : ['diff', '--cached', '--name-only', '-z', '--'];
  for (const path of (await git(diff)).split('\0').filter(Boolean)) changed.add(path);
  const [stagedText, unstagedText] = await Promise.all([
    git(['diff', '--cached', '--name-only', '-z', '--']),
    git(['diff', '--name-only', '-z', '--']),
  ]);
  const staged = stagedText.split('\0').filter(Boolean),
    unstaged = unstagedText.split('\0').filter(Boolean);
  for (const path of [...staged, ...unstaged]) changed.add(path);
  const branch = await git(['symbolic-ref', '--short', '-q', 'HEAD']).catch(() => '(detached)');
  return {
    head,
    branch,
    changed: [...changed].sort(),
    staged,
    unstaged,
    paths,
    revision: await sha256(JSON.stringify({ head, branch, index, files })),
  };
}

export async function workingDiff(directory: string, revision: string, path: string) {
  const tree = await workingTree(directory);
  if (revision !== tree.revision)
    throw new Error('Files changed. Reload changes before reviewing.');
  if (!tree.changed.includes(path)) throw new Error('Choose a changed file.');
  let bytes: Uint8Array | undefined;
  let link: string | undefined;
  const selected = new Set(tree.paths);
  const readSource = await createSourceFileReader(directory, selected, {
    regularFile,
    checkSource,
  });
  try {
    // A staged removal may no longer be selected source. Its Git deletion diff
    // remains available without reading an ignored replacement from disk.
    if (selected.has(path)) {
      bytes = await readSource(path, MAX_SOURCE_BYTES);
      if ((await lstat(join(directory, path))).isSymbolicLink()) {
        const target = new Uint8Array(
          await readlink(join(directory, path), { encoding: 'buffer' }),
        );
        checkSource(path, target);
        link = new TextDecoder('utf-8', { fatal: true }).decode(target);
      }
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  checkSource(path, bytes ?? new Uint8Array());
  let diff = tree.head
    ? await sourceGit(
        directory,
        ['diff', '--no-ext-diff', '--no-textconv', '--no-color', 'HEAD', '--', path],
        {},
        256 * 1024,
      )
    : '';
  checkSource(path, new TextEncoder().encode(diff));
  if (!diff && bytes) {
    if (link) diff = `New file alias: ${link}`;
    else if (bytes.length > 128 * 1024 || bytes.includes(0))
      diff = `New binary or large file · ${bytes.length} bytes. Inspect it in your editor or the asset cupboard.`;
    else diff = new TextDecoder().decode(bytes);
  }
  return { path, diff: diff || 'No content change.', revision };
}
