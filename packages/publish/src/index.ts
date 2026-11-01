import { ProtocolClient } from '../../client/src/nostr';
import { prepareAppliedStatuses, deliverAppliedStatuses } from '../../collaboration/src/applied';
import { repositoryFromEvent, tag } from '../../collaboration/src/protocol';
import { isManifestMigration } from '../../migration/src';
import { diagnose, redactDiagnostic } from '../../diagnostics/src';
import { parseAssets, ASSET_LOCK } from '../../assets/src';
import { inspectPreviewVideo, MAX_VIDEO_BYTES } from '../../protocol/src/preview-video';
import { join } from 'node:path';
import { realpath, rm } from 'node:fs/promises';
import { Accounts, captureAccount } from '../../identity/src/accounts';
import {
  publishingKinds,
  checkPubkey,
  type CreatorSigner,
  type Network,
} from '../../identity/src/signer';
import {
  aggregateHash,
  encodeAddress,
  identityAddress,
  sha256,
  verifiedEvent,
  type SignedEvent,
} from '../../protocol/src';
import { validateManifest, validateRelease } from '../../protocol/src/manifest';
import { prepareSource, publishSource, sourceGit, sourceUrls } from '../../grasp/src/client';
import { uploadBlob } from '../../blossom/src/client';
import type { EventTemplate } from 'nostr-tools';
import { PublishError, projectSchema, resolveTargets, type Targets } from './config';
import { Journal, type PublishJob } from './journal';
import type { CheckReport } from './check-report';
import {
  durableFile,
  freezeSource,
  inspectProject,
  regularFile,
  type PublishPlan,
} from './project';
import { PublicationRelays } from './relay';
import { copyPublication } from '../../nostr/src/publication-copies';
import { ownedBlobs, verifiedBlob } from './blobs';
import { confirmWebsite } from './website';
import { executableBytes } from './artifact';
import { committedSource, inspectHistory, SourceHistoryError } from './git-source';
import { repositoryRef } from '../../collaboration/src/protocol';
import {
  loadRepository,
  RepositoryError,
  selectRepository,
  verifyReleaseReachable,
  type SelectedRepository,
} from './repository';

import { MANIFEST_PRESENTATION_PROFILE } from '../../protocol/src/presentation';

export { PublishError } from './config';
type RelayOperations = Pick<PublicationRelays, 'latest' | 'ensure' | 'close'> &
  Partial<Pick<PublicationRelays, 'read'>>;
type Dependencies = {
  relays?: RelayOperations;
  source?: typeof publishSource;
  proposalClient?: ProtocolClient;
  upload?: typeof uploadBlob;
  owned?: typeof ownedBlobs;
  verified?: typeof verifiedBlob;
  // A checkpoint hook supports deterministic crash tests without production flags.
  checkpoint?: (job: PublishJob) => Promise<void>;
  website?: typeof confirmWebsite;
  // NIP-05 owner lookup and Git ref listing for the creator's own repository.
  fetch?: typeof fetch;
  lsRemote?: Parameters<typeof verifyReleaseReachable>[0]['lsRemote'];
};
export type PublishOptions = {
  directory: string;
  network: Network;
  targets?: Partial<Targets>;
  dryRun?: boolean;
  resume?: boolean;
  /** Opt in to an additional independent immutable manifest. */
  snapshot?: boolean;
  /** UI approval binds to exact source, metadata, media and destination bytes. */
  expectedFingerprint?: string;
  /** Reviewed NIP-34 repository address; null selects soyLI-hosted source. */
  expectedRepository?: string | null;
  /** Continue an explicitly reviewed named release from a fresh linked-repository checkout. */
  expectedCurrent?: SignedEvent;
  accounts?: Pick<Accounts, 'current' | 'signer'>;
  check: (
    contents: Map<string, Uint8Array>,
  ) => Promise<CheckReport & { preview?: Uint8Array; video?: Uint8Array }>;
  requirePreview?: boolean;
  signal?: AbortSignal;
  onAuth?: (url: string) => Promise<void>;
  progress?: (stage: string) => void;
  summary?: (plan: PublishPlan, repository: SelectedRepository | null) => void;
  dependencies?: Dependencies;
};
function result(job: PublishJob, unchanged = false) {
  const identity = {
    kind: 35129 as const,
    pubkey: job.plan.pubkey,
    identifier: job.plan.identifier,
  };
  const naddr = encodeAddress(identity, [job.plan.targets.relay, ...job.plan.targets.mirrors]);
  return {
    status: job.website?.ready ? ('indexed' as const) : job.status,
    unchanged,
    jobId: job.id,
    creator: job.plan.pubkey,
    identifier: job.plan.identifier,
    sourceCommit: job.commit,
    sourceArchive: `${job.plan.targets.blossom}/${job.archiveHash}`,
    sourceRepository: job.repository
      ? { address: job.repository.address, origin: job.repository.origin, hosted: false }
      : { address: null, origin: job.plan.targets.grasp, hosted: true },
    artifactHash: job.plan.artifactHash,
    naddr,
    snapshotId: job.snapshot?.id ?? null,
    currentId: job.current?.id ?? null,
    // These are portable route candidates until the website has indexed the events.
    url: `${job.plan.targets.site}/n/${naddr}`,
    // A standalone snapshot carries ancestry, not its own named application identity.
    // Pin the signed current event to retain named storage/backend identity when sharing.
    snapshotUrl:
      job.plan.manifestFormat === 'standalone'
        ? job.current
          ? `${job.plan.targets.site}/r/${job.current.id}`
          : null
        : job.snapshot
          ? `${job.plan.targets.site}/r/${job.snapshot.id}`
          : null,
    websiteReady: job.website?.ready ?? false,
    websiteCheckedAt: job.website?.checkedAt ?? null,
    websiteStatus: job.website?.reason ?? 'pending',
    targets: job.plan.targets,
    preview: job.preview
      ? {
          hash: job.preview.hash,
          url: `${job.plan.targets.blossom}/${job.preview.hash}`,
          descriptorId: job.preview.descriptor?.id ?? null,
        }
      : null,
    video: job.video
      ? { ...job.video, url: `${job.plan.targets.blossom}/${job.video.hash}` }
      : null,
    icon: job.plan.icon
      ? {
          hash: job.plan.icon.hash,
          mime: job.plan.icon.mime,
          url: `${job.plan.targets.blossom}/${job.plan.icon.hash}`,
        }
      : null,
    mirrors: job.mirrors,
    mirrorErrors: job.mirrorErrors ?? {},
    outbox: job.outbox ?? null,
    receipts: job.receipts,
    error: job.error ?? null,
  };
}
export async function publicationStatus(
  directory: string,
  network: Network,
  options: {
    refresh?: boolean;
    signal?: AbortSignal;
    creator?: string;
    waitForWebsite?: boolean;
  } = {},
) {
  const journal = new Journal(await realpath(directory), network, options.creator);
  const read = async () => {
    const index = await journal.index();
    const id = index.active ?? index.latest;
    if (!id) return { status: 'not_started' as const };
    const job = await journal.load(id);
    if (options.refresh && job.status === 'announced_pending_index') {
      job.website = await confirmWebsite(job, {
        signal: options.signal,
        wait: options.waitForWebsite,
        ...(options.waitForWebsite === false ? { timeoutMs: 5000 } : {}),
      });
      await journal.save(job);
    }
    return result(job);
  };
  return options.refresh ? journal.lock(read) : read();
}
async function verifyFrozen(journal: Journal, job: PublishJob) {
  const directory = journal.directory(job.id);
  const inspected = await inspectProject(
    join(directory, 'files'),
    job.plan.network,
    job.plan.pubkey,
    job.plan.targets,
    job.commit,
    job.plan.files.map((f) => f.path),
    job.plan.manifestFormat ?? 'legacy',
  );
  if (
    inspected.fingerprint !== job.fingerprint ||
    JSON.stringify(inspected.plan) !== JSON.stringify(job.plan) ||
    (await sourceGit(join(directory, 'source'), ['rev-parse', 'HEAD'])) !== job.commit ||
    (await sourceGit(join(directory, 'source'), ['status', '--porcelain']))
  )
    throw new PublishError(
      'FROZEN_SOURCE_CHANGED',
      'The saved release source is damaged or changed. Restore its journal backup before resuming.',
    );
  const archive = await regularFile(directory, 'source.tar', 50 * 1024 * 1024);
  if (archive.length !== job.archiveBytes || (await sha256(archive)) !== job.archiveHash)
    throw new PublishError(
      'FROZEN_SOURCE_CHANGED',
      'The saved source archive is damaged. Restore its journal backup before resuming.',
    );
  const preview = job.preview
    ? await regularFile(directory, 'preview.png', 5 * 1024 * 1024)
    : undefined;
  if (
    job.preview &&
    (!preview ||
      preview.length !== job.preview.bytes ||
      (await sha256(preview)) !== job.preview.hash)
  )
    throw new PublishError(
      'FROZEN_PREVIEW_CHANGED',
      'The saved preview is damaged. Restore its journal backup before resuming.',
    );
  const video = job.video
    ? await regularFile(directory, 'preview.webm', MAX_VIDEO_BYTES)
    : undefined;
  if (
    job.video &&
    (!video || video.length !== job.video.bytes || (await sha256(video)) !== job.video.hash)
  )
    throw new PublishError(
      'FROZEN_PREVIEW_CHANGED',
      'The saved preview video is damaged. Restore its journal backup before resuming.',
    );
  if (video && job.video) {
    const info = inspectPreviewVideo(video);
    if (
      info.width !== job.video.width ||
      info.height !== job.video.height ||
      info.durationMs !== job.video.durationMs
    )
      throw new PublishError(
        'FROZEN_PREVIEW_CHANGED',
        'The saved video metadata differs from its frozen bytes. Restore its journal backup.',
      );
  }
  return { ...inspected, archive, preview, video };
}
export async function publishProject(options: PublishOptions) {
  const accounts = await captureAccount(options.accounts ?? new Accounts(options.network));
  const account = await accounts.current();
  if (!account)
    throw new PublishError(
      'ACCOUNT_REQUIRED',
      'Set up a creator with account create or account connect first.',
    );
  checkPubkey(account.pubkey, options.network);
  if (options.dryRun) {
    if (options.resume)
      throw new PublishError(
        'PUBLISH_OPTIONS',
        'Use status to inspect a saved publication; dry-run checks the current source.',
      );
    const { plan, fingerprint, repository } = await inspectProject(
      options.directory,
      options.network,
      account.pubkey,
      options.targets,
    );
    const selected = await selectRepository({
      directory: options.directory,
      pubkey: account.pubkey,
      configured: repository,
      fetch: options.dependencies?.fetch,
      signal: options.signal,
    });
    const sourceHistory =
      plan.sourceCommit === '0'.repeat(40)
        ? { status: 'uncommitted' as const }
        : {
            status: 'checked' as const,
            ...(await inspectHistory(options.directory, plan.sourceCommit)),
          };
    return {
      status: 'dry_run' as const,
      snapshot: options.snapshot === true,
      fingerprint,
      plan,
      sourceRepository: selected
        ? { address: selected.address, origin: selected.origin, hosted: false }
        : { address: null, origin: plan.targets.grasp, hosted: true },
      sourceHistory,
      checksPending: [
        ...(sourceHistory.status === 'uncommitted'
          ? ['committed Git history (save a checkpoint first)']
          : []),
        'sandbox startup and preview capture',
        'remote current version',
        'Git/Blossom/relay availability',
        'your NIP-65 outbox relays (best-effort copies)',
        ...(selected ? ['release commit pushed to your repository'] : []),
      ],
    };
  }
  const root = await realpath(options.directory);
  const journal = new Journal(root, options.network, account.pubkey);
  const deps = options.dependencies ?? {};
  const relays = deps.relays ?? new PublicationRelays(options.signal);
  const local = options.network === 'local';
  const latest = (url: string, pubkey: string, identifier: string, kind: number) =>
    relays.latest(url, pubkey, identifier, kind);
  let signer: CreatorSigner | undefined,
    stage = 'check';
  const progress = (next: string) => {
    if (options.signal?.aborted)
      throw new PublishError(
        'PUBLISH_CANCELLED',
        'Publication cancelled. Resume the saved job with publish --resume.',
        stage,
        true,
      );
    stage = next;
    options.progress?.(next);
  };
  try {
    return await journal.lock(async () => {
      const index = await journal.index();
      let job = index.active ? await journal.load(index.active) : null;
      const previous = index.latest ? await journal.load(index.latest) : null;
      const previousCurrent = previous?.current;
      const retirement =
        previousCurrent && relays.read
          ? (
              await relays.read(previous.plan.targets.relay, {
                kinds: [5],
                authors: [account.pubkey],
                limit: 200,
              })
            ).filter(
              (e) =>
                e.created_at >= previousCurrent.created_at &&
                e.tags.some(
                  (t) =>
                    (t[0] === 'e' && t[1] === previousCurrent.id) ||
                    (t[0] === 'a' &&
                      t[1] === `35129:${account.pubkey}:${previous.plan.identifier}`),
                ),
            )
          : [];
      const remotePrevious = previousCurrent
        ? await relays.latest(
            previous.plan.targets.relay,
            account.pubkey,
            previous.plan.identifier,
            35129,
          )
        : null;
      const sameListing = !!(
        previousCurrent &&
        remotePrevious &&
        previousCurrent.content === remotePrevious.content &&
        JSON.stringify(previousCurrent.tags) === JSON.stringify(remotePrevious.tags)
      );
      const retired = retirement.length > 0;
      const refreshedInShell =
        (sameListing ||
          (!!previousCurrent &&
            !!remotePrevious &&
            (await isManifestMigration(previousCurrent, remotePrevious)))) &&
        remotePrevious?.id !== previousCurrent?.id;
      if (options.resume && !job && (retired || refreshedInShell))
        throw new PublishError(
          'PUBLICATION_RETIRED',
          'This saved listing was unpublished or republished elsewhere. Run publish without --resume to create a fresh release.',
        );
      if (options.resume && !job) {
        if (!previous)
          throw new PublishError(
            'PUBLISH_MISSING',
            'No saved publication exists. Run publish first.',
          );
        job = previous;
      }
      try {
        if (!options.resume) {
          await committedSource(root);
          const inspected = await inspectProject(
            root,
            options.network,
            account.pubkey,
            options.targets,
          );
          // Bind UI approval before source availability checks or sandbox startup.
          if (options.expectedFingerprint && inspected.fingerprint !== options.expectedFingerprint)
            throw new PublishError(
              'REVIEW_CHANGED',
              'The project changed after review. Prepare and review the release again.',
            );
          await inspectHistory(root, inspected.plan.sourceCommit);
          const selected = await selectRepository({
            directory: root,
            pubkey: account.pubkey,
            configured: inspected.repository,
            fetch: deps.fetch,
            signal: options.signal,
          });
          if (
            options.expectedRepository !== undefined &&
            options.expectedRepository !== (selected?.address ?? null)
          )
            throw new PublishError(
              'REVIEW_CHANGED',
              'The source repository changed after review. Prepare and review the release again.',
            );
          if (job && job.fingerprint !== inspected.fingerprint)
            throw new PublishError(
              'PUBLISH_PENDING',
              'A different release is pending. Use publish --resume to finish its frozen source, then publish your new edits.',
            );
          if (
            !job &&
            previous?.fingerprint === inspected.fingerprint &&
            previous.presentationProfile === MANIFEST_PRESENTATION_PROFILE &&
            !retired &&
            !refreshedInShell &&
            (previous.repository?.address ?? null) === (selected?.address ?? null) &&
            (!options.requirePreview || previous.preview) &&
            (!options.snapshot || previous.snapshotMode !== 'none')
          )
            job = previous;
          if (!job) {
            if (previous) {
              if (
                previous.plan.pubkey !== account.pubkey ||
                previous.plan.identifier !== inspected.plan.identifier ||
                previous.plan.targets.relay !== inspected.plan.targets.relay ||
                // The Git host names soyLI's hosted repository. Moving to or between the
                // creator's own repositories does not rewrite it.
                (!previous.repository &&
                  !selected &&
                  previous.plan.targets.grasp !== inspected.plan.targets.grasp)
              )
                throw new PublishError(
                  'PUBLISH_IDENTITY',
                  'The identifier, primary relay or Git host changed for this creator. Their existing publication history must be migrated explicitly. Blossom, site and mirrors can be changed for a new release; pending releases retain their frozen destinations.',
                );
              await verifyFrozen(journal, previous);
            }
            const plan = inspected.plan;
            options.summary?.(plan, selected);
            const source = sourceUrls(
              plan.targets.grasp,
              account.pubkey,
              plan.identifier,
              options.network === 'local',
            );
            progress('check');
            // The creator's own repository is verified, not written: no hosted source events.
            const linked = selected
              ? await loadRepository(latest, selected, local, [
                  plan.targets.relay,
                  ...plan.targets.mirrors,
                ])
              : null;
            const [current, sourceState, announcement] = await Promise.all([
              relays.latest(plan.targets.relay, account.pubkey, plan.identifier, 35129),
              linked ? null : relays.latest(source.relay, account.pubkey, plan.identifier, 30618),
              linked ? null : relays.latest(source.relay, account.pubkey, plan.identifier, 30617),
            ]);
            let reviewedContinuation = false;
            if (!previous && options.expectedCurrent) {
              const anchor = verifiedEvent(options.expectedCurrent);
              await validateManifest(anchor);
              const sourceRef = anchor.tags.find((t) => t[0] === 'source')?.[1];
              if (
                !linked ||
                anchor.kind !== 35129 ||
                anchor.pubkey !== account.pubkey ||
                anchor.tags.find((t) => t[0] === 'd')?.[1] !== plan.identifier ||
                !sourceRef?.startsWith('nostr://') ||
                repositoryRef(sourceRef).address !== linked.repository.address ||
                current?.id !== anchor.id
              )
                throw new PublishError(
                  'REMOTE_CONFLICT',
                  'The reviewed release no longer matches this author, listing or source repository. Review the current napplet again before publishing.',
                );
              reviewedContinuation = true;
            }
            if (
              (current?.id ?? null) !== (previous?.current?.id ?? null) &&
              !reviewedContinuation &&
              !(retired && !current) &&
              !(refreshedInShell && current?.id === remotePrevious?.id)
            )
              throw new PublishError(
                'REMOTE_CONFLICT',
                'A remote release or source state differs from this journal. Restore the current journal or choose a new napplet identifier; stale releases are never forced over it.',
              );
            if (linked)
              await verifyReleaseReachable({
                directory: root,
                repository: linked.repository,
                state: linked.state,
                commit: plan.sourceCommit,
                lsRemote: deps.lsRemote,
              });
            if (
              sourceState?.tags.some(
                (t) =>
                  t[0].startsWith('refs/') &&
                  t[0] !== 'refs/heads/main' &&
                  !/^refs\/tags\/release-[a-f0-9]{16}$/.test(t[0]),
              )
            )
              throw new PublishError(
                'SOURCE_LAYOUT',
                'This repository has additional Git refs. Use ngit for this layout; soyLI will not remove them.',
              );
            const sourceBaseCommit =
              sourceState?.tags.find((t) => t[0] === 'refs/heads/main')?.[1] ?? null;
            if (sourceBaseCommit) {
              if (!/^[a-f0-9]{40}$/.test(sourceBaseCommit))
                throw new PublishError('REMOTE_CONFLICT', 'Invalid remote source commit.');
              await sourceGit(root, [
                'merge-base',
                '--is-ancestor',
                sourceBaseCommit,
                inspected.plan.sourceCommit,
              ]).catch(() => {
                throw new PublishError(
                  'REMOTE_CONFLICT',
                  'Fetch and integrate the remote Git branch before publishing.',
                );
              });
            }
            const now = Math.floor(Date.now() / 1000);
            const createdAt = Math.max(
              now,
              ...retirement.map((e) => e.created_at + 1),
              ...[current, sourceState, announcement].map((e) => (e ? e.created_at + 1 : 0)),
            );
            if (createdAt > now + 60)
              throw new PublishError(
                'CLOCK_SKEW',
                'The last publication is ahead of this clock. Correct the clock before publishing.',
              );
            progress('sandbox');
            const { preview, video, ...check } = await options.check(inspected.contents);
            const videoInfo = video ? inspectPreviewVideo(video) : null;
            if (video && !preview)
              throw new PublishError(
                'PREVIEW_REQUIRED',
                'Video previews also need a static screenshot.',
              );
            if (options.requirePreview && !preview)
              throw new PublishError(
                'PREVIEW_REQUIRED',
                'Publishing requires a preview. Run soyli screenshot or update the CLI.',
              );
            if (
              preview &&
              (!preview.length ||
                preview.length > 5 * 1024 * 1024 ||
                Buffer.from(preview.subarray(0, 8)).toString('hex') !== '89504e470d0a1a0a')
            )
              throw new PublishError('PREVIEW_IMAGE', 'The preview must be a PNG under 5 MiB.');
            if (
              (await inspectProject(root, options.network, account.pubkey, options.targets))
                .fingerprint !== inspected.fingerprint
            )
              throw new PublishError(
                'PROJECT_CHANGED',
                'Source changed during the sandbox check. Run publish again to check the new revision.',
              );
            const id = await sha256(
              JSON.stringify({
                fingerprint: inspected.fingerprint,
                parent: previous?.id ?? null,
                createdAt,
              }),
            );
            progress('freeze');
            const frozen = await freezeSource(
              journal.directory(id),
              inspected.contents,
              createdAt,
              { directory: root, commit: inspected.plan.sourceCommit },
            );
            if (preview) {
              const path = join(journal.directory(id), 'preview.png');
              await rm(path, { force: true }); // Only an unactivated preparation can reach this branch.
              await durableFile(path, preview);
            }
            if (video) {
              const path = join(journal.directory(id), 'preview.webm');
              await rm(path, { force: true });
              await durableFile(path, video);
            }
            const releaseRefs: Record<string, string> = linked
              ? {}
              : {
                  ...Object.fromEntries(
                    (sourceState?.tags ?? [])
                      .filter((t) => /^refs\/tags\/release-[a-f0-9]{16}$/.test(t[0]))
                      .map((t) => [t[0], t[1]]),
                  ),
                  ...previous?.releaseRefs,
                  [`refs/tags/release-${id.slice(0, 16)}`]: frozen.commit,
                };
            if (Object.keys(releaseRefs).length > 128)
              throw new PublishError(
                'RELEASE_LIMIT',
                'This initial publisher retains up to 128 releases per repository. No refs were removed.',
              );
            job = {
              version: 1,
              presentationProfile: MANIFEST_PRESENTATION_PROFILE,
              id,
              fingerprint: inspected.fingerprint,
              snapshotMode: options.snapshot ? 'explicit' : 'none',
              plan,
              createdAt,
              parent: previous?.id ?? null,
              baseCurrent: current?.id ?? null,
              baseSource: sourceState?.id ?? null,
              sourceBaseCommit,
              baseAnnouncement: announcement?.id ?? null,
              ...(announcement ? { repositoryAnnouncement: announcement } : {}),
              ...(linked
                ? {
                    repository: {
                      address: linked.repository.address,
                      origin: linked.repository.origin,
                      relays: linked.repository.relays,
                      clones: linked.repository.clones,
                      source: linked.repository.source,
                    },
                  }
                : {}),
              ...frozen,
              check,
              ...(preview
                ? { preview: { hash: await sha256(preview), bytes: preview.length } }
                : {}),
              ...(video && videoInfo
                ? { video: { hash: await sha256(video), bytes: video.length, ...videoInfo } }
                : {}),
              releaseRefs,
              status: 'prepared',
              mirrors: {},
              receipts: {
                ...(preview ? { preview: false } : {}),
                ...(video ? { video: false } : {}),
                ...(plan.icon ? { icon: false } : {}),
                source: false,
                artifact: false,
                archive: false,
                snapshot: false,
                current: false,
              },
            };
            await journal.save(job);
            await journal.select(id, index.latest);
            await deps.checkpoint?.(job);
          }
        }
        if (!job) throw new PublishError('PUBLISH_MISSING', 'No publication was prepared.');
        if (options.snapshot && job.snapshotMode === 'none')
          throw new PublishError(
            'PUBLISH_OPTIONS',
            'This frozen release was prepared without a snapshot. Finish it with publish --resume, then run publish --snapshot to request an immutable copy.',
          );
        if (options.expectedFingerprint && job.fingerprint !== options.expectedFingerprint)
          throw new PublishError(
            'REVIEW_CHANGED',
            'This saved publication does not match the reviewed release. Review the pending release before resuming.',
          );
        if (
          options.expectedRepository !== undefined &&
          options.expectedRepository !== (job.repository?.address ?? null)
        )
          throw new PublishError(
            'REVIEW_CHANGED',
            'This saved source repository does not match the reviewed release.',
          );
        if (job.plan.pubkey !== account.pubkey)
          throw new PublishError(
            'CREATOR_MISMATCH',
            'This pending release belongs to a different creator. Start a new publication under your selected account; do not change accounts automatically.',
          );
        const frozen = await verifyFrozen(journal, job);
        const resumedTargets = resolveTargets(
          projectSchema.parse(
            JSON.parse(new TextDecoder().decode(frozen.contents.get('napplet.json')!)),
          ),
          options.network,
          { ...job.plan.targets, ...options.targets },
        );
        if (JSON.stringify(resumedTargets) !== JSON.stringify(job.plan.targets))
          throw new PublishError(
            'PUBLISH_TARGET',
            'A saved publication cannot be resumed against different destinations.',
          );
        const currentJob = job;
        const save = async () => {
          await journal.save(currentJob);
          await deps.checkpoint?.(currentJob);
        };
        const guard = async () => {
          progress('check');
          const source = sourceUrls(
            currentJob.plan.targets.grasp,
            account.pubkey,
            currentJob.plan.identifier,
            options.network === 'local',
          );
          for (const [url, kind, base, own] of [
            [currentJob.plan.targets.relay, 35129, currentJob.baseCurrent, currentJob.current?.id],
            ...(currentJob.repository
              ? []
              : ([
                  [source.relay, 30618, currentJob.baseSource, currentJob.source?.state.id],
                  [
                    source.relay,
                    30617,
                    currentJob.baseAnnouncement,
                    currentJob.source?.announcement.id,
                  ],
                ] as const)),
          ] as const) {
            const newest = await relays.latest(
              url,
              account.pubkey,
              currentJob.plan.identifier,
              kind,
            );
            if (newest && newest.id !== base && newest.id !== own)
              throw new PublishError(
                'REMOTE_CONFLICT',
                'The remote napplet or repository has changed. This saved release will not overwrite it.',
              );
          }
        };
        await guard();
        const completed = job.status === 'announced_pending_index';
        signer = await accounts.signer({
          signal: options.signal,
          onAuth: options.onAuth,
          kinds: [...publishingKinds, 1631],
        });
        if ((await signer.getPublicKey()) !== account.pubkey)
          throw new PublishError(
            'CREATOR_MISMATCH',
            'The signer changed identity. Reconnect it explicitly.',
          );
        progress('sign');
        const directory = join(journal.directory(job.id), 'source');
        if (!job.repository)
          job.source = await prepareSource({
            directory,
            identifier: job.plan.identifier,
            title: job.plan.title,
            origin: job.plan.targets.grasp,
            local: options.network === 'local',
            createdAt: job.createdAt,
            releaseRefs: job.releaseRefs,
            announcement: job.repositoryAnnouncement,
            signer: job.source
              ? {
                  getPublicKey: async () => job!.plan.pubkey,
                  signEvent: async (template) =>
                    template.kind === 30617 ? job!.source!.announcement : job!.source!.state,
                }
              : signer!,
          });
        if (!completed) await save();
        // A prepared legacy journal keeps its original wire shape, even if signing was
        // interrupted. Fresh jobs always use the standalone NIP-5D manifest.
        const standalone = job.plan.manifestFormat === 'standalone';
        const directPresentation = job.presentationProfile === MANIFEST_PRESENTATION_PROFILE;
        const tags = [
          ...(standalone
            ? [['x', job.plan.artifactHash]]
            : [
                ['path', '/index.html', job.plan.artifactHash],
                [
                  'x',
                  await aggregateHash([{ path: '/index.html', hash: job.plan.artifactHash }]),
                  'aggregate',
                ],
              ]),
          ['title', job.plan.title],
          ...(job.preview && !directPresentation
            ? [
                [
                  'app',
                  `32267:${account.pubkey}:${job.plan.identifier}-${job.id.slice(0, 16)}`,
                  job.plan.targets.relay,
                ],
              ]
            : []),
          ...(directPresentation && job.preview
            ? [
                ['presentation', MANIFEST_PRESENTATION_PROFILE],
                ['screenshot', job.preview.hash, 'image/png'],
                ...(job.video ? [['preview', job.video.hash, 'video/webm']] : []),
              ]
            : []),
          ...(job.plan.remix
            ? [
                ...(!standalone && job.plan.remix.origin ? [['A', job.plan.remix.origin]] : []),
                ['remix-version', job.plan.remix.revision],
              ]
            : []),
          ...(!standalone && job.plan.description ? [['description', job.plan.description]] : []),
          ...job.plan.servers.map((s) => ['server', s]),
          ...job.plan.requires.map((r) => [standalone ? 'R' : 'requires', r]),
          ...(standalone
            ? [
                ...(job.plan.optionalDomains ?? []).map((r) => ['O', r]),
                ...(job.plan.archetypes ?? []).map((a) => ['z', a]),
                ...(job.plan.intents ?? []).map((i) => ['i', i.intent, ...i.parameters]),
                ...(job.plan.icon ? [['icon', job.plan.icon.hash, job.plan.icon.mime]] : []),
              ]
            : []),
          ...job.plan.topics.map((t) => ['t', t]),
          [
            'source',
            job.repository?.source ??
              sourceUrls(
                job.plan.targets.grasp,
                account.pubkey,
                job.plan.identifier,
                options.network === 'local',
              ).portable,
          ],
          // A signed, optional cleanup policy protects an existing repository even
          // when it happens to share the napplet identifier. It never gates playback.
          ...(job.repository && !job.current && !job.snapshot
            ? [['soy-source-repository', job.repository.address, 'linked']]
            : ((job.current ?? job.snapshot)?.tags.filter(
                (t) => t[0] === 'soy-source-repository',
              ) ?? [])),
          ['source-commit', job.commit],
          ['source-archive', `${job.plan.targets.blossom}/${job.archiveHash}`],
        ];
        const sign = async (template: EventTemplate, existing?: SignedEvent) => {
          const event = verifiedEvent(existing ?? (await signer!.signEvent(template)));
          if (
            event.pubkey !== account.pubkey ||
            event.kind !== template.kind ||
            event.content !== template.content ||
            event.created_at !== template.created_at ||
            JSON.stringify(event.tags) !== JSON.stringify(template.tags)
          )
            throw new PublishError(
              'JOURNAL_SIGNATURE',
              'Saved signing data does not match this frozen release.',
            );
          return event;
        };
        if (job.preview && !directPresentation) {
          job.preview.descriptor = await sign(
            {
              kind: 32267,
              created_at: job.createdAt,
              content:
                job.plan.description +
                (job.video ? `\n\n${job.plan.targets.blossom}/${job.video.hash}` : ''),
              tags: [
                ['d', `${job.plan.identifier}-${job.id.slice(0, 16)}`],
                ['name', job.plan.title],
                ['image', `${job.plan.targets.blossom}/${job.preview.hash}`],
                ...(job.video
                  ? [
                      [
                        'imeta',
                        `url ${job.plan.targets.blossom}/${job.video.hash}`,
                        'm video/webm',
                        `x ${job.video.hash}`,
                        `size ${job.video.bytes}`,
                        `dim ${job.video.width}x${job.video.height}`,
                        `alt ${job.plan.title} preview`,
                        `thumb ${job.plan.targets.blossom}/${job.preview.hash}`,
                      ],
                    ]
                  : []),
                ['license', job.plan.license],
                [
                  'repository',
                  job.repository?.clones[0] ??
                    job.source!.announcement.tags.find((tag) => tag[0] === 'clone')![1],
                ],
                [
                  'latest',
                  `35129:${account.pubkey}:${job.plan.identifier}`,
                  job.plan.targets.relay,
                ],
                ...job.plan.topics.map((topic) => ['t', topic]),
              ],
            },
            job.preview.descriptor,
          );
          if (!completed) await save();
        }
        if (job.snapshotMode !== 'none')
          job.snapshot = await sign(
            {
              kind: 5129,
              created_at: job.createdAt,
              content: standalone ? job.plan.description : '',
              tags: [
                ...tags,
                ...(standalone
                  ? [
                      ...(job.plan.remix?.parent ? [['a', job.plan.remix.parent]] : []),
                      ...(job.plan.remix?.origin ? [['A', job.plan.remix.origin]] : []),
                    ]
                  : [
                      [
                        'a',
                        identityAddress({
                          kind: 35129,
                          pubkey: account.pubkey,
                          identifier: job.plan.identifier,
                        }),
                      ],
                    ]),
              ],
            },
            job.snapshot,
          );
        if (!completed) await save();
        job.current = await sign(
          {
            kind: 35129,
            created_at: job.createdAt,
            content: standalone ? job.plan.description : '',
            tags: [
              ...tags,
              ['d', job.plan.identifier],
              ...(!standalone && job.plan.remix?.parent ? [['a', job.plan.remix.parent]] : []),
            ],
          },
          job.current,
        );
        if (job.snapshot) await validateRelease(job.current, job.snapshot);
        else await validateManifest(job.current);
        if (!completed) await save();
        await guard();
        progress('source');
        // Keep discovery hints: NIP-34 announcements need not repeat them in a relays tag.
        const linkedSource = job.repository
          ? await loadRepository(
              latest,
              { ...repositoryRef(job.repository.address), ...job.repository },
              local,
            )
          : null;
        const sourceRepository = linkedSource
          ? repositoryFromEvent(
              { ...repositoryRef(job.repository!.address), relays: linkedSource.repository.relays },
              linkedSource.announcement,
            )
          : repositoryFromEvent(
              repositoryRef(`30617:${account.pubkey}:${job.plan.identifier}`),
              job.source!.announcement,
            );
        const proposalClient =
          deps.proposalClient ??
          new ProtocolClient(() => [
            ...sourceRepository.relays,
            job!.plan.targets.relay,
            sourceUrls(job!.plan.targets.grasp, account.pubkey, job!.plan.identifier, local).relay,
          ]);
        try {
          // Hosted source always publishes main. Linked source remains read-only;
          // reconcile only when its signed current branch names this exact release.
          const sourceState = linkedSource ? linkedSource.state : job.source!.state;
          const sourceBranch = job.repository
            ? await sourceGit(root, ['rev-parse', '--abbrev-ref', 'HEAD'])
            : 'main';
          if (
            !job.appliedStatuses &&
            sourceState &&
            tag(sourceState, `refs/heads/${sourceBranch}`) === job.commit &&
            sourceRepository.maintainers.includes(account.pubkey)
          ) {
            job.appliedBranch = sourceBranch;
            job.appliedStatuses = await prepareAppliedStatuses({
              directory: root,
              client: proposalClient,
              repository: sourceRepository,
              previous: sourceState,
              branch: sourceBranch,
              commit: job.commit,
              signer: signer!,
              pubkey: account.pubkey,
            });
            await save();
          }

          if (job.repository) {
            // Recheck at this step so a resumed release cannot point at a commit that left the repository.
            const linked = await loadRepository(
              latest,
              { ...repositoryRef(job.repository.address), ...job.repository },
              local,
            );
            const appliedRef = job.appliedStatuses?.length
              ? job.appliedBranch && `refs/heads/${job.appliedBranch}`
              : undefined;
            if (
              job.appliedStatuses?.length &&
              (!appliedRef ||
                !linked.state ||
                tag(linked.state, appliedRef) !== job.commit ||
                !repositoryFromEvent(
                  { ...repositoryRef(job.repository.address), relays: linked.repository.relays },
                  linked.announcement,
                ).maintainers.includes(account.pubkey))
            )
              throw new RepositoryError(
                'PROPOSAL_TARGET_CHANGED',
                'The linked repository no longer confirms the reviewed proposal target.',
                {
                  operation: 'confirm applied proposal target',
                  target: `${job.repository.address}#${appliedRef ?? 'unknown branch'}`,
                  detail: `Reviewed release commit: ${job.commit}`,
                  recovery:
                    'Review the target branch and maintainer list. Resume only after the same branch serves the reviewed commit again. If the change is intentional, prepare a new publication from a fresh checkout. No merged status was sent.',
                },
                'source',
                true,
              );
            await verifyReleaseReachable({
              directory: root,
              repository: linked.repository,
              state: linked.state,
              commit: job.commit,
              // A tag retaining the release is not evidence that its target branch was merged.
              ref: appliedRef,
              lsRemote: deps.lsRemote,
            });
          } else
            await (deps.source ?? publishSource)({
              directory,
              origin: job.plan.targets.grasp,
              local: options.network === 'local',
              publication: job.source!,
              expectedCommit: job.sourceBaseCommit,
            });
          if (job.appliedStatuses?.length)
            await deliverAppliedStatuses({
              repository: sourceRepository,
              commit: job.commit,
              pubkey: account.pubkey,
              statuses: job.appliedStatuses,
              signal: options.signal,
              recovery:
                'Run soyli publish --resume to deliver the saved applied events. Do not repeat the merge.',
            });
        } finally {
          if (!deps.proposalClient) proposalClient.close();
        }
        job.receipts.source = true;
        await save();
        progress('upload');
        const owned = await (deps.owned ?? ownedBlobs)(
          job.plan.targets.blossom,
          account.pubkey,
          signer!,
          options.signal,
        );
        for (const [kind, bytes, hash, type] of [
          ['artifact', executableBytes(frozen.contents), job.plan.artifactHash, 'text/html'],
          ['archive', frozen.archive, job.archiveHash, 'application/x-tar'],
          ...(job.plan.icon
            ? [
                [
                  'icon',
                  frozen.contents.get(job.plan.icon.file)!,
                  job.plan.icon.hash,
                  job.plan.icon.mime,
                ] as const,
              ]
            : []),
          ...(job.video && frozen.video
            ? [['video', frozen.video, job.video.hash, 'video/webm'] as const]
            : []),
          ...(job.preview && frozen.preview
            ? [['preview', frozen.preview, job.preview.hash, 'image/png'] as const]
            : []),
        ] as const) {
          if (
            !owned.has(hash) ||
            !(await (deps.verified ?? verifiedBlob)(
              job.plan.targets.blossom,
              hash,
              bytes.length,
              options.signal,
            ))
          )
            await (deps.upload ?? uploadBlob)({
              origin: job.plan.targets.blossom,
              bytes,
              type,
              signer: signer!,
              local: options.network === 'local',
              signal: options.signal,
            });
          job.receipts[kind] = true;
          await save();
        }
        for (const asset of parseAssets(frozen.contents.get(ASSET_LOCK)).assets.filter(
          (a) => a.storage === 'external',
        )) {
          const bytes = frozen.contents.get(asset.path)!;
          if (
            !owned.has(asset.hash) ||
            !(await (deps.verified ?? verifiedBlob)(
              job.plan.targets.blossom,
              asset.hash,
              bytes.length,
              options.signal,
            ))
          )
            await (deps.upload ?? uploadBlob)({
              origin: job.plan.targets.blossom,
              bytes,
              type: asset.mime,
              signer: signer!,
              local: options.network === 'local',
              signal: options.signal,
            });
          job.receipts.assets = { ...job.receipts.assets, [asset.hash]: true };
          await save();
        }
        await guard();
        if (job.preview?.descriptor) {
          progress('descriptor');
          await relays.ensure(job.plan.targets.relay, job.preview.descriptor);
          job.receipts.descriptor = true;
          await save();
        }
        if (job.snapshot) {
          progress('snapshot');
          await relays.ensure(job.plan.targets.relay, job.snapshot);
          job.receipts.snapshot = true;
          await save();
        }
        await guard();
        progress('current');
        await relays.ensure(job.plan.targets.relay, job.current);
        job.receipts.current = true;
        await save();
        await guard();
        // The primary release is complete even if optional copies stall or are interrupted.
        job.status = 'announced_pending_index';
        delete job.error;
        await save();
        await journal.select(null, job.id);
        await copyPublication({
          pubkey: account.pubkey,
          targets: job.plan.targets,
          network: options.network,
          events: [job.preview?.descriptor, job.snapshot, job.current].filter(
            (e): e is SignedEvent => !!e,
          ),
          state: job,
          save,
          signal: options.signal,
          progress: (next) => {
            stage = next;
            options.progress?.(next);
          },
          io: (signal) =>
            deps.relays
              ? {
                  read: relays.read?.bind(relays) ?? (async () => []),
                  ensure: relays.ensure.bind(relays),
                  close() {},
                }
              : new PublicationRelays(signal),
        });
        if (options.signal?.aborted) return result(job, completed);
        progress('website');
        job.website = await (deps.website ?? confirmWebsite)(job, { signal: options.signal });
        await save();
        return result(job, completed);
      } catch (error) {
        // History failures are local preflight failures, not resumable service errors.
        // Keep their precise recovery/context at the diagnostic boundary.
        if (error instanceof SourceHistoryError) throw error;
        const diagnostic = diagnose(error, `publish ${stage}`);
        const safe =
          error instanceof PublishError || error instanceof RepositoryError
            ? error
            : new PublishError(
                diagnostic.code === 'CLI_ERROR' ? 'PUBLISH_FAILED' : diagnostic.code,
                diagnostic.message,
                stage,
                diagnostic.retryable ?? true,
                error,
              );
        if (job) {
          job.error = {
            code: safe.code,
            stage: safe.stage,
            message: redactDiagnostic(
              [safe.message, ...(diagnostic.details ?? [])].join('\n'),
              1000,
            ),
            retryable: safe.retryable,
          };
          try {
            await journal.save(job);
          } catch (saveError) {
            throw new PublishError(
              safe.code,
              safe.message,
              safe.stage,
              safe.retryable,
              new AggregateError(
                [error, saveError],
                'Publication failed and its error could not be saved. Inspect soyli status before retrying.',
              ),
            );
          }
        }
        // Repository errors carry their own recovery; keep it at the diagnostic boundary.
        throw error instanceof RepositoryError ? error : safe;
      }
    });
  } finally {
    await signer?.close();
    relays.close();
  }
}
