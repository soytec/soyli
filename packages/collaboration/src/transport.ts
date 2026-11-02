import { DiagnosticError } from '#diagnostics';
import { readEvents, publishFirst } from '#client/nostr';
import { readRelays } from '#nostr/relay-policy';
import { sourceGit } from '#grasp/client';
import { verifiedEvent, type SignedEvent } from '#protocol';
import { selectCloneUrls, fetchCommit } from './git';
import { commitPattern, tag, values } from './protocol';
import type { ProposalProgress } from './progress';

/** GRASP-01 event first, immutable objects second, independent read-back last.
 * No signer or repository-publication helper belongs in this transport. */
export async function deliverProposal(input: {
  directory: string;
  event: SignedEvent;
  repository: string;
  clones: string[];
  relays: string[];
  local?: boolean;
  signal?: AbortSignal;
  checkpoint?: (phase: 'source' | 'proposal') => Promise<void>;
  onProgress?: ProposalProgress;
}) {
  const event = verifiedEvent(input.event),
    commit = tag(event, 'c');
  if (
    ![1618, 1619].includes(event.kind) ||
    !values(event, 'a').includes(input.repository) ||
    !commitPattern.test(commit ?? '')
  )
    throw new Error('Saved proposal does not identify its upstream and exact commit.');
  const advertised = values(event, 'clone');
  if (!advertised.length || !input.clones.length || !input.relays.length)
    throw new Error('Proposal requires upstream clone servers and relays.');
  await sourceGit(input.directory, ['cat-file', '-e', `${commit}^{commit}`]);
  const relays = readRelays(input.relays);
  const failures: Error[] = [];
  try {
    input.signal?.throwIfAborted();
    await input.onProgress?.('relay', 'Publishing the signed proposal to the upstream relays.');
    await publishFirst(relays, event, input.signal);
    let hosted = false;
    for (const url of selectCloneUrls(input.clones, input.local)) {
      input.signal?.throwIfAborted();
      try {
        await input.onProgress?.(
          'source',
          `Sharing the exact source revision with ${new URL(url).host}.`,
        );
        await sourceGit(input.directory, [
          'push',
          '--no-verify',
          url,
          `${commit}:refs/nostr/${event.id}`,
        ]);
        const refs = await sourceGit(input.directory, ['ls-remote', url, `refs/nostr/${event.id}`]);
        if (refs !== `${commit}\trefs/nostr/${event.id}`)
          throw new Error('Upstream does not advertise the exact immutable proposal ref.');
        hosted = true;
        break;
      } catch (cause) {
        failures.push(
          cause instanceof DiagnosticError
            ? new DiagnosticError(cause.code, cause.message, { ...cause.context, target: url })
            : new DiagnosticError('GIT_PROPOSAL_PUSH', 'Proposal ref hosting failed.', {
                target: url,
                cause,
              }),
        );
      }
    }
    if (!hosted)
      throw new DiagnosticError(
        'PROPOSAL_HOSTING',
        'No upstream clone server hosted the proposal ref.',
        {
          operation: 'host proposal commit',
          target: input.repository,
          cause:
            failures.length === 1
              ? failures[0]
              : new AggregateError(failures, 'All upstream proposal hosts failed.'),
          recovery:
            'Check the upstream Git errors and hosting support, then run soyli propose --resume. No contributor repository will be created.',
        },
      );
    await input.checkpoint?.('source');
    await input.onProgress?.(
      'verify',
      'Fetching the shared source and proposal back to confirm both are available.',
    );
    // Legacy events may advertise contributor clones. Keep their signature and
    // require those original locations to remain fetchable; never create a fork.
    await fetchCommit(input.directory, advertised, commit!, input.local);
    const filters = [{ ids: [event.id], limit: 1 }];
    const visible = await readEvents(relays, filters, input.signal);
    if (!visible.some((e) => e.id === event.id))
      throw new Error('Upstream relay acknowledged the proposal but has not made it queryable.');
    await input.checkpoint?.('proposal');
  } catch (cause) {
    if (cause instanceof DiagnosticError && cause.code === 'PROPOSAL_HOSTING') throw cause;
    throw new DiagnosticError('PROPOSAL_UNCONFIRMED', 'Proposal delivery is not confirmed.', {
      operation: 'publish proposal',
      target: input.repository,
      cause,
      recovery:
        'Resolve the relay or advertised Git clone error, then run soyli propose --resume to resend the saved event. Legacy signed clone locations must remain available; no repository is created or signed event rewritten.',
    });
  }
}

/** Publish one reviewed branch with a saved signed state. Other refs and HEAD
 * stay as declared in that state; this does not announce a repository. */
export async function publishBranch(input: {
  directory: string;
  state: SignedEvent;
  repository: string;
  ref: string;
  previous: string;
  clones: string[];
  relays: string[];
  local?: boolean;
  signal?: AbortSignal;
}) {
  const state = verifiedEvent(input.state),
    commit = tag(state, input.ref);
  if (
    state.kind !== 30618 ||
    !commitPattern.test(commit ?? '') ||
    !input.ref.startsWith('refs/heads/')
  )
    throw new Error('Saved branch publication is invalid.');
  const relays = readRelays(input.relays);
  const failures: Error[] = [];
  try {
    await sourceGit(input.directory, ['cat-file', '-e', `${commit}^{commit}`]);
    for (const url of selectCloneUrls(input.clones, input.local)) {
      input.signal?.throwIfAborted();
      try {
        const remote = await sourceGit(input.directory, ['ls-remote', url, input.ref]);
        const head = remote.split('\t')[0];
        if (head !== input.previous && head !== commit)
          throw new Error('Upstream branch changed since publication was prepared.');
        await publishFirst(relays, state, input.signal);
        await sourceGit(input.directory, [
          'push',
          '--no-verify',
          `--force-with-lease=${input.ref}:${head}`,
          url,
          `${commit}:${input.ref}`,
        ]);
        if (
          (await sourceGit(input.directory, ['ls-remote', url, input.ref])) !==
          `${commit}\t${input.ref}`
        )
          throw new Error('Upstream does not advertise the merged commit.');
        const filters = [{ ids: [state.id], limit: 1 }];
        const visible = await readEvents(relays, filters, input.signal);
        if (!visible.some((e) => e.id === state.id))
          throw new Error('Signed repository state is not queryable after the push.');
        return;
      } catch (cause) {
        failures.push(
          cause instanceof DiagnosticError
            ? new DiagnosticError(cause.code, cause.message, { ...cause.context, target: url })
            : new DiagnosticError('GIT_BRANCH_PUSH', 'Merged branch publication failed.', {
                target: url,
                cause,
              }),
        );
      }
    }
    throw failures.length === 1
      ? failures[0]
      : new AggregateError(failures, 'No upstream server confirmed the merged branch.');
  } catch (cause) {
    throw new DiagnosticError(
      'GIT_PUBLICATION_UNCONFIRMED',
      'Merged Git publication is not confirmed.',
      {
        operation: 'publish merged branch',
        target: input.repository,
        cause,
        recovery:
          'Resolve the upstream Git or relay error, then rerun soyli push from the same saved commit. The local merge and publication journal are retained.',
      },
    );
  }
}
