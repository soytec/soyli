import { ProtocolClient } from '../../client/src/nostr';
import { DiagnosticError } from '../../diagnostics/src';
import { sourceGit } from '../../grasp/src/client';
import type { CreatorSigner } from '../../identity/src/signer';
import { verifiedEvent, type SignedEvent } from '../../protocol/src';
import { readProposals, tag, type Repository, type Proposal } from './protocol';

async function signExact(
  signer: CreatorSigner,
  pubkey: string,
  template: import('nostr-tools').EventTemplate,
) {
  const expected = JSON.stringify(template);
  const event = verifiedEvent(await signer.signEvent(template));
  if (
    event.pubkey !== pubkey ||
    JSON.stringify({
      kind: event.kind,
      created_at: event.created_at,
      content: event.content,
      tags: event.tags,
    }) !== expected
  )
    throw new Error('Signer changed the requested collaboration event.');
  return event;
}
export async function prepareAppliedStatuses(input: {
  directory: string;
  client: ProtocolClient;
  repository: Repository;
  previous: SignedEvent;
  branch: string;
  commit: string;
  signer: CreatorSigner;
  pubkey: string;
}) {
  const { directory, client, repository, previous, branch, commit, signer, pubkey } = input;
  const options = { directory };
  const account = { pubkey };
  const now = Math.max(Math.floor(Date.now() / 1000), previous.created_at + 1);
  const proposals = await readProposals(client, repository);
  const included: Proposal[] = [];
  for (const proposal of proposals.filter(
    (p) => ['open', 'draft'].includes(p.status) && p.head && !p.patch,
  )) {
    // A missing object means it is not included. Other Git failures retain
    // their causes rather than being misclassified as unrelated proposals.
    try {
      await sourceGit(options.directory, ['cat-file', '-e', `${proposal.head}^{commit}`]);
    } catch (cause) {
      if (cause instanceof DiagnosticError && cause.context.exitCode === 128) continue;
      throw cause;
    }
    try {
      await sourceGit(options.directory, ['merge-base', '--is-ancestor', proposal.head!, commit]);
    } catch (cause) {
      if (cause instanceof DiagnosticError && cause.context.exitCode === 1) continue;
      throw cause;
    }
    const declared = tag(proposal.revision, 'target-branch') ?? tag(proposal.root, 'target-branch');
    const defaultBranch = tag(previous, 'HEAD')?.replace(/^ref: refs\/heads\//, '');
    if ((declared ?? defaultBranch) !== branch) continue;
    included.push(proposal);
  }
  const statuses: SignedEvent[] = [];
  for (const proposal of included)
    statuses.push(
      await signExact(signer, account.pubkey, {
        kind: 1631,
        created_at: Math.max(
          now,
          (proposal.statusEvent?.created_at ?? proposal.revision.created_at) + 1,
        ),
        content: 'Merged and published in Git.',
        tags: [
          ['e', proposal.root.id, '', 'root'],
          ['e', proposal.revision.id, '', 'reply'],
          ['a', repository.address],
          ['p', proposal.root.pubkey],
          ['p', repository.pubkey],
          ['merge-commit', commit],
          ['r', commit],
        ],
      }),
    );
  return statuses;
}

export async function deliverAppliedStatuses(input: {
  repository: Repository;
  commit: string;
  pubkey: string;
  statuses: SignedEvent[];
  signal?: AbortSignal;
  recovery: string;
}) {
  const { repository, commit, pubkey } = input;
  const account = { pubkey };
  const options = { signal: input.signal };
  const saved = { relays: repository.relays, statuses: input.statuses };
  const inbox = new ProtocolClient(() => saved.relays);
  const supersededProposals: string[] = [];
  try {
    for (const input of saved.statuses) {
      const event = verifiedEvent(input);
      if (
        event.pubkey !== account.pubkey ||
        event.kind !== 1631 ||
        tag(event, 'a') !== repository.address ||
        tag(event, 'merge-commit') !== commit
      )
        throw new Error('Saved applied status mismatch.');
      const root = event.tags.find((t) => t[0] === 'e' && t[3] === 'root')?.[1];
      const reviewed = event.tags.find((t) => t[0] === 'e' && t[3] === 'reply')?.[1];
      if (!root || !reviewed) throw new Error('Saved applied status has no reviewed revision.');
      // Git may already have been published on a previous attempt. A newer
      // contribution must not be closed by that attempt's saved acceptance.
      const proposal = (await readProposals(inbox, repository, root)).find(
        (p) => p.root.id === root,
      );
      if (!proposal) throw new Error('Proposal unavailable while checking its applied revision.');
      if (proposal.revision.id !== reviewed) {
        supersededProposals.push(root);
        continue;
      }
      await inbox.publish(event, [], options.signal);
      if (
        !(await inbox.query([{ ids: [event.id], limit: 1 }], [], options.signal)).some(
          (e) => e.id === event.id,
        )
      )
        throw new Error('Applied status was acknowledged but is not queryable.');
    }
  } catch (cause) {
    throw new DiagnosticError(
      'PROPOSAL_STATUS_UNCONFIRMED',
      'Git was published but proposal status is not confirmed.',
      {
        operation: 'confirm applied proposal status',
        target: repository.address,
        cause,
        recovery: input.recovery,
      },
    );
  } finally {
    inbox.close();
  }
  return supersededProposals;
}
