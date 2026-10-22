import { diagnose, formatDiagnostic } from '../packages/diagnostics/src';
import { z } from 'zod';
import { Accounts, captureAccount } from '../packages/identity/src/accounts';
import { checkpoint } from '../packages/publish/src/git-source';
import { publicationStatus, type PublishOptions } from '../packages/publish/src';
import { Journal } from '../packages/publish/src/journal';
import { readBinding } from '../packages/publish/src/binding';
import { inspectProject, type PublishPlan } from '../packages/publish/src/project';
import { sha256 } from '../packages/protocol/src';
import { pushSource, type CollaborationOptions } from '../packages/collaboration/src/service';
import { manageProject } from './manager';
import { workingTree, workingDiff } from './workshop-git';
import {
  buildForSharing,
  publishFromProject,
  proposeFromProject,
  prepareSharingIdentity,
} from './share-project';
import { checkPublication } from './publish-check';
import { review } from './review';

const revision = z.string().regex(/^[a-f0-9]{64}$/);
const actionSchema = z.discriminatedUnion('action', [
  z
    .object({
      action: z.literal('checkpoint'),
      revision,
      message: z.string().trim().min(1).max(500),
    })
    .strict(),
  z.object({ action: z.literal('check'), revision }).strict(),
  z.object({ action: z.literal('publish'), revision }).strict(),
  z.object({ action: z.literal('resume'), revision, jobId: z.string().min(1).max(128) }).strict(),
  z
    .object({
      action: z.literal('propose'),
      revision,
      description: z.string().trim().min(1).max(4000),
      resume: z.boolean().default(false),
    })
    .strict(),
  z.object({ action: z.literal('push'), revision }).strict(),
  z.object({ action: z.literal('review') }).strict(),
]);
type Job = {
  id: string;
  action: string;
  state: 'running' | 'done' | 'failed';
  stage: string;
  error?: string;
  result?: unknown;
};
type Prepared = {
  revision: string;
  fingerprint: string;
  plan: PublishPlan;
  profile: string;
  browser: string;
  cover: boolean;
  video: boolean;
};
export type WorkshopOptions = CollaborationOptions & {
  pauseBuilds?: () => Promise<() => Promise<void>>;
  // Same production boundary as the publisher; test fixtures can supply their own check browser.
  check?: PublishOptions['check'];
};

/** Local-only UI adapter. All public writes still use the CLI's Nostr/Git/Blossom services. */
export function createWorkshop(options: WorkshopOptions) {
  const accounts = options.accounts ?? new Accounts(options.network);
  const controller = new AbortController();
  const signal = options.signal
    ? AbortSignal.any([options.signal, controller.signal])
    : controller.signal;
  const context = { ...options, accounts, signal };
  let busy = false,
    job: Job | undefined,
    prepared: Prepared | undefined;
  let running: Promise<void> | undefined, reviewTask: Promise<void> | undefined;
  let reviewUrl: string | undefined,
    reviewKey: string | undefined,
    reviewController: AbortController | undefined;
  let checkedMedia: { preview?: Uint8Array; video?: Uint8Array } = {};
  let checkedResult: Awaited<ReturnType<PublishOptions['check']>> | undefined;
  let checkedContents: string | undefined;
  const contentHash = async (contents: Map<string, Uint8Array>) =>
    sha256(
      JSON.stringify(
        await Promise.all(
          [...contents]
            .sort(([a], [b]) => a.localeCompare(b))
            .map(async ([path, bytes]) => [path, await sha256(bytes)]),
        ),
      ),
    );
  const check =
    options.check ?? ((contents) => checkPublication(contents, false, undefined, false, signal));
  async function snapshot(selectedAccounts = accounts) {
    const account = await selectedAccounts.current();
    const [tree, project, binding, publication, index] = await Promise.all([
      workingTree(options.directory),
      manageProject(options.directory, options.network),
      readBinding(options.directory),
      publicationStatus(options.directory, options.network, { creator: account?.pubkey }),
      new Journal(options.directory, options.network, account?.pubkey).index(),
    ]);
    // Only public account data crosses the local HTTP boundary.
    const identity = account ? { pubkey: account.pubkey, type: account.type } : null;
    const key = await sha256(
      JSON.stringify({
        tree: tree.revision,
        project: project.revision,
        identity: identity?.pubkey ?? null,
      }),
    );
    return {
      revision: key,
      tree,
      identity,
      project,
      upstream: binding?.upstream?.address ?? null,
      publication,
      pendingJob: index.active,
      prepared: prepared?.revision === key ? prepared : null,
      job,
      busy,
    };
  }
  async function exclusive() {
    if (busy) throw new Error('Another workshop action is running. Wait for it to finish.');
    signal.throwIfAborted();
    busy = true;
    try {
      const resume = await options.pauseBuilds?.();
      return async () => {
        try {
          await resume?.();
        } finally {
          busy = false;
        }
      };
    } catch (error) {
      busy = false;
      throw error;
    }
  }
  async function openReview(origin: string) {
    const current = await snapshot();
    const key = JSON.stringify({
      identity: current.identity,
      upstream: current.upstream,
      targets: current.project.targets,
    });
    if (reviewUrl && reviewKey === key) return { url: reviewUrl };
    reviewController?.abort();
    await reviewTask;
    reviewController = new AbortController();
    return new Promise<{ url: string }>((resolve, reject) => {
      reviewTask = review({
        ...context,
        signal: AbortSignal.any([signal, reviewController!.signal]),
        noOpen: true,
        embedOrigin: origin,
        beforeAction: async () => {
          prepared = undefined;
          return exclusive();
        },
        ready: async ({ url }) => {
          reviewUrl = url;
          reviewKey = key;
          resolve({ url });
        },
      }).catch(reject);
    });
  }
  async function execute(action: z.infer<typeof actionSchema>, origin: string) {
    if (action.action === 'review') return openReview(origin);
    const selectedAccounts = await captureAccount(accounts);
    const selectedContext = { ...context, accounts: selectedAccounts };
    const state = await snapshot(selectedAccounts);
    if (state.revision !== action.revision)
      throw new Error('Project or identity changed. Reload before continuing; nothing was sent.');
    const progress = (stage: string) => {
      if (job) job.stage = stage;
    };
    if (action.action === 'checkpoint') {
      prepared = undefined;
      return checkpoint(options.directory, action.message, state.identity?.pubkey);
    }
    if (action.action === 'check') {
      prepared = undefined;
      if (!state.identity)
        throw new Error(
          'Choose a creator in the terminal with soyli account create, connect or use.',
        );
      progress('Building the committed source');
      await prepareSharingIdentity(options.directory, options.network, state.identity.pubkey);
      const preparedState = await snapshot(selectedAccounts);
      await buildForSharing(options.directory, signal);
      const inspected = await inspectProject(
        options.directory,
        options.network,
        state.identity.pubkey,
      );
      progress('Checking startup and presentation');
      const checked = await check(inspected.contents);
      if ((await snapshot(selectedAccounts)).revision !== preparedState.revision)
        throw new Error('Files changed during the check. Check the new revision before sharing.');
      prepared = {
        revision: preparedState.revision,
        fingerprint: inspected.fingerprint,
        plan: inspected.plan,
        profile: checked.profile,
        browser: checked.browser,
        cover: !!checked.preview,
        video: !!checked.video,
      };
      checkedMedia = { preview: checked.preview, video: checked.video };
      checkedResult = checked;
      checkedContents = await contentHash(inspected.contents);
      return { status: 'checked', ...prepared };
    }
    if (action.action === 'resume') {
      if (state.pendingJob !== action.jobId)
        throw new Error('The pending release changed. Reload its details before retrying.');
      return publishFromProject({
        ...selectedContext,
        resume: true,
        requirePreview: true,
        check,
        progress,
      });
    }
    if (action.action === 'publish') {
      if (!prepared || prepared.revision !== action.revision)
        throw new Error('Build and check this revision before publishing.');
      const reviewed = prepared;
      // Guard even the unchanged/pending publisher path, which skips the summary callback.
      const inspected = await inspectProject(
        options.directory,
        options.network,
        state.identity!.pubkey,
      );
      if (inspected.fingerprint !== reviewed.fingerprint)
        throw new Error('The built files changed. Build and check again.');
      const result = checkedResult,
        fingerprint = checkedContents;
      return publishFromProject({
        ...selectedContext,
        requirePreview: true,
        progress,
        check: async (contents) => {
          if (!result || (await contentHash(contents)) !== fingerprint)
            throw new Error('Checked source changed. Build and check again.');
          return result;
        },
        summary: (plan) => {
          if (JSON.stringify(plan) !== JSON.stringify(reviewed.plan))
            throw new Error('Build or destinations changed. Check again before publishing.');
        },
      });
    }
    prepared = undefined;
    if (action.action === 'propose')
      return proposeFromProject({
        ...selectedContext,
        description: action.description,
        resume: action.resume,
        check,
      });
    return pushSource(selectedContext);
  }
  return {
    get busy() {
      return busy;
    },
    snapshot,
    diff: (revision: string, path: string) => workingDiff(options.directory, revision, path),
    media: (kind: 'preview' | 'video') => checkedMedia[kind],
    /** Hold the same in-process gate for editor saves, capture and embedded review actions. */
    async edit<T>(fn: () => Promise<T>) {
      const release = await exclusive();
      try {
        prepared = undefined;
        return await fn();
      } finally {
        await release();
      }
    },
    async start(input: unknown, origin: string) {
      const parsed = actionSchema.safeParse(input);
      if (!parsed.success) throw new Error('Invalid workshop action.');
      // Review startup is read-only; review mutations acquire the shared gate themselves.
      const release = await exclusive();
      job = {
        id: crypto.randomUUID(),
        action: parsed.data.action,
        state: 'running',
        stage: 'Starting…',
      };
      const selected = job;
      running = (async () => {
        try {
          selected.result = await execute(parsed.data, origin);
          selected.state = 'done';
          selected.stage = 'Done';
        } catch (error) {
          selected.state = 'failed';
          selected.error = formatDiagnostic(diagnose(error, `workshop ${selected.action}`));
        } finally {
          try {
            await release();
          } catch (error) {
            selected.state = 'failed';
            selected.error = [
              selected.error,
              formatDiagnostic(diagnose(error, 'restart build watcher')),
            ]
              .filter(Boolean)
              .join('\n');
          }
        }
      })();
      return { ...selected };
    },
    async close() {
      controller.abort();
      reviewController?.abort();
      await Promise.allSettled([running, reviewTask]);
    },
  };
}
export type Workshop = ReturnType<typeof createWorkshop>;
export type WorkshopState = Awaited<ReturnType<Workshop['snapshot']>>;
