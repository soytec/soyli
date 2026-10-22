import { nip19 } from 'nostr-tools';
import ipaddr from 'ipaddr.js';
import { DiagnosticError } from '../../diagnostics/src';
import { sourceGit } from '../../grasp/src/client';
import { cloneUrl } from '../../collaboration/src/git';
import { resolveRepositoryRef, values } from '../../collaboration/src/protocol';
import type { SignedEvent } from '../../protocol/src';
import { newer } from './relay';

/** A project's own NIP-34 repository. The napplet publisher reads it without
 * signing or pushing; explicit collaboration `soyli push` is a separate action. */
export class RepositoryError extends DiagnosticError {
  constructor(
    code: string,
    message: string,
    context: ConstructorParameters<typeof DiagnosticError>[2] = {},
    readonly stage = 'check',
    readonly retryable = false,
  ) {
    super(code, message, context);
  }
}
export type SelectedRepository = {
  address: string;
  pubkey: string;
  identifier: string;
  relays: string[];
  /** Where the choice came from: publish.repository or a named Git remote. */
  origin: string;
};
export type LinkedRepository = SelectedRepository & {
  clones: string[];
  /** The release's portable `source` value. */
  source: string;
};
type Latest = (
  url: string,
  pubkey: string,
  identifier: string,
  kind: number,
) => Promise<SignedEvent | null>;
type LsRemote = (directory: string, clone: string, refs: string[]) => Promise<string>;
const commitPattern = /^[a-f0-9]{40}$/;
const pushRecovery = (commit: string) =>
  `Push commit ${commit} to your repository (for example git push <remote>), then rerun soyli publish. The publish command does not write to your repository.`;

export function relayUrl(value: string, local = false) {
  const u = new URL(/^wss?:\/\//i.test(value) ? value : `wss://${value}`),
    host = u.hostname.replace(/^\[|\]$/g, '');
  if (
    u.username ||
    u.password ||
    u.hash ||
    u.search ||
    (local
      ? u.protocol !== 'ws:' || !['127.0.0.1', '::1'].includes(host)
      : u.protocol !== 'wss:' ||
        host === 'localhost' ||
        host.endsWith('.local') ||
        host.endsWith('.localhost') ||
        (ipaddr.isValid(host) && ipaddr.process(host).range() !== 'unicast'))
  )
    throw new Error('Use a public WSS relay, or loopback WS in the local network.');
  return u.href;
}
const usable = <T>(items: string[], check: (value: string) => T) =>
  items.flatMap((item) => {
    try {
      return [check(item)];
    } catch {
      return [];
    }
  });

/** Repository-local remotes only: sourceGit ignores global and system Git configuration. */
export async function gitNostrRemotes(directory: string) {
  const text = await sourceGit(directory, ['config', '--get-regexp', '^remote\\..*\\.url$']).catch(
    (error) => {
      // git config exits 1 when no key matches.
      if (error instanceof DiagnosticError && error.context.exitCode === 1) return '';
      throw error;
    },
  );
  return text
    .split('\n')
    .map((line) => /^remote\.(.+)\.url (nostr:\/\/\S+)$/.exec(line.trim()))
    .filter((match): match is RegExpExecArray => !!match)
    .map(([, name, url]) => ({ name, url }));
}

export async function selectRepository(input: {
  directory: string;
  pubkey: string;
  configured?: string;
  fetch?: typeof fetch;
  signal?: AbortSignal;
}): Promise<SelectedRepository | null> {
  const resolve = (reference: string) =>
    resolveRepositoryRef(reference, { fetch: input.fetch, signal: input.signal });
  if (input.configured) {
    const ref = await resolve(input.configured).catch((cause) => {
      throw new RepositoryError(
        'REPOSITORY_REFERENCE',
        'publish.repository is not a usable NIP-34 repository reference.',
        {
          operation: 'select source repository',
          cause,
          recovery:
            'Set publish.repository to an naddr1… repository address, a nostr:// clone URL or 30617:<pubkey>:<identifier>.',
        },
      );
    });
    if (ref.pubkey !== input.pubkey)
      throw new RepositoryError(
        'REPOSITORY_OWNER',
        'publish.repository belongs to a different key than the publishing account.',
        {
          operation: 'select source repository',
          target: ref.address,
          recovery:
            'Publish with the repository owner’s account, or remove publish.repository to let soyLI host the release source.',
        },
      );
    return { ...ref, origin: 'publish.repository' };
  }
  const remotes = await gitNostrRemotes(input.directory);
  const failures: Error[] = [];
  const owned = new Map<string, SelectedRepository>();
  for (const remote of remotes) {
    try {
      const ref = await resolve(remote.url);
      if (ref.pubkey !== input.pubkey) continue; // Someone else's repository, such as a remix upstream.
      const known = owned.get(ref.address);
      owned.set(
        ref.address,
        known
          ? { ...known, relays: [...new Set([...known.relays, ...ref.relays])] }
          : { ...ref, origin: `remote ${remote.name}` },
      );
    } catch (cause) {
      failures.push(
        new DiagnosticError('REPOSITORY_REMOTE', `Git remote ${remote.name} could not be read.`, {
          target: remote.url,
          cause,
        }),
      );
    }
  }
  // Skipping an unreadable remote could publish a duplicate repository, the case this avoids.
  if (failures.length)
    throw new RepositoryError(
      'REPOSITORY_REMOTE',
      'A nostr:// Git remote could not be resolved to a NIP-34 repository.',
      {
        operation: 'select source repository',
        cause: failures.length === 1 ? failures[0] : new AggregateError(failures),
        recovery:
          'Fix or remove the remote, or set publish.repository in napplet.json to the repository address you publish from.',
      },
    );
  if (owned.size > 1)
    throw new RepositoryError(
      'REPOSITORY_AMBIGUOUS',
      'Several Git remotes are NIP-34 repositories owned by this account.',
      {
        operation: 'select source repository',
        detail: [...owned.values()].map((r) => `${r.origin}: ${r.address}`).join('\n'),
        recovery:
          'Set publish.repository in napplet.json to the repository that releases should reference.',
      },
    );
  return owned.values().next().value ?? null;
}

/** Read the newest signed announcement and state from the repository's own relays. */
export async function loadRepository(
  latest: Latest,
  selected: SelectedRepository,
  local = false,
  discoveryRelays: string[] = [],
) {
  const failures: Error[] = [];
  const newest = async (relays: string[], kind: number): Promise<SignedEvent | null> => {
    let best: SignedEvent | null = null;
    await Promise.all(
      relays.map(async (relay) => {
        try {
          const event = await latest(relay, selected.pubkey, selected.identifier, kind);
          if (event && (!best || newer(event, best))) best = event;
        } catch (cause) {
          failures.push(
            new DiagnosticError('RELAY_READ', `Repository relay query failed.`, {
              target: relay,
              cause,
            }),
          );
        }
      }),
    );
    return best;
  };
  // NIP-19 hints are optional. A bare address is discovered on this publication's
  // configured relays; an explicit hint never silently selects another service.
  const hints = [
    ...new Set(
      usable(selected.relays.length ? selected.relays : discoveryRelays, (r) => relayUrl(r, local)),
    ),
  ].slice(0, 8);
  const unavailable = (message: string, recovery: string) =>
    new RepositoryError(
      'REPOSITORY_UNAVAILABLE',
      message,
      {
        operation: 'read source repository',
        target: selected.address,
        detail: `Relays: ${hints.join(', ') || 'none'}`,
        ...(failures.length
          ? { cause: failures.length === 1 ? failures[0] : new AggregateError(failures) }
          : {}),
        recovery,
      },
      'check',
      true,
    );
  if (!hints.length)
    throw unavailable(
      'The repository reference has no usable relay hint.',
      'Use a nostr:// URL or naddr1… address that includes the repository relay.',
    );
  const found = await newest(hints, 30617);
  if (!found)
    throw unavailable(
      'The repository announcement was not found on its relays.',
      'Check that the repository is announced on the relay in its reference, then retry.',
    );
  const relays = [
    ...new Set([...usable(values(found, 'relays'), (r) => relayUrl(r, local)), ...hints]),
  ].slice(0, 8);
  const announcement = (await newest(relays, 30617)) ?? found;
  const state = await newest(relays, 30618);
  const clones = [
    ...new Set(usable(values(announcement, 'clone'), (c) => cloneUrl(c, local))),
  ].slice(0, 8);
  if (!clones.length)
    throw new RepositoryError('REPOSITORY_CLONE', 'The repository announces no usable clone URL.', {
      operation: 'read source repository',
      target: selected.address,
      recovery: local
        ? 'Announce a loopback HTTP clone URL for the local network.'
        : 'Announce a public HTTPS clone URL in the repository announcement.',
    });
  const repository: LinkedRepository = {
    ...selected,
    relays,
    clones,
    source: `nostr://${nip19.npubEncode(selected.pubkey)}/${encodeURIComponent(relays[0])}/${encodeURIComponent(selected.identifier)}`,
  };
  return { repository, announcement, state };
}

const defaultLsRemote: LsRemote = (directory, clone, refs) =>
  sourceGit(directory, ['ls-remote', clone, ...refs]);

/** The release commit must already be in a signed ref that a clone URL serves. */
export async function verifyReleaseReachable(input: {
  directory: string;
  repository: LinkedRepository;
  state: SignedEvent | null;
  commit: string;
  lsRemote?: LsRemote;
}) {
  const { commit, directory } = input;
  const refs = (input.state?.tags ?? []).filter(
    (t) => t[0].startsWith('refs/') && t.length === 2 && commitPattern.test(t[1]),
  );
  const checked: string[] = [];
  const containing: [string, string][] = [];
  for (const [ref, tip] of refs.slice(0, 256)) {
    if (tip === commit) {
      containing.push([ref, tip]);
      continue;
    }
    const local = await sourceGit(directory, ['cat-file', '-e', `${tip}^{commit}`]).then(
      () => true,
      () => false,
    );
    if (!local) {
      checked.push(`${ref} ${tip} (not in this local repository; fetch it to compare)`);
      continue;
    }
    const contains = await sourceGit(directory, ['merge-base', '--is-ancestor', commit, tip]).then(
      () => true,
      () => false,
    );
    if (contains) containing.push([ref, tip]);
    else checked.push(`${ref} ${tip}`);
  }
  if (!containing.length)
    throw new RepositoryError(
      'SOURCE_NOT_PUSHED',
      'The release commit is not in any branch or tag of your repository’s signed state.',
      {
        operation: 'verify source repository',
        target: input.repository.address,
        detail: [
          `Release commit: ${commit}`,
          input.state ? `Signed refs checked:\n${checked.join('\n')}` : 'No signed state found.',
        ].join('\n'),
        recovery: pushRecovery(commit),
      },
    );
  const failures: string[] = [],
    errors: Error[] = [];
  for (const clone of input.repository.clones.slice(0, 4)) {
    let served: Map<string, string>;
    try {
      served = new Map(
        (
          await (input.lsRemote ?? defaultLsRemote)(
            directory,
            clone,
            containing.map(([ref]) => ref),
          )
        )
          .split('\n')
          .filter(Boolean)
          .map((line) => line.split(/\s+/).reverse() as [string, string]),
      );
    } catch (error) {
      failures.push(`${clone}: could not be read`);
      errors.push(error instanceof Error ? error : new Error('Git failed'));
      continue;
    }
    const match = containing.find(([ref, tip]) => served.get(ref) === tip);
    if (match) return { ref: match[0], tip: match[1], clone };
    failures.push(`${clone}: does not serve ${containing.map(([r, t]) => `${r} ${t}`).join(', ')}`);
  }
  throw new RepositoryError(
    'SOURCE_NOT_PUSHED',
    'No clone URL of your repository serves the signed ref that contains the release commit.',
    {
      operation: 'verify source repository',
      target: input.repository.address,
      detail: [`Release commit: ${commit}`, ...failures].join('\n'),
      ...(errors.length
        ? { cause: errors.length === 1 ? errors[0] : new AggregateError(errors) }
        : {}),
      recovery: pushRecovery(commit),
    },
    'check',
    true,
  );
}
