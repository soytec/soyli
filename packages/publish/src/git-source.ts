import { sourceGit } from '../../grasp/src/client';
import { PublishError } from './config';
import { DiagnosticError } from '../../diagnostics/src';
import { isLegacyPublicBackendContext, LEGACY_BACKEND_CONTEXT } from './legacy-backend-context';
import { MAX_SOURCE_FILES } from './limits';
import { createSourceFileReader, createSourceLinkResolver } from './source-links';

export class SourceHistoryError extends DiagnosticError {
  readonly stage = 'check';
  readonly retryable = false;
}

export async function committedSource(directory: string) {
  const commit = await sourceGit(directory, ['rev-parse', '--verify', 'HEAD']).catch((cause) => {
    throw new PublishError(
      'COMMIT_REQUIRED',
      'Could not read a committed source revision. Check the Git error below; for a new project, save a checkpoint with soyli checkpoint "Describe your changes".',
      'check',
      false,
      cause,
    );
  });
  if (!/^[a-f0-9]{40}$/.test(commit))
    throw new PublishError(
      'COMMIT_REQUIRED',
      'Save a source checkpoint first: soyli checkpoint "Describe your changes".',
    );
  const changed = await sourceGit(directory, [
    '-c',
    'core.fsmonitor=false',
    'status',
    '--porcelain',
    '--untracked-files=normal',
  ]);
  if (changed)
    throw new PublishError(
      'SOURCE_DIRTY',
      'Commit your changes before sharing: soyli checkpoint "Describe your changes".',
    );
  return commit;
}

/** Reachable history is published too. Inspect blobs even if deleted from the current tree. */
export async function inspectHistory(directory: string, commit: string) {
  if (!/^[a-f0-9]{40}$/.test(commit))
    throw new PublishError('COMMIT_REQUIRED', 'Invalid source commit.');
  const objects = (await sourceGit(directory, ['rev-list', '--objects', commit])).split('\n');
  if (objects.length > 10000)
    throw new PublishError(
      'HISTORY_LIMIT',
      'This publisher supports up to 10,000 reachable Git objects. Use ordinary Git for larger histories.',
    );
  // rev-list --objects emits only one path for a reused blob. Walk each distinct
  // commit tree too, so an allowed path cannot hide a forbidden alias of that blob.
  const revisions = (await sourceGit(directory, ['log', '--format=%H:%T', commit])).split('\n');
  const trees = new Set<string>(),
    checked = new Set<string>();
  const blobs = new Map<string, { bytes: Uint8Array; size: number }>();
  const legacyPublicContexts: { path: string; object: string; commit: string }[] = [];
  const aliases: { path: string; target: string; executable: boolean }[] = [];
  const { checkSource, checkSourceContent } = await import('./project');
  let total = 0,
    legacyInCurrentTree = false;
  const loadBlob = async (id: string) => {
    let blob = blobs.get(id);
    if (!blob) {
      const size = Number(await sourceGit(directory, ['cat-file', '-s', id]));
      total += size;
      if (total > 40 * 1024 * 1024)
        throw new PublishError(
          'HISTORY_LIMIT',
          'Public Git history exceeds the supported 40 MiB total. Keep large assets in Blossom.',
        );
      blob = {
        size,
        bytes: new TextEncoder().encode(
          await sourceGit(directory, ['cat-file', 'blob', id], {}, 40 * 1024 * 1024),
        ),
      };
      blobs.set(id, blob);
    }
    return blob;
  };
  for (const revision of revisions) {
    const [containingCommit, treeId] = revision.split(':');
    if (trees.has(treeId)) continue;
    trees.add(treeId);
    const tree = (await sourceGit(directory, ['ls-tree', '-r', '-z', treeId]))
      .split('\0')
      .filter(Boolean);
    if (containingCommit === commit) {
      if (tree.length > MAX_SOURCE_FILES)
        throw new PublishError(
          'SOURCE_LIMIT',
          `This source tree has ${tree.length} tracked files; soyLI supports up to ${MAX_SOURCE_FILES}. This is a tooling limit, not a creator quota.`,
        );
      legacyInCurrentTree = tree.some((entry) => entry.endsWith(`\t${LEGACY_BACKEND_CONTEXT}`));
    }
    const entries = new Map<string, { mode: string; id: string }>();
    const directories = new Set<string>();
    for (const entry of tree) {
      const match = /^(\d+) (\w+) ([a-f0-9]{40})\t([\s\S]+)$/.exec(entry);
      const path = match?.[4] ?? '';
      // Gitlinks store a commit reference, not embedded submodule contents.
      // Only the release tree needs to be materialized into a source archive.
      if (match?.[1] === '160000' && match[2] === 'commit' && containingCommit !== commit) continue;
      const reason = !match
        ? 'Malformed Git tree entry.'
        : match[1] === '160000'
          ? 'Git submodule entries are not supported; soyLI does not fetch or embed submodule repositories.'
          : !['100644', '100755', '120000'].includes(match[1]) || match[2] !== 'blob'
            ? 'This Git entry type or file mode is not supported.'
            : path!.length > 200
              ? 'Source paths longer than 200 characters are not supported.'
              : path!.split('/').some((part) => !part || part === '.' || part === '..')
                ? 'Source paths cannot contain empty or traversal components.'
                : /[\\\s\u0000-\u001f\u007f]/.test(path!)
                  ? 'Source paths containing whitespace, backslashes or control characters are not supported.'
                  : undefined;
      if (reason)
        throw new SourceHistoryError(
          'SOURCE_PATH',
          `Git history contains an unsupported source entry: ${path ? JSON.stringify(path) : '(unreadable path)'}. ${reason}`,
          {
            operation: 'inspect public Git history',
            detail: `Containing commit: ${containingCommit}\nRelease commit: ${commit}`,
            recovery:
              match?.[1] === '160000' && containingCommit === commit
                ? 'Remove the submodule from the release tree, or replace it with the public regular source files you want to share, then save an ordinary commit and retry. Historical submodule references are allowed. No history rewrite is needed; soyLI does not fetch submodule contents.'
                : 'Inspect the named entry in the containing commit with git ls-tree. This is a source packaging restriction, not a credential detection. Removing it from HEAD or changing publish.files does not remove reachable history. Keep a repository backup before any explicitly approved history cleanup. soyLI has not rewritten history.',
          },
        );
      const [mode, id] = [match![1], match![3]];
      entries.set(path, { mode, id });
      const parts = path.split('/');
      while (parts.pop() && parts.length) directories.add(parts.join('/'));
    }
    const linkFailure = (path: string, id: string, cause?: PublishError) =>
      new SourceHistoryError(
        cause?.code ?? 'SOURCE_PATH',
        `Git history contains a blocked source link: ${path}.`,
        {
          operation: 'inspect public Git history',
          cause,
          detail: `Blob: ${id}\nContaining commit: ${containingCommit}\nRelease commit: ${commit}`,
          recovery:
            containingCommit === commit
              ? 'Source aliases must resolve to public regular files within the same committed tree. Fix the reported target/path problem, then save a checkpoint. Safe relative file aliases are supported without replacement or history rewriting.'
              : 'Historical source links must resolve to public regular files within the same committed tree. Absolute, escaping, private, dangling, cyclic and directory links are not supported. Review the recorded commit locally without sharing contents; back up the repository before any explicitly approved history cleanup. soyLI has not rewritten history.',
        },
      );
    const resolveLink = createSourceLinkResolver({
      entries: new Map(
        [...entries].map(([path, entry]) => [path, entry.mode === '120000' ? 'link' : 'file']),
      ),
      directories,
      checkSource,
      readLink: async (path) => {
        const blob = await loadBlob(entries.get(path)!.id);
        // The text Git helper trims output; do not accept changed link bytes.
        if (blob.bytes.length !== blob.size)
          throw new PublishError(
            'SOURCE_PATH',
            'Source link target must be an exact relative file path.',
          );
        return blob.bytes;
      },
    });
    for (const [path, { mode, id }] of entries) {
      if (mode === '120000') {
        // Resolution depends on the containing tree, even when the exact same
        // target-string blob and source path already passed in a newer commit.
        try {
          const target = await resolveLink(path);
          if (containingCommit === commit)
            aliases.push({ path, target, executable: entries.get(target)!.mode === '100755' });
        } catch (cause) {
          if (!(cause instanceof PublishError)) throw cause;
          if (cause.code === 'HISTORY_LIMIT') throw cause;
          throw linkFailure(path, id, cause);
        }
      }
      const key = `${id}:${path}`;
      if (checked.has(key)) continue;
      checked.add(key);
      if (checked.size > 10000)
        throw new PublishError(
          'HISTORY_LIMIT',
          'This publisher supports up to 10,000 historical file versions/paths. Use ordinary Git for larger histories.',
        );
      const blob = await loadBlob(id);
      let publicLegacy = false;
      try {
        checkSourceContent(blob.bytes);
        publicLegacy =
          path === LEGACY_BACKEND_CONTEXT && isLegacyPublicBackendContext(blob.bytes, blob.size);
        if (publicLegacy && !legacyInCurrentTree) {
          legacyPublicContexts.push({ path, object: id, commit: containingCommit });
        } else checkSource(path, blob.bytes);
      } catch (cause) {
        if (!(cause instanceof PublishError)) throw cause;
        const legacy = path === LEGACY_BACKEND_CONTEXT;
        throw new SourceHistoryError(cause.code, `Git history contains a blocked file: ${path}.`, {
          operation: 'inspect public Git history',
          detail: `Blob: ${id}\nContaining commit: ${containingCommit}\nRelease commit: ${commit}`,
          recovery:
            publicLegacy && legacyInCurrentTree
              ? 'Remove the generated context from Git tracking, keep .napplet-space/ ignored, and commit napplet.json plus backend module source. Retry soyli publish --dry-run. Local generated files can remain on disk.'
              : `${legacy ? 'This historical file does not match the supported public backend-context format. ' : ''}Changing publish.files or deleting a file from HEAD cannot remove it from Git history. Review it locally without sharing contents; rotate any exposed credentials. Back up the repository before an explicitly approved history cleanup, then retry soyli publish --dry-run. See docs/CLI.md (Historical source checks). soyLI has not rewritten history.`,
        });
      }
    }
  }
  return { commit, legacyPublicContexts, aliases };
}

export async function checkpoint(directory: string, message: string, author?: string) {
  if (!message.trim() || message.length > 1000)
    throw new Error('Provide a short checkpoint description.');
  await sourceGit(directory, ['rev-parse', '--git-dir']).catch(async () => {
    await sourceGit(directory, ['init']);
    await sourceGit(directory, ['symbolic-ref', 'HEAD', 'refs/heads/main']);
  });
  // Never auto-stage or commit as a side effect of publish/propose. This is explicit.
  const files = (
    await sourceGit(directory, ['ls-files', '--cached', '--others', '--exclude-standard', '-z'])
  )
    .split('\0')
    .filter(Boolean);
  const { regularFile, checkSource } = await import('./project');
  const sourceFile = await createSourceFileReader(directory, new Set(files), {
    regularFile,
    checkSource,
  });
  for (const path of files) {
    try {
      checkSource(path, await sourceFile(path, 40 * 1024 * 1024));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }
  await sourceGit(directory, ['add', '--all', '--', '.']);
  await sourceGit(
    directory,
    ['commit', '-m', message],
    author
      ? {
          GIT_AUTHOR_NAME: author,
          GIT_AUTHOR_EMAIL: `${author}@nostr`,
          GIT_COMMITTER_NAME: author,
          GIT_COMMITTER_EMAIL: `${author}@nostr`,
        }
      : {},
  );
  return { commit: await committedSource(directory), publicHistory: true };
}
