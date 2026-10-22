import { ASSET_LOCK, parseAssets } from '../../assets/src';
import { DiagnosticError } from '../../diagnostics/src';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { nip19, type EventTemplate } from 'nostr-tools';
import { join } from 'node:path';
import { ProtocolClient } from '../../client/src/nostr';
import { Accounts, captureAccount } from '../../identity/src/accounts';
import type { Network } from '../../identity/src/signer';
import { sha256, verifiedEvent, type SignedEvent } from '../../protocol/src';
import { defaultTargets, projectSchema, resolveTargets } from '../../publish/src/config';
import { readBinding, effectiveProject } from '../../publish/src/binding';
import { committedSource } from '../../publish/src/git-source';
import { durableFile, freezeSource, inspectProject } from '../../publish/src/project';
import { executableBytes } from '../../publish/src/artifact';
import { uploadBlob } from '../../blossom/src/client';
import { sourceGit, sourceUrls } from '../../grasp/src/client';
import type { PublishOptions } from '../../publish/src';
import { Journal } from '../../publish/src/journal';
import {
  latest,
  proposalId,
  readProposals,
  readRepository,
  readRepositoryState,
  repositoryRef,
  tag,
  type Proposal,
  type Repository,
} from './protocol';
import { mergeReviewed, selectCloneUrls } from './git';
import { deliverProposal, publishBranch } from './transport';
import type { ProposalProgress } from './progress';

export type CollaborationOptions = {
  directory: string;
  network: Network;
  accounts?: Pick<Accounts, 'current' | 'signer'>;
  onAuth?: (url: string) => Promise<void>;
  signal?: AbortSignal;
};
export async function collaborationContext(options: CollaborationOptions) {
  const binding = await readBinding(options.directory);
  const project = await effectiveProject(
    options.directory,
    projectSchema.parse(await Bun.file(join(options.directory, 'napplet.json')).json()),
  );
  const targets = resolveTargets(project, options.network);
  const account = await (options.accounts ?? new Accounts(options.network)).current();
  const client = new ProtocolClient(() => [
    ...(binding?.upstream?.relays ?? []),
    targets.relay,
    sourceUrls(
      targets.grasp,
      account?.pubkey ?? '0'.repeat(64),
      'project',
      options.network === 'local',
    ).relay,
    ...targets.mirrors,
  ]);
  return { binding, project, targets, account, client };
}
/** The creator's own NIP-34 repository, configured or found among the Git remotes. */
async function linkedRepository(
  options: CollaborationOptions,
  context: Awaited<ReturnType<typeof collaborationContext>>,
) {
  if (!context.account) return null;
  const { selectRepository } = await import('../../publish/src/repository');
  const { projectRepositoryReference } = await import('../../publish/src/config');
  return selectRepository({
    directory: options.directory,
    pubkey: context.account.pubkey,
    configured: projectRepositoryReference(context.project, options.network),
    signal: options.signal,
  });
}
export async function projectRepository(options: CollaborationOptions, client: ProtocolClient) {
  const binding = await readBinding(options.directory);
  if (binding?.upstream) return readRepository(client, binding.upstream.address);
  const context = await collaborationContext(options);
  context.client.close();
  if (!context.account) throw new Error('Select the project creator or open a repository address.');
  const linked = await linkedRepository(options, context);
  if (linked)
    return readRepository(
      client,
      nip19.naddrEncode({
        kind: 30617,
        pubkey: linked.pubkey,
        identifier: linked.identifier,
        relays: linked.relays,
      }),
    );
  const { projectIdentity } = await import('../../publish/src/config');
  return readRepository(
    client,
    sourceUrls(
      context.targets.grasp,
      context.account.pubkey,
      projectIdentity(context.project),
      options.network === 'local',
    ).portable,
  );
}
async function atomic(path: string, value: unknown) {
  await mkdir(join(path, '..'), { recursive: true, mode: 0o700 });
  const temp = `${path}.${crypto.randomUUID()}.tmp`;
  await writeFile(temp, JSON.stringify(value, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
  await rename(temp, path);
}
async function signExact(
  signer: Awaited<ReturnType<Accounts['signer']>>,
  pubkey: string,
  template: EventTemplate,
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
export async function propose(
  options: CollaborationOptions & {
    description: string;
    resume?: boolean;
    check: PublishOptions['check'];
    checkpoint?: (phase: 'source' | 'proposal') => Promise<void>;
    onProgress?: ProposalProgress;
    /** Optional browser review boundary. CLI callers retain their ordinary workflow. */
    expectedReview?: { commit: string; fingerprint: string; repository: string };
  },
) {
  if (!options.resume && (!options.description.trim() || options.description.length > 8000))
    throw new Error('Provide a proposal description of 1–8000 characters.');
  const accounts = await captureAccount(options.accounts ?? new Accounts(options.network));
  await options.onProgress?.('check', 'Checking the reviewed revision and upstream repository.');
  const context = await collaborationContext({ ...options, accounts }),
    { client, targets, account, project, binding } = context;
  let signer: Awaited<ReturnType<Accounts['signer']>> | undefined;
  let hasSignedJournal = false;
  try {
    if (!account) throw new Error('Create or connect a creator identity first.');
    if (!binding?.upstream)
      throw new Error(
        'This project has no Git upstream. Remix a napplet with published Git history first.',
      );
    const repository = await readRepository(client, binding.upstream.address);
    const branch = await sourceGit(options.directory, ['symbolic-ref', '--short', 'HEAD']);
    const key = (
      await sha256(`${repository.address}:${branch}:${account.pubkey}:${binding.project.previewId}`)
    ).slice(0, 16);
    const path = join(options.directory, '.napplet-space', 'proposals', `${key}.json`);
    return await new Journal(options.directory, options.network).lock(async () => {
      if (options.expectedReview) {
        const expected = options.expectedReview;
        if (
          repository.address !== expected.repository ||
          (await committedSource(options.directory)) !== expected.commit ||
          (await inspectProject(options.directory, options.network, account.pubkey)).fingerprint !==
            expected.fingerprint
        )
          throw new DiagnosticError('REVIEW_CHANGED', 'The proposal changed after review.', {
            recovery: 'Prepare and review the proposal again before submitting.',
          });
      }
      let saved: any;
      try {
        saved = JSON.parse(await readFile(path, 'utf8'));
        hasSignedJournal = true;
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
      }
      if (options.resume && !saved)
        throw new DiagnosticError(
          'PROPOSAL_NOT_SAVED',
          'No saved signed proposal exists on this branch.',
          {
            operation: 'resume proposal',
            recovery:
              'Preparation did not save a signed proposal. Resolve the earlier error, then rerun soyli propose with its description, without --resume.',
          },
        );
      if (saved && ![1, 2].includes(saved.version))
        throw new Error(
          'Unsupported saved proposal version. Keep the journal and use a compatible soyLI.',
        );
      if (saved) {
        const root = verifiedEvent(saved.root),
          event = verifiedEvent(saved.event);
        if (
          root.kind !== 1618 ||
          !root.tags.some((t) => t[0] === 'a' && t[1] === repository.address) ||
          !(
            (event.kind === 1618 && event.id === root.id) ||
            (event.kind === 1619 && tag(event, 'E') === root.id && tag(event, 'P') === root.pubkey)
          ) ||
          root.pubkey !== account.pubkey ||
          event.pubkey !== account.pubkey ||
          saved.repository !== repository.address ||
          tag(event, 'c') !== saved.commit ||
          (saved.version === 2 &&
            (saved.network !== options.network ||
              JSON.stringify(saved.clones) !==
                JSON.stringify(
                  event.tags.filter((t) => t[0] === 'clone').flatMap((t) => t.slice(1)),
                )))
        )
          throw new Error('Saved proposal identity, network or source mismatch. Keep the journal.');
      }
      const previousJournal = saved;
      if (
        saved &&
        options.resume &&
        options.expectedReview &&
        (saved.commit !== options.expectedReview.commit ||
          saved.event.content !== options.description)
      )
        throw new DiagnosticError('REVIEW_CHANGED', 'The saved proposal differs from this review.');
      if (!options.resume) {
        const commit = await committedSource(options.directory);
        let adopted = false;
        if (!saved) {
          const matches = (await readProposals(client, repository)).filter((p) => {
            const name = tag(p.root, 'branch-name')?.replace(/^pr\//, '');
            return (
              ['open', 'draft'].includes(p.status) &&
              p.root.pubkey === account.pubkey &&
              p.head &&
              !p.patch &&
              name &&
              [name, `pr/${name}`, `pr/${name}(${p.root.id.slice(0, 8)})`].includes(branch)
            );
          });
          if (matches.length > 1)
            throw new Error(
              'Multiple proposals match this branch. Check out the intended PR with ngit before proposing.',
            );
          if (matches.length === 1) {
            const existing = matches[0];
            if (!['open', 'draft'].includes(existing.status))
              throw new Error('Reopen this proposal before updating it.');
            await sourceGit(options.directory, [
              'merge-base',
              '--is-ancestor',
              existing.head!,
              commit,
            ]);
            saved = {
              root: existing.root,
              event: existing.revision,
              commit: existing.head,
              done: true,
            };
            adopted = true;
          }
        }
        if (saved && !saved.done && saved.commit !== commit)
          throw new Error(
            'Finish the saved proposal with soyli propose --resume before proposing new edits.',
          );
        if (!saved || saved.commit !== commit || adopted) {
          if (saved?.root) {
            const current = (await readProposals(client, repository, saved.root.id)).find(
              (p) => p.root.id === saved.root.id,
            );
            if (!current)
              throw new Error(
                'The proposal changed remotely. Review its latest revision before updating.',
              );
            if (current.revision.id !== saved.event.id) {
              // Continue after an author update made through ngit only when the
              // local history already contains that exact published revision.
              await sourceGit(options.directory, [
                'merge-base',
                '--is-ancestor',
                current.head!,
                commit,
              ]).catch((cause) => {
                throw new DiagnosticError(
                  'PROPOSAL_CHANGED',
                  'The proposal changed remotely. Fetch and review its latest revision before updating.',
                  { cause },
                );
              });
              saved = { ...saved, event: current.revision, commit: current.head };
            }
            if (!['open', 'draft'].includes(current.status))
              throw new Error('Reopen this proposal before updating it.');
          }
          const base = await sourceGit(options.directory, [
            'merge-base',
            binding.upstream!.commit,
            commit,
          ]);
          if (base === commit) throw new Error('There are no changes to propose.');
          const clones = selectCloneUrls(repository.clones, options.network === 'local');
          if (!repository.relays.length)
            throw new Error('The upstream needs relays for forkless proposals.');
          const inspected = await inspectProject(
            options.directory,
            options.network,
            account.pubkey,
          );
          await options.onProgress?.(
            'check',
            'Checking the exact playable build before sharing it.',
          );
          const checked = await options.check(inspected.contents);
          if (
            (await committedSource(options.directory)) !== commit ||
            (await inspectProject(options.directory, options.network, account.pubkey))
              .fingerprint !== inspected.fingerprint
          )
            throw new Error('Source or build changed during preview checking.');
          const folder = join(options.directory, '.napplet-space', 'proposals', key, commit);
          await freezeSource(folder, inspected.contents, Math.floor(Date.now() / 1000), {
            directory: options.directory,
            commit,
          });
          const bytes = executableBytes(inspected.contents);
          signer = await accounts.signer({
            signal: options.signal,
            onAuth: options.onAuth,
            kinds: [5129, 24242, 1618, 1619],
          });
          if ((await signer.getPublicKey()) !== account.pubkey)
            throw new Error('Signer identity changed.');
          const put = async (bytes: Uint8Array, type: string) => {
            await options.onProgress?.(
              'upload',
              `Uploading and verifying ${type} (${Math.ceil(bytes.length / 1024)} KiB). Approve upload requests in your signer.`,
            );
            await uploadBlob({
              origin: targets.blossom,
              bytes,
              type,
              signer: signer!,
              local: options.network === 'local',
              signal: options.signal,
            });
            return `${targets.blossom}/${await sha256(bytes)}`;
          };
          for (const asset of parseAssets(inspected.contents.get(ASSET_LOCK)).assets.filter(
            (a) => a.storage === 'external',
          ))
            await put(inspected.contents.get(asset.path)!, asset.mime);
          await put(bytes, 'text/html');
          if (inspected.plan.icon)
            await put(inspected.contents.get(inspected.plan.icon.file)!, inspected.plan.icon.mime);
          if (checked.preview) await durableFile(join(folder, 'preview.png'), checked.preview);
          const image = checked.preview ? await put(checked.preview, 'image/png') : undefined;
          const now = Math.max(Math.floor(Date.now() / 1000), (saved?.event.created_at ?? 0) + 1);
          await options.onProgress?.(
            'upload',
            'Signing the playable preview with your selected account.',
          );
          const manifest = await signExact(signer!, account.pubkey, {
            kind: 5129,
            created_at: now,
            content: inspected.plan.description,
            tags: [
              ['title', project.title ?? project.name],
              ['x', inspected.plan.artifactHash],
              ['server', targets.blossom],
              ['source-commit', commit],
              ...inspected.plan.requires.map((r) => ['R', r]),
              ...(inspected.plan.optionalDomains ?? []).map((r) => ['O', r]),
              ...(inspected.plan.archetypes ?? []).map((a) => ['z', a]),
              ...(inspected.plan.intents ?? []).map((i) => ['i', i.intent, ...i.parameters]),
              ...(inspected.plan.icon
                ? [['icon', inspected.plan.icon.hash, inspected.plan.icon.mime]]
                : []),
              ...(project.remix?.parent ? [['a', project.remix.parent]] : []),
              ...(project.remix?.origin ? [['A', project.remix.origin]] : []),
              ...(image ? [['image', image]] : []),
            ],
          });
          const descriptor = new TextEncoder().encode(
            JSON.stringify({
              version: 1,
              commit,
              manifest,
              check: { profile: checked.profile, browser: checked.browser },
              ...(image ? { image } : {}),
            }),
          );
          await durableFile(join(folder, 'preview.json'), descriptor);
          const url = await put(descriptor, 'application/json');
          await options.onProgress?.(
            'sign',
            'Approve the proposal signature in your selected signer.',
          );
          const event = verifiedEvent(
            await signExact(signer!, account.pubkey, {
              kind: saved ? 1619 : 1618,
              created_at: now,
              content: options.description,
              tags: [
                ['a', repository.address],
                ...(repository.euc ? [['r', repository.euc]] : []),
                ...repository.maintainers.map((p) => ['p', p]),
                ...(saved
                  ? [
                      ['E', saved.root.id],
                      ['P', account.pubkey],
                    ]
                  : [
                      ['subject', options.description.split('\n')[0].slice(0, 160)],
                      ['branch-name', branch.replace(/^pr\//, '')],
                    ]),
                ['c', commit],
                ['clone', ...clones],
                ['merge-base', base],
                ['soy-preview', url, await sha256(descriptor), commit],
              ],
            }),
          );
          saved = {
            version: 2,
            network: options.network,
            root: saved?.root ?? event,
            event,
            commit,
            base,
            folder,
            clones,
            targets,
            repository: repository.address,
            relays: repository.relays,
            previous: saved?.commit ?? null,
            done: false,
          };
          if (previousJournal)
            await atomic(
              join(
                options.directory,
                '.napplet-space',
                'proposals',
                key,
                `${previousJournal.event.id}.json`,
              ),
              previousJournal,
            );
          await atomic(path, saved);
          hasSignedJournal = true;
        }
      }
      if (saved.event.pubkey !== account.pubkey || saved.repository !== repository.address)
        throw new Error('Saved proposal identity mismatch.');
      if (
        options.expectedReview &&
        (saved.commit !== options.expectedReview.commit ||
          saved.event.content !== options.description)
      )
        throw new DiagnosticError(
          'REVIEW_CHANGED',
          'The signed proposal differs from this review.',
        );
      // The signed event and real commit survive retries; no duplicate PR or changed preview.
      await deliverProposal({
        directory: join(saved.folder, 'source'),
        event: saved.event,
        repository: saved.repository,
        clones: saved.version === 2 ? saved.clones : repository.clones,
        relays: saved.relays,
        local: options.network === 'local',
        signal: options.signal,
        checkpoint: options.checkpoint,
        onProgress: options.onProgress,
      });
      saved.done = true;
      await atomic(path, saved);
      return {
        proposal: saved.root.id,
        revision: saved.event.id,
        head: saved.commit,
        base: saved.base,
        repository: saved.repository,
        preview: tag(saved.event, 'soy-preview'),
        status: 'proposed',
        sourcePublished: true,
        nappletReleased: false,
      };
    });
  } catch (cause) {
    if (
      !hasSignedJournal &&
      cause instanceof Error &&
      'code' in cause &&
      cause.code === 'SIGNER_TIMEOUT'
    )
      throw new DiagnosticError(
        'SIGNER_TIMEOUT',
        'Remote signer timed out before a signed proposal was saved.',
        {
          operation: 'prepare proposal',
          cause,
          recovery:
            'Unlock the selected signer and rerun soyli propose with the description, without --resume. Frozen preparation files alone are not a saved signed proposal.',
        },
      );
    throw cause;
  } finally {
    await signer?.close();
    client.close();
  }
}
export async function proposalAction(
  options: CollaborationOptions & {
    proposal: string;
    action: 'merge' | 'close' | 'reopen' | 'comment';
    revision?: string;
    target?: string;
    text?: string;
  },
) {
  options = {
    ...options,
    accounts: await captureAccount(options.accounts ?? new Accounts(options.network)),
  };
  const context = await collaborationContext(options),
    { client, account } = context;
  let signer: Awaited<ReturnType<Accounts['signer']>> | undefined;
  try {
    const id = proposalId(options.proposal),
      root = (await client.query([{ ids: [id], kinds: [1618, 1617], limit: 1 }]))[0];
    if (!root) throw new Error('Proposal unavailable.');
    const repository = await readRepository(client, tag(root, 'a') ?? '');
    const proposal = (await readProposals(client, repository, id)).find((p) => p.root.id === id);
    if (!proposal) throw new Error('Proposal unavailable.');
    if (!account) throw new Error('Sign in with soyli account connect or create.');
    const maintainer = repository.maintainers.includes(account.pubkey);
    if (options.action === 'merge') {
      if (!maintainer)
        throw new Error('Only an announced repository maintainer can accept changes.');
      if (
        !options.revision ||
        !options.target ||
        options.revision !== proposal.revision.id ||
        !proposal.head
      )
        throw new Error(
          'Pin the reviewed revision and target with --revision and --target; review again if either changed.',
        );
      if (!['open', 'draft'].includes(proposal.status))
        throw new Error('This proposal is no longer open.');
      if (proposal.patch) throw new Error('Use ngit to apply this external patch series.');
      if (repository.euc)
        await sourceGit(options.directory, [
          'merge-base',
          '--is-ancestor',
          repository.euc,
          options.target,
        ]);
      const { state: remote } = await readRepositoryState(client, repository);
      const targetBranch =
        tag(proposal.revision, 'target-branch') ??
        tag(proposal.root, 'target-branch') ??
        (remote && tag(remote, 'HEAD')?.replace(/^ref: refs\/heads\//, ''));
      if (!targetBranch || !remote)
        throw new Error('The upstream signed state does not identify a target branch.');
      await sourceGit(options.directory, ['check-ref-format', `refs/heads/${targetBranch}`]);
      if (
        (await sourceGit(options.directory, ['symbolic-ref', '--short', 'HEAD'])) !== targetBranch
      )
        throw new Error(`Review and merge on the proposal target branch ${targetBranch}.`);
      const remoteHead = tag(remote, `refs/heads/${targetBranch}`);
      if (!remoteHead)
        throw new Error('The proposal target branch is absent from the upstream signed state.');
      if (remoteHead)
        await sourceGit(options.directory, [
          'merge-base',
          '--is-ancestor',
          remoteHead,
          options.target,
        ]).catch((cause) => {
          const advanced = cause instanceof DiagnosticError && cause.context.exitCode === 1;
          throw new DiagnosticError(
            advanced ? 'GIT_UPSTREAM_ADVANCED' : 'GIT_ANCESTRY_CHECK',
            advanced
              ? 'The upstream branch advanced. Fetch and review the new target before merging.'
              : 'Could not check the upstream branch before merging.',
            { operation: 'check proposal ancestry', cause },
          );
        });
      return mergeReviewed(options.directory, {
        head: proposal.head,
        target: options.target,
        revision: proposal.revision.id,
        clones: proposal.clones,
        author: account.pubkey,
        local: options.network === 'local',
      });
    }
    if (options.action !== 'comment' && !maintainer && root.pubkey !== account.pubkey)
      throw new Error('Only the proposer or maintainers can change its status.');
    signer = await (options.accounts ?? new Accounts(options.network)).signer({
      signal: options.signal,
      onAuth: options.onAuth,
      kinds: [options.action === 'comment' ? 1111 : options.action === 'close' ? 1632 : 1630],
    });
    const comment = options.action === 'comment';
    const template = {
      kind: comment ? 1111 : options.action === 'close' ? 1632 : 1630,
      created_at: Math.max(
        Math.floor(Date.now() / 1000),
        (proposal.statusEvent?.created_at ?? root.created_at) + 1,
      ),
      content: options.text ?? '',
      tags: comment
        ? [
            ['E', root.id],
            ['K', String(root.kind)],
            ['P', root.pubkey],
            ['e', root.id],
            ['k', String(root.kind)],
            ['p', root.pubkey],
          ]
        : [
            ['e', root.id, '', 'root'],
            ['a', repository.address],
            ['p', root.pubkey],
            ['p', repository.pubkey],
          ],
    };
    const key = await sha256(
      JSON.stringify({
        proposal: root.id,
        action: options.action,
        text: template.content,
        pubkey: account.pubkey,
      }),
    );
    const outbox = join(options.directory, '.napplet-space', 'review-outbox', `${key}.json`);
    let event: SignedEvent;
    try {
      event = verifiedEvent(JSON.parse(await readFile(outbox, 'utf8')));
      if (
        !comment &&
        proposal.statusEvent &&
        proposal.statusEvent.id !== event.id &&
        proposal.statusEvent.created_at >= event.created_at
      ) {
        event = verifiedEvent(await signer.signEvent(template));
        await atomic(outbox, event);
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      event = verifiedEvent(await signer.signEvent(template));
      await atomic(outbox, event);
    }
    if (
      event.pubkey !== account.pubkey ||
      event.kind !== template.kind ||
      event.content !== template.content ||
      JSON.stringify(event.tags) !== JSON.stringify(template.tags)
    )
      throw new Error('Saved review action changed.');
    await client.publish(event, repository.relays);
    return { event: event.id, status: options.action };
  } finally {
    await signer?.close();
    client.close();
  }
}

/** Publish the current upstream branch without releasing a new napplet.
 * The signed state and applied events are saved before delivery, so a partial
 * Git/relay failure resumes without signing new events or repeating a merge. */
export async function pushSource(
  options: CollaborationOptions & {
    checkpoint?: (phase: 'git' | 'status') => Promise<void>;
    /** Retry one already-reviewed UI operation, including an ambiguous successful response. */
    resumeCompleted?: boolean;
    /** UI confirmation binds source sharing to this exact committed tree. */
    expectedCommit?: string;
  },
) {
  options = {
    ...options,
    accounts: await captureAccount(options.accounts ?? new Accounts(options.network)),
  };
  const { client, account } = await collaborationContext(options);
  let signer: Awaited<ReturnType<Accounts['signer']>> | undefined;
  try {
    const repository = await projectRepository(options, client);
    if (!account || !repository.maintainers.includes(account.pubkey))
      throw new Error('Only an announced repository maintainer can publish its branches.');
    const commit = await committedSource(options.directory);
    if (options.expectedCommit && commit !== options.expectedCommit)
      throw new DiagnosticError('REVIEW_CHANGED', 'The source commit changed after review.', {
        operation: 'share reviewed source',
        recovery: 'Prepare and review the current source before publishing it.',
      });
    const { inspectHistory } = await import('../../publish/src/git-source');
    await inspectHistory(options.directory, commit);
    const branch = await sourceGit(options.directory, ['symbolic-ref', '--short', 'HEAD']);
    const ref = `refs/heads/${branch}`;
    await sourceGit(options.directory, ['check-ref-format', ref]);
    const path = join(
      options.directory,
      '.napplet-space',
      'push-outbox',
      `${(await sha256(`${repository.address}:${account.pubkey}:${ref}`)).slice(0, 16)}.json`,
    );
    return await new Journal(options.directory, options.network).lock(async () => {
      let saved: any;
      try {
        saved = JSON.parse(await readFile(path, 'utf8'));
      } catch (cause) {
        if ((cause as NodeJS.ErrnoException).code !== 'ENOENT') throw cause;
      }
      if (
        saved &&
        (saved.version !== 1 ||
          saved.repository !== repository.address ||
          saved.pubkey !== account.pubkey ||
          saved.ref !== ref ||
          saved.network !== options.network)
      )
        throw new Error('Saved branch publication identity mismatch. Keep the journal.');
      if (saved && !saved.done && saved.commit !== commit)
        throw new Error(
          'Finish the saved Git publication before publishing new commits. Restore its saved branch tip and rerun soyli push; keep the journal.',
        );
      if (!saved || (saved.done && (!options.resumeCompleted || saved.commit !== commit))) {
        const { state: previous, authors } = await readRepositoryState(client, repository);
        if (!authors.includes(account.pubkey))
          throw new Error(
            'This maintainer has not confirmed repository state authority. Accept maintainership with ngit before pushing.',
          );
        if (!previous || !tag(previous, ref))
          throw new Error(
            'The current branch is not in the upstream signed state. Use ngit to create a branch first.',
          );
        const parent = tag(previous, ref)!;
        await sourceGit(options.directory, ['merge-base', '--is-ancestor', parent, commit]);
        const refs = previous.tags.filter((t) => t[0].startsWith('refs/'));
        if (refs.length > 128 || refs.some((t) => t.length !== 2 || !/^[a-f0-9]{40}$/.test(t[1])))
          throw new Error(
            'Upstream state has unsupported refs; use ngit without changing that state through soyLI.',
          );
        for (const [name] of refs) await sourceGit(options.directory, ['check-ref-format', name]);
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
            await sourceGit(options.directory, [
              'merge-base',
              '--is-ancestor',
              proposal.head!,
              commit,
            ]);
          } catch (cause) {
            if (cause instanceof DiagnosticError && cause.context.exitCode === 1) continue;
            throw cause;
          }
          const declared =
            tag(proposal.revision, 'target-branch') ?? tag(proposal.root, 'target-branch');
          const defaultBranch = tag(previous, 'HEAD')?.replace(/^ref: refs\/heads\//, '');
          if ((declared ?? defaultBranch) !== branch) continue;
          included.push(proposal);
        }
        signer = await options.accounts!.signer({
          signal: options.signal,
          onAuth: options.onAuth,
          kinds: [30618, 1631],
        });
        if ((await signer.getPublicKey()) !== account.pubkey)
          throw new Error('Signer identity changed.');
        const now = Math.max(Math.floor(Date.now() / 1000), previous.created_at + 1);
        const state = await signExact(signer, account.pubkey, {
          kind: 30618,
          created_at: now,
          content: previous.content,
          tags: previous.tags.map((t) => (t[0] === ref ? [ref, commit] : t)),
        });
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
        saved = {
          version: 1,
          network: options.network,
          repository: repository.address,
          pubkey: account.pubkey,
          commit,
          ref,
          previous: parent,
          previousState: previous.id,
          state,
          statuses,
          clones: repository.clones,
          relays: repository.relays,
          done: false,
        };
        await atomic(path, saved);
      }
      const state = verifiedEvent(saved.state);
      if (
        state.pubkey !== account.pubkey ||
        state.kind !== 30618 ||
        tag(state, ref) !== commit ||
        tag(state, 'd') !== repository.identifier
      )
        throw new Error('Saved repository state mismatch.');
      const current = await readRepositoryState(client, repository);
      if (
        !current.authors.includes(account.pubkey) ||
        ![saved.previousState, state.id].includes(current.state?.id)
      )
        throw new Error(
          'Upstream state or maintainer authority changed since preparation. Review it before publishing; keep the saved journal.',
        );
      await publishBranch({
        directory: options.directory,
        state,
        repository: repository.address,
        ref,
        previous: saved.previous,
        clones: saved.clones,
        relays: saved.relays,
        local: options.network === 'local',
        signal: options.signal,
      });
      await options.checkpoint?.('git');
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
          if (!proposal)
            throw new Error('Proposal unavailable while checking its applied revision.');
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
        await options.checkpoint?.('status');
      } catch (cause) {
        throw new DiagnosticError(
          'PROPOSAL_STATUS_UNCONFIRMED',
          'Git was published but proposal status is not confirmed.',
          {
            operation: 'confirm applied proposal status',
            target: repository.address,
            cause,
            recovery:
              'Rerun soyli push from the same commit to deliver the saved applied events. Do not repeat the merge.',
          },
        );
      } finally {
        inbox.close();
      }
      saved.supersededProposals = supersededProposals;
      saved.done = true;
      await atomic(path, saved);
      return {
        state: 'git_published',
        commit,
        branch,
        nappletReleased: false,
        supersededProposals,
      };
    });
  } finally {
    await signer?.close();
    client.close();
  }
}
