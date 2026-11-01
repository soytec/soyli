import { videoInfoSchema, MAX_VIDEO_BYTES } from '../../protocol/src/preview-video';
import { Database } from 'bun:sqlite';
import { constants } from 'node:fs';
import { chmod, lstat, mkdir, open, rename, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import { eventSchema } from '../../protocol/src';
import { remixSchema } from '../../protocol/src/remix';
import type { Network } from '../../identity/src/signer';
import { PublishError, targetsSchema, intentSchema } from './config';
import { MAX_SOURCE_FILES, MAX_PUBLICATION_JOURNAL_BYTES } from './limits';
import { checkReportSchema } from './check-report';
import {
  MANIFEST_PRESENTATION_PROFILE,
  manifestScreenshots,
  manifestPreviewVideo,
} from '../../protocol/src/presentation';

const hash = z.string().regex(/^[a-f0-9]{64}$/);
import {
  copyErrorSchema as copyError,
  outboxSchema,
  copyHistorySchema,
} from '../../nostr/src/publication-copies';
const commit = z.string().regex(/^[a-f0-9]{40}$/);
const planSchema = z
  .object({
    network: z.enum(['public', 'local']),
    pubkey: hash,
    identifier: z.string().max(13),
    title: z.string().max(160),
    description: z.string().max(1000),
    license: z.string().max(100),
    requires: z.array(z.string().max(40)).max(32),
    topics: z.array(z.string().max(256)).max(32),
    servers: z.array(z.string().max(256)).max(9),
    targets: targetsSchema,
    files: z
      .array(
        z
          .object({
            path: z.string().max(200),
            hash,
            size: z
              .number()
              .int()
              .nonnegative()
              .max(40 * 1024 * 1024),
          })
          .strict(),
      )
      .max(MAX_SOURCE_FILES),
    artifactHash: hash,
    sourceBytes: z
      .number()
      .int()
      .nonnegative()
      .max(40 * 1024 * 1024),
    sourceCommit: commit,
    remix: remixSchema.optional(),
    manifestFormat: z.literal('standalone').optional(),
    optionalDomains: z.array(z.string().max(40)).max(32).optional(),
    archetypes: z.array(z.string().max(80)).max(32).optional(),
    intents: z.array(intentSchema).max(32).optional(),
    icon: z
      .object({
        file: z.string().max(200),
        hash,
        bytes: z
          .number()
          .int()
          .positive()
          .max(5 * 1024 * 1024),
        mime: z.enum(['image/png', 'image/jpeg', 'image/webp']),
      })
      .strict()
      .optional(),
  })
  .strict();
export const jobSchema = z
  .object({
    version: z.literal(1),
    // Absent on previously frozen jobs: resume their original linked descriptor.
    presentationProfile: z.literal(MANIFEST_PRESENTATION_PROFILE).optional(),
    id: hash,
    fingerprint: hash,
    // Absent in older journals: preserve their automatically paired publication.
    snapshotMode: z.enum(['none', 'explicit']).optional(),
    plan: planSchema,
    createdAt: z.number().int().nonnegative(),
    parent: hash.nullable(),
    baseCurrent: hash.nullable(),
    baseSource: hash.nullable(),
    sourceBaseCommit: commit.nullable(),
    baseAnnouncement: hash.nullable(),
    repositoryAnnouncement: eventSchema.optional(),
    // The creator's own NIP-34 repository. Present only when soyLI does not host the source.
    repository: z
      .object({
        address: z.string().max(400),
        origin: z.string().max(300),
        relays: z.array(z.string().max(256)).max(8),
        clones: z.array(z.string().max(512)).max(8),
        source: z.string().max(1200),
      })
      .strict()
      .optional(),
    commit,
    archiveHash: hash,
    archiveBytes: z
      .number()
      .int()
      .nonnegative()
      .max(50 * 1024 * 1024),
    check: checkReportSchema,
    releaseRefs: z.record(z.string().regex(/^refs\/tags\/release-[a-f0-9]{16}$/), commit),
    appliedStatuses: z.array(eventSchema).max(100).optional(),
    appliedBranch: z.string().min(1).max(1024).optional(),
    source: z.object({ announcement: eventSchema, state: eventSchema }).optional(),
    snapshot: eventSchema.optional(),
    current: eventSchema.optional(),
    preview: z
      .object({
        hash,
        bytes: z
          .number()
          .int()
          .positive()
          .max(5 * 1024 * 1024),
        descriptor: eventSchema.optional(),
      })
      .strict()
      .optional(),
    video: videoInfoSchema
      .extend({ hash, bytes: z.number().int().positive().max(MAX_VIDEO_BYTES) })
      .optional(),
    receipts: z
      .object({
        assets: z.record(hash, z.boolean()).optional(),
        preview: z.boolean().optional(),
        video: z.boolean().optional(),
        icon: z.boolean().optional(),
        descriptor: z.boolean().optional(),
        source: z.boolean(),
        artifact: z.boolean(),
        archive: z.boolean(),
        snapshot: z.boolean(),
        current: z.boolean(),
      })
      .strict(),
    mirrors: z.record(z.string(), z.boolean()),
    mirrorErrors: z.record(z.string(), copyError).optional(),
    // Recomputed on each publish run from the creator's current NIP-65 relay list.
    outbox: outboxSchema.optional(),
    // Cumulative attempted destinations, including partial failures and retired write relays.
    outboxHistory: copyHistorySchema.optional(),
    status: z.enum(['prepared', 'announced_pending_index']),
    website: z
      .object({
        checkedAt: z.number().int().nonnegative(),
        ready: z.boolean(),
        reason: z.enum(['ready', 'pending', 'unavailable', 'superseded']),
      })
      .strict()
      .optional(),
    error: z
      .object({
        code: z.string().max(80),
        stage: z.string().max(40),
        message: z.string().max(1000),
        retryable: z.boolean(),
      })
      .optional(),
  })
  .strict()
  .refine(
    (job) => job.snapshotMode !== 'none' || (!job.snapshot && !job.receipts.snapshot),
    'Named-only jobs cannot contain a snapshot or snapshot acknowledgement',
  )
  .refine(
    (job) =>
      job.status !== 'announced_pending_index' ||
      ((!job.plan.icon || job.receipts.icon === true) &&
        (!job.video || (!!job.preview && job.receipts.video === true)) &&
        (!!job.source || !!job.repository) &&
        !!job.current &&
        (job.snapshotMode === 'none' || !!job.snapshot) &&
        (!job.preview ||
          (job.receipts.preview === true &&
            (job.presentationProfile === MANIFEST_PRESENTATION_PROFILE
              ? !job.preview.descriptor &&
                [job.current, ...(job.snapshotMode === 'none' ? [] : [job.snapshot])].every(
                  (event) =>
                    !!event &&
                    manifestScreenshots(event).some(
                      (c) => c.hash === job.preview!.hash && c.mime === 'image/png',
                    ),
                )
              : !!job.preview.descriptor && job.receipts.descriptor === true))) &&
        (!job.video ||
          job.presentationProfile !== MANIFEST_PRESENTATION_PROFILE ||
          [job.current, ...(job.snapshotMode === 'none' ? [] : [job.snapshot])].every(
            (event) => !!event && manifestPreviewVideo(event)?.hash === job.video!.hash,
          )) &&
        Object.entries(job.receipts).every(([kind, accepted]) =>
          kind === 'snapshot' && job.snapshotMode === 'none' ? !accepted : accepted,
        )),
    'Completed jobs require all publication evidence',
  );
export type PublishJob = z.infer<typeof jobSchema>;
const indexSchema = z
  .object({
    version: z.literal(1),
    active: hash.nullable(),
    latest: hash.nullable(),
    creators: z
      .record(hash, z.object({ active: hash.nullable(), latest: hash.nullable() }).strict())
      .optional(),
  })
  .strict();

async function safeDirectory(path: string) {
  await mkdir(path, { recursive: false, mode: 0o700 }).catch((error) => {
    if (error.code !== 'EEXIST') throw error;
  });
  const stat = await lstat(path);
  if (!stat.isDirectory() || stat.isSymbolicLink())
    throw new PublishError(
      'JOURNAL_PATH',
      'Publication state must be a private regular directory.',
    );
}
export async function readJson(path: string) {
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = await file.stat();
    if (!stat.isFile() || stat.size > MAX_PUBLICATION_JOURNAL_BYTES) throw new Error();
    const bytes = await file.readFile();
    if (bytes.length > MAX_PUBLICATION_JOURNAL_BYTES) throw new Error();
    return JSON.parse(bytes.toString('utf8'));
  } finally {
    await file.close();
  }
}
export async function atomicJson(path: string, value: unknown) {
  const temporary = `${path}.${crypto.randomUUID()}.tmp`;
  const file = await open(temporary, 'wx', 0o600);
  try {
    await file.writeFile(JSON.stringify(value, null, 2) + '\n');
    await file.sync();
    await file.close();
    await rename(temporary, path);
    const directory = await open(join(path, '..'), 'r');
    try {
      await directory.sync();
    } finally {
      await directory.close();
    }
  } finally {
    await file.close();
    await rm(temporary, { force: true });
  }
}
export class Journal {
  readonly root: string;
  constructor(
    directory: string,
    readonly network: Network,
    readonly creator?: string,
  ) {
    this.root = join(directory, '.napplet-space', network);
    if (creator) hash.parse(creator);
  }
  directory(id: string) {
    return join(this.root, hash.parse(id));
  }
  private async readIndex() {
    try {
      return indexSchema.parse(await readJson(join(this.root, 'index.json')));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT')
        return { version: 1 as const, active: null, latest: null, creators: undefined };
      throw new PublishError(
        'JOURNAL_INVALID',
        'Publication index is damaged. Restore its backup; it was not overwritten.',
      );
    }
  }
  private async histories() {
    const index = await this.readIndex();
    const creators = { ...index.creators };
    // Import the legacy pointer without moving or deleting any saved release.
    for (const field of ['active', 'latest'] as const) {
      const id = index[field];
      if (!id) continue;
      const pubkey = (await this.load(id)).plan.pubkey;
      creators[pubkey] ??= { active: null, latest: null };
      creators[pubkey][field] = id;
    }
    return { ...index, creators };
  }
  async index() {
    const index = await this.histories();
    if (!this.creator) return index;
    const selected = index.creators[this.creator] ?? { active: null, latest: null };
    for (const id of [selected.active, selected.latest])
      if (id && (await this.load(id)).plan.pubkey !== this.creator)
        throw new PublishError(
          'JOURNAL_INVALID',
          'Saved publication history does not match its creator. Nothing was changed.',
        );
    return { ...index, ...selected };
  }
  async load(id: string) {
    try {
      if ((await lstat(this.directory(id))).isSymbolicLink()) throw new Error();
      const job = jobSchema.parse(await readJson(join(this.directory(id), 'job.json')));
      if (
        job.id !== id ||
        job.plan.network !== this.network ||
        Object.keys(job.releaseRefs).length > 128
      )
        throw new Error();
      return job;
    } catch {
      throw new PublishError(
        'JOURNAL_INVALID',
        'Saved publication is missing or damaged. Restore the journal backup before retrying.',
      );
    }
  }
  async save(job: PublishJob) {
    await atomicJson(join(this.directory(job.id), 'job.json'), jobSchema.parse(job));
  }
  async select(active: string | null, latest: string | null) {
    const index = await this.histories();
    const id = active ?? latest;
    const pubkey = this.creator ?? (id ? (await this.load(id)).plan.pubkey : undefined);
    if (pubkey) {
      for (const jobId of [active, latest])
        if (jobId && (await this.load(jobId)).plan.pubkey !== pubkey)
          throw new PublishError(
            'JOURNAL_INVALID',
            'Cannot mix different creators in a publication history.',
          );
      index.creators[pubkey] = { active, latest };
    }
    await atomicJson(
      join(this.root, 'index.json'),
      indexSchema.parse({ version: 1, active, latest, creators: index.creators }),
    );
  }
  async lock<T>(fn: () => Promise<T>) {
    const parent = join(this.root, '..');
    await safeDirectory(parent);
    await safeDirectory(this.root);
    const path = join(parent, 'publish-lock.sqlite');
    if ((await lstat(path).catch(() => null))?.isSymbolicLink())
      throw new PublishError('JOURNAL_PATH', 'Publication lock cannot be a symlink.');
    const lock = new Database(path, { create: true });
    try {
      await chmod(path, 0o600);
      try {
        lock.exec('PRAGMA busy_timeout=0; BEGIN EXCLUSIVE');
      } catch {
        throw new PublishError(
          'PUBLISH_BUSY',
          'Another publication is running in this project. Retry when it finishes.',
          'check',
          true,
        );
      }
      return await fn();
    } finally {
      lock.close();
    }
  }
}
