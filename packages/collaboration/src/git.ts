import { DiagnosticError } from '../../diagnostics/src';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import ipaddr from 'ipaddr.js';
import { sourceGit } from '../../grasp/src/client';
import { commitPattern, type Repository } from './protocol';
import { committedSource, inspectHistory } from '../../publish/src/git-source';

export function cloneUrl(value: string, local = false) {
  const u = new URL(value),
    host = u.hostname.replace(/^\[|\]$/g, '');
  if (
    u.username ||
    u.password ||
    u.hash ||
    u.search ||
    (local
      ? u.protocol !== 'http:' || !['127.0.0.1', '::1', 'localhost'].includes(host)
      : u.protocol !== 'https:' ||
        host === 'localhost' ||
        host.endsWith('.local') ||
        host.endsWith('.localhost') ||
        (ipaddr.isValid(host) && ipaddr.process(host).range() !== 'unicast'))
  )
    throw new Error('Use a public HTTPS Git URL, or loopback HTTP in the local network.');
  return u.href;
}
/** Select supported Git hosts without letting an alternate Git transport
 * invalidate usable HTTPS (or explicit local HTTP) candidates. */
export function selectCloneUrls(inputs: string[], local = false): string[] {
  const selected: string[] = [],
    failures: Error[] = [];
  for (const input of inputs) {
    try {
      const url = cloneUrl(input, local);
      if (!selected.includes(url)) selected.push(url);
      if (selected.length === 4) break;
    } catch (cause) {
      failures.push(cause instanceof Error ? cause : new Error('Invalid Git clone URL.'));
    }
  }
  if (!selected.length)
    throw new DiagnosticError('GIT_CLONE_URLS', 'The repository has no supported Git clone URL.', {
      operation: 'select Git hosts',
      cause: failures.length
        ? new AggregateError(failures, 'All advertised clone URLs were refused.')
        : undefined,
      recovery: local
        ? 'The upstream must advertise a loopback HTTP Git clone URL for --network local.'
        : 'The upstream must advertise a public HTTPS Git clone URL. Use Git/ngit for other transports.',
    });
  return selected;
}
export async function fetchCommit(
  directory: string,
  clones: string[],
  commit: string,
  local = false,
) {
  if (!commitPattern.test(commit)) throw new Error('Proposal needs an exact Git commit.');
  const failures: Error[] = [];
  for (const input of selectCloneUrls(clones, local)) {
    try {
      const url = cloneUrl(input, local);
      await sourceGit(directory, [
        '-c',
        'protocol.file.allow=never',
        '-c',
        'protocol.ext.allow=never',
        'fetch',
        '--no-tags',
        url,
        commit,
      ]);
      if ((await sourceGit(directory, ['rev-parse', 'FETCH_HEAD'])) !== commit)
        throw new Error('Git tip mismatch.');
      await sourceGit(directory, ['cat-file', '-e', `${commit}^{commit}`]);
      return url;
    } catch (cause) {
      failures.push(
        cause instanceof DiagnosticError
          ? new DiagnosticError(cause.code, cause.message, { ...cause.context, target: input })
          : new DiagnosticError('GIT_SOURCE', 'Clone source failed.', { target: input, cause }),
      );
    }
  }
  throw new DiagnosticError(
    'GIT_UNAVAILABLE',
    'The exact proposed Git commit is unavailable from its clone servers.',
    {
      operation: 'fetch source commit',
      cause:
        failures.length === 1
          ? failures[0]
          : new AggregateError(failures, 'All clone sources failed.'),
      recovery:
        'Check the source servers and Git errors below. The author may need to push this exact commit.',
    },
  );
}
export async function cloneRevision(
  directory: string,
  repo: Repository,
  commit: string,
  local = false,
) {
  await sourceGit(directory, ['init']);
  const clone = await fetchCommit(directory, repo.clones, commit, local);
  if (repo.euc) await sourceGit(directory, ['merge-base', '--is-ancestor', repo.euc, commit]);
  await inspectHistory(directory, commit);
  await sourceGit(directory, ['checkout', '-b', 'pr/my-changes', commit]);
  await sourceGit(directory, ['remote', 'add', 'upstream', clone]);
  await sourceGit(directory, [
    'remote',
    'add',
    'nostr',
    `nostr://${repo.address.startsWith('30617:') ? (await import('nostr-tools')).nip19.naddrEncode({ kind: 30617, pubkey: repo.pubkey, identifier: repo.identifier, relays: repo.relays }) : ''}`,
  ]);
  return clone;
}
export async function mergeReviewed(
  directory: string,
  input: {
    head: string;
    target: string;
    revision: string;
    clones: string[];
    local?: boolean;
    author?: string;
  },
) {
  const author: Record<string, string> = input.author
    ? {
        GIT_AUTHOR_NAME: input.author,
        GIT_AUTHOR_EMAIL: `${input.author}@nostr`,
        GIT_COMMITTER_NAME: input.author,
        GIT_COMMITTER_EMAIL: `${input.author}@nostr`,
      }
    : {};
  const current = await committedSource(directory);
  if (current !== input.target)
    throw new Error('The target branch changed since review. Refresh and review the new target.');
  await fetchCommit(directory, input.clones, input.head, input.local);
  await inspectHistory(directory, input.head);
  // Preflight in the object database. A conflict never leaves the working tree half-merged.
  const mergedTree = await sourceGit(directory, [
    'merge-tree',
    '--write-tree',
    current,
    input.head,
  ]).catch((cause) => {
    const conflicts = cause instanceof DiagnosticError && cause.context.exitCode === 1;
    throw new DiagnosticError(
      conflicts ? 'GIT_MERGE_CONFLICT' : 'GIT_MERGE_CHECK',
      conflicts
        ? 'Merge conflicts need local resolution. Your working tree is unchanged.'
        : 'Merge preflight failed. Your working tree is unchanged.',
      {
        cause,
        recovery: conflicts
          ? `Review the files listed below. To resolve in ordinary Git, run git merge --no-ff ${input.head}, edit the conflicts, then git add and git commit. git merge --abort cancels that manual attempt. Inspect soyli review again before publishing.`
          : 'Check git --version and the Git error below. Merge preflight needs Git 2.38 or newer with merge-tree --write-tree; update Git if that option is unavailable, then retry.',
      },
    );
  });
  try {
    if (!commitPattern.test(mergedTree)) throw new Error('Git returned an invalid merged tree.');
    // Two valid branches can combine into a dangling or otherwise unsafe alias.
    // Inspect the actual merged tree before writing a reachable merge commit.
    // This preview object has no ref and is never part of published history.
    const preview = await sourceGit(
      directory,
      [
        '-c',
        'commit.gpgsign=false',
        'commit-tree',
        mergedTree,
        '-p',
        current,
        '-p',
        input.head,
        '-m',
        'soyLI source validation preview (unreferenced)',
      ],
      author,
    );
    await inspectHistory(directory, preview);
  } catch (cause) {
    throw new DiagnosticError(
      'GIT_MERGE_SOURCE',
      'The merged source did not pass publication checks. Your working tree is unchanged.',
      {
        operation: 'validate merged public source',
        cause,
        recovery:
          'Resolve the reported source problem on the proposal or target branch, then refresh the review and retry. A file alias may need its target restored or the alias removed. No merge commit was added to either branch; the validation preview is unreferenced.',
      },
    );
  }
  if ((await committedSource(directory)) !== current)
    throw new Error('The target changed during preparation.');
  await sourceGit(
    directory,
    [
      '-c',
      'core.fsmonitor=false',
      'merge',
      '--no-ff',
      '--no-edit',
      '-m',
      `Merge proposal ${input.revision}`,
      input.head,
    ],
    author,
  );
  return {
    state: 'merged_locally' as const,
    commit: await committedSource(directory),
    head: input.head,
    revision: input.revision,
    released: false,
    pushed: false,
  };
}
