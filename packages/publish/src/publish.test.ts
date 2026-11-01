import { ProtocolClient } from '../../client/src/nostr';
import { publicationDestinations } from '../../nostr/src/publication-copies';
import {
  planLifecycle,
  createLifecycleReceipt,
  executeLifecycle,
  lifecycleFinished,
  parseReceipt,
} from '../../lifecycle/src';
import { migrationTemplate } from '../../migration/src';
import {
  MANIFEST_PRESENTATION_PROFILE,
  manifestScreenshotSources,
  manifestVideoSources,
} from '../../protocol/src/presentation';
import { importAsset, readAssets, validateAssets } from '../../assets/src';
import { createRemix } from '../../remix/src';
import { sourceArchive } from '../../remix/src/archive';
import { expect, test } from 'bun:test';
import { mkdtemp, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Accounts, type Vault } from '../../identity/src/accounts';
import {
  encodeAddress,
  sha256,
  validateRelease,
  verifiedEvent,
  type SignedEvent,
} from '../../protocol/src';
import {
  finalizeEvent,
  generateSecretKey,
  getPublicKey,
  matchFilter,
  matchFilters,
  nip19,
} from 'nostr-tools';
import { DiagnosticError } from '../../diagnostics/src';
import { validateManifest } from '../../protocol/src/manifest';
import { sourceGit, sourceUrls } from '../../grasp/src/client';
import {
  publishProject as publishCommitted,
  publicationStatus,
  type PublishOptions,
} from './index';
import { Journal, readJson } from './journal';
import { MAX_PUBLICATION_JOURNAL_BYTES } from './limits';
import { projectSchema } from './config';
import { newer } from './relay';
import { appReferences, descriptorImages } from '../../protocol/src/preview';
import { writeBinding } from './binding';
import { inspectProject } from './project';

// Existing publication cases explicitly checkpoint fixture edits before sharing.
async function publishProject(options: PublishOptions) {
  if (!options.resume && !options.dryRun) {
    await sourceGit(options.directory, ['init', '--initial-branch=main']);
    await Bun.write(join(options.directory, '.git/info/exclude'), '.napplet-space/\n');
    await sourceGit(options.directory, ['add', '--all', '--', '.']);
    if (await sourceGit(options.directory, ['status', '--porcelain']))
      await sourceGit(options.directory, ['commit', '-m', 'Fixture checkpoint']);
  }
  return publishCommitted(options);
}
const previewPng = new Uint8Array(
  Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/lS8AAAAASUVORK5CYII=',
    'base64',
  ),
);

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'napplet-publish-'));
  const project = join(root, 'project');
  const config = {
    schema: 'space-local-project/v1',
    name: 'first creation',
    previewId: crypto.randomUUID(),
    entry: 'index.html',
    license: 'MIT',
    topics: ['#Visual'],
    requires: [],
    relays: [],
    servers: [],
  };
  await Bun.write(join(project, 'napplet.json'), JSON.stringify(config));
  await Bun.write(join(project, 'index.html'), '<!doctype html><title>One</title><p>One</p>');
  await Bun.write(join(project, 'LICENSE'), 'MIT license');
  const secrets = new Map<string, string>();
  const vault: Vault = {
    get: async (id) => secrets.get(id) ?? null,
    set: async (id, value) => {
      secrets.set(id, value);
    },
    delete: async (id) => {
      secrets.delete(id);
    },
  };
  const accounts = new Accounts('local', join(root, 'accounts'), vault);
  const creator = await accounts.create();
  const events = new Map<string, SignedEvent[]>();
  const blobs = new Map<string, Uint8Array>();
  const writes: string[] = [];
  const record = (url: string, input: SignedEvent) => {
    const event = verifiedEvent(input),
      rows = events.get(url) ?? [];
    if (!rows.some((e) => e.id === event.id)) {
      rows.push(event);
      writes.push(event.id);
    }
    events.set(url, rows);
  };
  const latest = async (url: string, pubkey: string, identifier: string, kind: number) =>
    (events.get(url) ?? [])
      .filter(
        (e) =>
          e.pubkey === pubkey &&
          e.kind === kind &&
          e.tags.some((t) => t[0] === 'd' && t[1] === identifier),
      )
      .reduce<SignedEvent | null>((best, e) => (!best || newer(e, best) ? e : best), null);
  const deps: NonNullable<PublishOptions['dependencies']> = {
    proposalClient: Object.assign(new ProtocolClient(() => []), { query: async () => [] }),
    website: async () => ({ checkedAt: Date.now(), ready: false, reason: 'pending' }),
    relays: {
      latest,
      ensure: async (url, event) => {
        record(url, event);
      },
      close() {},
    },
    source: async (input) => {
      const urls = sourceUrls(
        input.origin,
        input.publication.state.pubkey,
        input.publication.state.tags.find((t) => t[0] === 'd')![1],
        input.local,
      );
      record(urls.relay, input.publication.announcement);
      record(urls.relay, input.publication.state);
      return {
        ...input.publication,
        ...urls,
        commit: input.publication.state.tags.find((t) => t[0] === 'refs/heads/main')![1],
        refs: [],
        changed: true,
      };
    },
    owned: async () => new Set(blobs.keys()),
    verified: async (_origin, hash, length) =>
      blobs.get(hash)?.length === length && (await sha256(blobs.get(hash)!)) === hash,
    upload: async ({ bytes, origin, type }) => {
      const hash = await sha256(bytes);
      blobs.set(hash, bytes);
      writes.push(hash);
      return {
        descriptor: {
          sha256: hash,
          size: bytes.length,
          type,
          uploaded: 1,
          url: `${origin}/${hash}.bin`,
        },
        created: true,
      };
    },
  };
  const options: PublishOptions = {
    directory: project,
    network: 'local',
    accounts,
    check: async () => ({ profile: 'test', browser: 'test' }),
    snapshot: true, // These historical paired-publication cases opt into the extra copy.
    dependencies: deps,
  };
  const journal = new Journal(project, 'local');
  const load = async () => {
    const index = await journal.index();
    return journal.load((index.active ?? index.latest)!);
  };
  return {
    root,
    project,
    config,
    accounts,
    creator,
    events,
    blobs,
    writes,
    record,
    deps,
    options,
    journal,
    load,
    close: () => rm(root, { recursive: true, force: true }),
  };
}
test('large valid publication journals round-trip without exceeding the bounded reader', async () => {
  const f = await fixture();
  try {
    await publishProject(f.options);
    const job = await f.load();
    const directory = Array(4).fill('界'.repeat(40)).join('/');
    job.plan.files = Array.from({ length: 1024 }, (_, i) => ({
      path: `${directory}/${i}.ts`,
      hash: 'a'.repeat(64),
      size: 1,
    }));
    job.plan.sourceBytes = 1024;
    expect(Buffer.byteLength(JSON.stringify(job, null, 2))).toBeGreaterThan(512 * 1024);
    await f.journal.save(job);
    expect((await f.journal.load(job.id)).plan.files).toEqual(job.plan.files);
    job.plan.files.push({ path: 'overflow.ts', hash: 'b'.repeat(64), size: 1 });
    await expect(f.journal.save(job)).rejects.toThrow();
    const excessive = join(f.root, 'excessive.json');
    await Bun.write(excessive, ' '.repeat(MAX_PUBLICATION_JOURNAL_BYTES + 1));
    await expect(readJson(excessive)).rejects.toThrow();
  } finally {
    await f.close();
  }
});

test('publication journals retain check coverage and warnings across resume', async () => {
  const f = await fixture();
  try {
    const check = {
      profile: 'test',
      browser: 'test',
      coverage: {
        startup: 'passed' as const,
        interaction: { status: 'not-run' as const, actions: 0 },
        mediaCoordination: 'not-verified' as const,
        independentHost: 'not-run' as const,
      },
      warnings: ['Interaction not measured.'],
    };
    await publishProject({ ...f.options, check: async () => check });
    expect((await f.load()).check).toEqual(check);
    await publishProject({
      ...f.options,
      resume: true,
      check: async () => {
        throw new Error('Must reuse frozen evidence');
      },
    });
    expect((await f.load()).check).toEqual(check);
  } finally {
    await f.close();
  }
});

test('explicit additive source selections share the 1024-file bound', async () => {
  const f = await fixture();
  try {
    const files = Array.from({ length: 1024 }, (_, i) => `${i}.ts`);
    expect(projectSchema.safeParse({ ...f.config, publish: { files } }).success).toBe(true);
    expect(
      projectSchema.safeParse({ ...f.config, publish: { files: [...files, 'extra.ts'] } }).success,
    ).toBe(false);
  } finally {
    await f.close();
  }
});

test('an unpublished draft follows the selected creator instead of forcing its scaffold identity', async () => {
  const f = await fixture();
  try {
    await writeBinding(f.project, {
      version: 1,
      project: { creator: { pubkey: f.creator.pubkey, network: 'local' } },
    });
    const selected = await f.accounts.create({ fresh: true });
    const dry = await publishProject({ ...f.options, dryRun: true });
    expect(dry.status === 'dry_run' && dry.plan.pubkey).toBe(selected.pubkey);
    await publishProject(f.options);
    expect((await f.load()).plan.pubkey).toBe(selected.pubkey);
    expect((await f.accounts.current())?.id).toBe(selected.id);
  } finally {
    await f.close();
  }
});

test('publishing removed legacy backend context preserves exact Git ancestry and dry-run checks it', async () => {
  const f = await fixture();
  try {
    const path = '.napplet-space/soy-backend.json';
    await sourceGit(f.project, ['init']);
    await Bun.write(
      join(f.project, path),
      JSON.stringify(
        {
          version: 1,
          napplet: encodeAddress({ kind: 35129, pubkey: f.creator.pubkey, identifier: 'legacy' }),
          provider: { pubkey: 'b'.repeat(64), relays: ['wss://relay.example.com/'] },
          boards: [],
          modules: ['world'],
        },
        null,
        2,
      ),
    );
    await sourceGit(f.project, ['add', '.']);
    await sourceGit(f.project, ['commit', '-m', 'Old public context']);
    const old = await sourceGit(f.project, ['rev-parse', 'HEAD']);
    const blob = await sourceGit(f.project, ['rev-parse', `HEAD:${path}`]);
    await sourceGit(f.project, ['rm', path]);
    await Bun.write(join(f.project, '.gitignore'), '.napplet-space/\n');
    await sourceGit(f.project, ['add', '.']);
    await sourceGit(f.project, ['commit', '-m', 'Upgrade public context guidance']);
    const head = await sourceGit(f.project, ['rev-parse', 'HEAD']);
    const dry = await publishCommitted({ ...f.options, dryRun: true });
    expect(dry).toMatchObject({
      status: 'dry_run',
      sourceHistory: {
        status: 'checked',
        commit: head,
        legacyPublicContexts: [{ path, object: blob, commit: old }],
      },
    });
    expect(f.writes).toEqual([]);
    const result = await publishCommitted(f.options);
    expect(result).toMatchObject({ status: 'announced_pending_index', sourceCommit: head });
    const job = await f.load();
    const source = join(f.journal.directory(job.id), 'source');
    expect(await sourceGit(source, ['rev-parse', 'HEAD'])).toBe(head);
    expect(await sourceGit(source, ['rev-parse', `${old}:${path}`])).toBe(blob);
    expect(await sourceGit(source, ['ls-tree', '-r', '--name-only', 'HEAD'])).not.toContain(path);
    expect(job.plan.files.some((file) => file.path === path)).toBe(false);
  } finally {
    await f.close();
  }
});

test('dry-run and publication reject private history before sandbox or network work', async () => {
  const f = await fixture();
  try {
    await sourceGit(f.project, ['init']);
    await Bun.write(join(f.project, '.env'), 'PRIVATE=fixture-do-not-print');
    await sourceGit(f.project, ['add', '.']);
    await sourceGit(f.project, ['commit', '-m', 'Private historical file']);
    await sourceGit(f.project, ['rm', '.env']);
    await Bun.write(join(f.project, '.gitignore'), '.napplet-space/\n.env\n');
    await sourceGit(f.project, ['add', '.']);
    await sourceGit(f.project, ['commit', '-m', 'Removed from current tree']);
    f.options.check = async () => {
      throw new Error('must not run sandbox');
    };
    f.deps.relays!.latest = async () => {
      throw new Error('must not query relays');
    };
    f.options.accounts = {
      current: () => f.accounts.current(),
      signer: async () => {
        throw new Error('must not sign');
      },
    };
    for (const dryRun of [true, false])
      await expect(publishCommitted({ ...f.options, dryRun })).rejects.toMatchObject({
        code: 'SOURCE_SECRET',
        retryable: false,
        context: {
          operation: 'inspect public Git history',
          recovery: expect.stringContaining('history cleanup'),
        },
      });
    expect(f.writes).toEqual([]);
    expect(await publicationStatus(f.project, 'local')).toEqual({ status: 'not_started' });
  } finally {
    await f.close();
  }
});
test('an in-flight publication keeps its selected account without resetting a later global selection', async () => {
  const f = await fixture();
  try {
    let replacement: string | undefined;
    await publishProject({
      ...f.options,
      check: async () => {
        replacement = (await f.accounts.create({ fresh: true })).id;
        return { profile: 'test', browser: 'test' };
      },
    });
    expect((await f.load()).plan.pubkey).toBe(f.creator.pubkey);
    expect((await f.accounts.current())?.id).toBe(replacement);
  } finally {
    await f.close();
  }
});
test('switching authors keeps independent histories, including a legacy journal and pending release', async () => {
  const f = await fixture();
  try {
    await publishProject(f.options);
    const first = await f.load();
    // Existing installations have a single-pointer index; preserve it when switching.
    await Bun.write(
      join(f.journal.root, 'index.json'),
      JSON.stringify({ version: 1, active: null, latest: first.id }),
    );
    const other = await f.accounts.create({ fresh: true });
    expect(await publicationStatus(f.project, 'local', { creator: other.pubkey })).toEqual({
      status: 'not_started',
    });
    f.deps.checkpoint = async () => {
      throw new Error('fixture interruption');
    };
    await expect(publishProject(f.options)).rejects.toThrow('fixture interruption');
    const pending = await f.load();
    expect(pending.plan.pubkey).toBe(other.pubkey);
    expect(pending.parent).toBeNull();
    expect(pending.current).toBeUndefined();
    f.deps.checkpoint = undefined;
    await f.accounts.use(f.creator.id);
    expect(await publishProject(f.options)).toMatchObject({
      unchanged: true,
      currentId: first.current!.id,
    });
    await Bun.write(join(f.project, 'index.html'), '<p>Updated original</p>');
    await publishProject(f.options);
    const update = await f.load();
    expect(update.parent).toBe(first.id);
    expect(update.current!.pubkey).toBe(f.creator.pubkey);
    const otherJournal = new Journal(f.project, 'local', other.pubkey);
    expect((await otherJournal.index()).active).toBe(pending.id);
    await f.accounts.use(other.id);
    await publishProject({ ...f.options, resume: true });
    const resumed = await f.load();
    expect(resumed.id).toBe(pending.id);
    expect(resumed.current!.pubkey).toBe(other.pubkey);
    expect(resumed.plan.artifactHash).toBe(first.plan.artifactHash);
    expect(resumed.current!.id).not.toBe(first.current!.id);
    expect((await new Journal(f.project, 'local', f.creator.pubkey).index()).latest).toBe(
      update.id,
    );
    expect((await f.accounts.current())?.id).toBe(other.id);
    expect(await f.accounts.list()).toHaveLength(2);
  } finally {
    await f.close();
  }
}, 15000);
test('publication histories reject pointers belonging to a different author', async () => {
  const f = await fixture();
  try {
    await publishProject(f.options);
    const job = await f.load();
    const other = await f.accounts.create({ fresh: true });
    await Bun.write(
      join(f.journal.root, 'index.json'),
      JSON.stringify({
        version: 1,
        active: null,
        latest: job.id,
        creators: { [other.pubkey]: { active: null, latest: job.id } },
      }),
    );
    await expect(publishProject(f.options)).rejects.toMatchObject({ code: 'JOURNAL_INVALID' });
    expect((await f.accounts.current())?.id).toBe(other.id);
  } finally {
    await f.close();
  }
});
test('managed external assets are uploaded before announcement, resume unchanged and restore from source on remix', async () => {
  const f = await fixture();
  try {
    const asset = await importAsset(f.project, {
      id: 'sprite',
      bytes: previewPng,
      storage: 'external',
      license: 'CC0',
    });
    let interrupted = false;
    f.deps.checkpoint = async (job) => {
      if (job.receipts.assets?.[asset.hash] && !interrupted) {
        interrupted = true;
        throw new Error('Interrupted after asset upload');
      }
    };
    await expect(publishProject(f.options)).rejects.toMatchObject({ code: 'PUBLISH_FAILED' });
    const pending = await f.load();
    expect(pending.receipts.assets?.[asset.hash]).toBe(true);
    expect(pending.receipts.current).toBe(false);
    const result = await publishProject({ ...f.options, resume: true });
    const job = await f.load();
    expect('snapshotId' in result && result.snapshotId).toBe(job.snapshot!.id);
    expect(f.writes.filter((w) => w === asset.hash)).toHaveLength(1);
    const html = f.blobs.get(job.plan.artifactHash)!;
    expect(await sha256(html)).toBe(job.plan.artifactHash);
    expect(new TextDecoder().decode(html)).toContain(
      `href="blossom:${asset.hash}.png?sz=${asset.bytes}"`,
    );
    expect(job.current!.tags).toContainEqual(['x', await sha256(html)]);
    expect(await Bun.file(join(f.project, 'index.html')).text()).not.toContain('rel="related"');
    expect(job.plan.artifactHash).toBe(pending.plan.artifactHash);
    const remix = await createRemix(f.root, 'remixed-assets', {
      manifest: job.snapshot!,
      artifact: f.blobs.get(job.plan.artifactHash)!,
      files: sourceArchive(f.blobs.get(job.archiveHash)!),
    });
    expect((await readAssets(remix.directory)).assets[0].hash).toBe(asset.hash);
    await validateAssets(remix.directory);
    expect(await Bun.file(join(remix.directory, asset.path)).bytes()).toEqual(previewPng);
    const current = job.current!;
    expect(current.tags).toContainEqual(['R', 'resource']);
    expect(current.tags.filter((t) => t[0] === 'path')).toHaveLength(0);
  } finally {
    await f.close();
  }
});
test('preview upload and direct manifest references survive interruption with identical signatures and image bytes', async () => {
  const f = await fixture();
  try {
    f.options.requirePreview = true;
    f.options.check = async () => ({ profile: 'test', browser: 'test', preview: previewPng });
    f.deps.checkpoint = async (job) => {
      if (job.receipts.preview) throw new Error('Crash after preview upload');
    };
    await expect(publishProject(f.options)).rejects.toMatchObject({ code: 'PUBLISH_FAILED' });
    const interrupted = await f.load();
    expect(interrupted.receipts).toMatchObject({
      preview: true,
      snapshot: false,
    });
    expect(f.blobs.get(interrupted.preview!.hash)).toEqual(previewPng);
    expect(appReferences(interrupted.current!)).toEqual([]);
    expect(interrupted.preview!.descriptor).toBeUndefined();
    expect(interrupted.receipts.descriptor).toBeUndefined();
    expect(interrupted.current!.tags).toContainEqual([
      'presentation',
      MANIFEST_PRESENTATION_PROFILE,
    ]);
    expect(manifestScreenshotSources(interrupted.current!).map((c) => c.url)).toEqual([
      `${interrupted.plan.targets.blossom}/${await sha256(previewPng)}`,
    ]);
    delete f.deps.checkpoint;
    f.options.check = async () => {
      throw new Error('Resume must never recapture');
    };
    await publishProject({ ...f.options, resume: true });
    const resumed = await f.load();
    expect(resumed.preview).toEqual(interrupted.preview);
    expect(resumed.current).toEqual(interrupted.current);
    expect(resumed.snapshot).toEqual(interrupted.snapshot);
    expect(resumed.status).toBe('announced_pending_index');
    await Bun.write(join(f.journal.directory(resumed.id), 'preview.png'), 'tampered');
    const before = f.writes.length;
    await expect(publishProject({ ...f.options, resume: true })).rejects.toMatchObject({
      code: 'FROZEN_PREVIEW_CHANGED',
    });
    expect(f.writes.length).toBe(before);
  } finally {
    await f.close();
  }
});

for (const snapshot of [false, true]) {
  test(`${snapshot ? 'paired' : 'named-only'} video upload resumes with exact bytes, manifest references and static cover`, async () => {
    const f = await fixture();
    f.options.snapshot = snapshot;
    try {
      const video = await Bun.file(
        new URL('../../../tests/fixtures/preview.webm', import.meta.url),
      ).bytes();
      f.options.requirePreview = true;
      f.options.check = async () => ({
        profile: 'test',
        browser: 'test',
        preview: previewPng,
        video,
      });
      f.deps.checkpoint = async (job) => {
        if (job.receipts.video && job.receipts.preview)
          throw new Error('Crash after preview uploads');
      };
      await expect(publishProject(f.options)).rejects.toMatchObject({ code: 'PUBLISH_FAILED' });
      const interrupted = await f.load();
      expect(interrupted.receipts).toMatchObject({
        preview: true,
        video: true,
        ...(snapshot ? { snapshot: false } : {}),
      });
      expect(f.blobs.get(interrupted.preview!.hash)).toEqual(previewPng);
      expect(f.blobs.get(interrupted.video!.hash)).toEqual(video);
      expect(
        manifestVideoSources(interrupted.current!).map(({ url, hash }) => ({ url, hash })),
      ).toEqual([
        {
          url: `${interrupted.plan.targets.blossom}/${interrupted.video!.hash}`,
          hash: interrupted.video!.hash,
        },
      ]);
      expect(appReferences(interrupted.current!)).toEqual([]);
      expect(interrupted.preview!.descriptor).toBeUndefined();
      expect(manifestScreenshotSources(interrupted.current!).map((c) => c.url)).toEqual([
        `${interrupted.plan.targets.blossom}/${await sha256(previewPng)}`,
      ]);
      delete f.deps.checkpoint;
      f.options.check = async () => {
        throw new Error('Resume must never recapture');
      };
      await publishProject({ ...f.options, resume: true });
      const resumed = await f.load();
      expect(resumed.preview).toEqual(interrupted.preview);
      expect(resumed.video).toEqual(interrupted.video);
      expect(resumed.current).toEqual(interrupted.current);
      expect(resumed.snapshot).toEqual(interrupted.snapshot);
      expect(resumed.status).toBe('announced_pending_index');
      expect(!!resumed.snapshot).toBe(snapshot);
      expect([...f.events.values()].flat().filter((e) => e.kind === 32267)).toEqual([]);
      await f.journal.save({ ...resumed, video: { ...resumed.video!, width: 959 } });
      await expect(publishProject({ ...f.options, resume: true })).rejects.toMatchObject({
        code: 'FROZEN_PREVIEW_CHANGED',
      });
      await f.journal.save(resumed);
      await Bun.write(join(f.journal.directory(resumed.id), 'preview.webm'), 'tampered');
      const before = f.writes.length;
      await expect(publishProject({ ...f.options, resume: true })).rejects.toMatchObject({
        code: 'FROZEN_PREVIEW_CHANGED',
      });
      expect(f.writes.length).toBe(before);
    } finally {
      await f.close();
    }
  });
}

test('older releases gain a preview without code edits; Blossom can change on a subsequent release', async () => {
  const f = await fixture();
  const publish = async () => {
    const result = await publishProject(f.options);
    if (result.status === 'dry_run') throw new Error('Expected publication');
    return result;
  };
  try {
    const old = await publish();
    f.options.requirePreview = true;
    f.options.check = async () => ({ profile: 'test', browser: 'test', preview: previewPng });
    const upgraded = await publish();
    expect(upgraded.artifactHash).toBe(old.artifactHash);
    expect(upgraded.currentId).not.toBe(old.currentId);
    expect(upgraded.preview!.hash).toBe(await sha256(previewPng));
    expect((await publish()).currentId).toBe(upgraded.currentId);
    await Bun.write(
      join(f.project, 'napplet.json'),
      JSON.stringify({ ...f.config, publish: { blossom: 'http://127.0.0.1:9988' } }),
    );
    const moved = await publish();
    expect(moved.preview!.url).toStartWith('http://127.0.0.1:9988/');
    expect((await f.load()).current!.tags).toContainEqual(['server', 'http://127.0.0.1:9988']);
    expect(moved.creator).toBe(old.creator);
  } finally {
    await f.close();
  }
});

for (const snapshot of [false, true]) {
  test(`${snapshot ? 'paired' : 'named-only'} frozen descriptor jobs resume unchanged, then migrate on an explicit fresh publication`, async () => {
    const f = await fixture();
    f.options.snapshot = snapshot;
    try {
      f.options.check = async () => ({ profile: 'test', browser: 'test', preview: previewPng });
      let interrupted = false;
      f.deps.checkpoint = async (job) => {
        if (!job.source && !interrupted) {
          interrupted = true;
          // Simulate an already frozen job from the prior CLI without editing its files.
          delete job.presentationProfile;
          job.receipts.descriptor = false;
          await f.journal.save(job);
          throw new Error('Old process stopped before signing');
        }
      };
      await expect(publishProject(f.options)).rejects.toMatchObject({ code: 'PUBLISH_FAILED' });
      delete f.deps.checkpoint;
      await publishProject({ ...f.options, resume: true });
      const old = await f.load();
      expect(appReferences(old.current!)[0].kind).toBe(32267);
      expect(descriptorImages(old.preview!.descriptor!)).toHaveLength(1);
      expect(old.receipts.descriptor).toBe(true);
      const signed = old.current;
      await publishProject({ ...f.options, resume: true });
      expect((await f.load()).current).toEqual(signed);
      await publishProject(f.options);
      const fresh = await f.load();
      expect(fresh.presentationProfile).toBe(MANIFEST_PRESENTATION_PROFILE);
      expect(fresh.plan.artifactHash).toBe(old.plan.artifactHash);
      expect(fresh.plan.identifier).toBe(old.plan.identifier);
      expect(fresh.plan.pubkey).toBe(old.plan.pubkey);
      expect(fresh.commit).toBe(old.commit);
      expect(fresh.archiveHash).toBe(old.archiveHash);
      expect(!!fresh.snapshot).toBe(snapshot);
      expect(fresh.current!.id).not.toBe(old.current!.id);
      expect(appReferences(fresh.current!)).toEqual([]);
      expect(fresh.preview!.descriptor).toBeUndefined();
      expect(manifestScreenshotSources(fresh.current!)).toHaveLength(1);
      expect([...f.events.values()].flat().filter((e) => e.kind === 32267)).toHaveLength(1);
    } finally {
      await f.close();
    }
  });
}

test('required preview cannot be silently omitted and a selected missing image fails before publication', async () => {
  const f = await fixture();
  try {
    await expect(publishProject({ ...f.options, requirePreview: true })).rejects.toMatchObject({
      code: 'PREVIEW_REQUIRED',
    });
    expect(f.writes).toHaveLength(0);
    await Bun.write(
      join(f.project, 'napplet.json'),
      JSON.stringify({ ...f.config, preview: { image: 'missing.png' } }),
    );
    await expect(publishProject(f.options)).rejects.toBeDefined();
    expect(f.writes).toHaveLength(0);
  } finally {
    await f.close();
  }
});
test('dry-run inspects explicit source and targets without signing, contacting services or creating a journal', async () => {
  const f = await fixture();
  try {
    f.options.accounts = {
      current: () => f.accounts.current(),
      signer: async () => {
        throw new Error('must not open');
      },
    };
    f.options.check = async () => {
      throw new Error('must not execute');
    };
    f.deps.relays!.latest = async () => {
      throw new Error('must not contact');
    };
    await Bun.write(join(f.project, '.env'), 'PRIVATE=not public');
    const result = await publishProject({ ...f.options, dryRun: true });
    expect(result.status).toBe('dry_run');
    if (result.status !== 'dry_run') throw new Error();
    expect(result.plan.files.map((f) => f.path)).toEqual(['LICENSE', 'index.html', 'napplet.json']);
    expect(result.plan.topics).toEqual(['visual']);
    expect(f.writes).toHaveLength(0);
    expect(await Bun.file(join(f.project, '.napplet-space/local/index.json')).exists()).toBe(false);
    expect(await publicationStatus(f.project, 'local')).toEqual({ status: 'not_started' });
  } finally {
    await f.close();
  }
});
test('standalone remixes keep provenance on snapshots only, never as their own application identity', async () => {
  const f = await fixture();
  try {
    const remix = {
      parent: `35129:${'a'.repeat(64)}:parent`,
      origin: `15129:${'b'.repeat(64)}:`,
      revision: 'c'.repeat(64),
    };
    await Bun.write(join(f.project, 'napplet.json'), JSON.stringify({ ...f.config, remix }));
    await publishProject(f.options);
    const job = await f.load();
    expect(job.current!.tags.filter((t) => t[0] === 'a' || t[0] === 'A')).toEqual([]);
    expect(job.snapshot!.tags.filter((t) => t[0] === 'a')).toEqual([['a', remix.parent]]);
    expect(job.snapshot!.tags.filter((t) => t[0] === 'A')).toEqual([['A', remix.origin]]);
    expect((await publishProject(f.options)).status).toBe('announced_pending_index');
  } finally {
    await f.close();
  }
});
test('confirmed website readiness is journaled after relay receipts, and local status does not contact services', async () => {
  const f = await fixture();
  try {
    f.deps.website = async (job) => {
      expect(Object.values((await f.load()).receipts).every(Boolean)).toBe(true);
      expect(job.current?.id).toBeTruthy();
      expect(job.snapshot?.id).toBeTruthy();
      return { checkedAt: Date.now(), ready: true, reason: 'ready' };
    };
    const published = await publishProject(f.options);
    expect(published.status).toBe('indexed');
    expect(published).toMatchObject({ websiteReady: true, websiteStatus: 'ready' });
    f.deps.website = async () => {
      throw new Error('status must remain local');
    };
    expect(await publicationStatus(f.project, 'local')).toMatchObject({
      status: 'indexed',
      websiteReady: true,
    });
    expect((await f.load()).website?.checkedAt).toBeGreaterThan(0);
  } finally {
    await f.close();
  }
});
test('first publish is standard and retry preserves every signed event, artifact and source commit', async () => {
  const f = await fixture();
  try {
    await sourceGit(f.project, ['init', '--initial-branch=main']);
    await Bun.write(join(f.project, 'earlier-source.txt'), 'Public source history');
    await sourceGit(f.project, ['add', '--', 'earlier-source.txt']);
    await sourceGit(f.project, ['commit', '-m', 'Earlier source work']);
    const first = await publishProject(f.options);
    expect(first.status).toBe('announced_pending_index');
    const job = await f.load();
    const release = await validateRelease(job.current, job.snapshot);
    expect(release.format).toBe('standalone');
    expect(job.current!.content).toBe('first creation');
    expect(
      job.current!.tags.filter((t) => ['path', 'requires', 'description'].includes(t[0])),
    ).toEqual([]);
    expect(job.current!.tags.filter((t) => t[0] === 'x')).toEqual([['x', job.plan.artifactHash]]);
    expect(release.identity.pubkey).toBe(f.creator.pubkey);
    expect(job.current!.tags.filter((t) => t[0] === 't')).toEqual([['t', 'visual']]);
    expect(job.snapshot!.tags.some((t) => t[0] === 'd')).toBe(false);
    expect(job.current!.tags.find((t) => t[0] === 'source')![1]).toStartWith('nostr://');
    const repo = join(f.journal.directory(job.id), 'source');
    expect(await sourceGit(repo, ['rev-list', '--count', 'HEAD'])).toBe('2');
    expect(await sourceGit(repo, ['ls-tree', '-r', '--name-only', 'HEAD'])).toContain(
      'earlier-source',
    );
    const writes = [...f.writes];
    const second = await publishProject(f.options);
    expect(second).toMatchObject({
      unchanged: true,
      sourceCommit: job.commit,
      currentId: job.current!.id,
      snapshotId: job.snapshot!.id,
      websiteReady: false,
    });
    expect(f.writes).toEqual(writes);
  } finally {
    await f.close();
  }
});
test('standalone publication retains optional domains, archetypes, intent parameters and uploaded icon through retries and remixes', async () => {
  const f = await fixture();
  const parameters = ['track', 'mode', ...Array.from({ length: 12 }, (_, i) => `option${i}`)];
  try {
    await Bun.write(join(f.project, 'icon.png'), previewPng);
    await Bun.write(
      join(f.project, 'napplet.json'),
      JSON.stringify({
        ...f.config,
        description: 'A track editor. <b>Plain text, not HTML.</b>',
        requires: ['storage'],
        optionalDomains: ['storage', 'theme', 'future-domain'],
        archetypes: ['track', 'editor'],
        intents: [{ intent: 'napplet:track/edit', parameters }],
        icon: { file: 'icon.png', mime: 'image/png' },
      }),
    );
    await publishProject(f.options);
    const job = await f.load();
    await validateRelease(job.current, job.snapshot);
    const release = await validateManifest(job.current);
    expect(release.description).toBe('A track editor. <b>Plain text, not HTML.</b>');
    expect(release.optionalDomains).toEqual(['theme', 'future-domain']);
    expect(release.archetypes).toEqual(['track', 'editor']);
    expect(release.intents).toEqual([{ intent: 'napplet:track/edit', parameters }]);
    expect(job.current!.tags.find((t) => t[0] === 'i')).toHaveLength(16);
    expect(release.icon).toEqual({ hash: await sha256(previewPng), mime: 'image/png' });
    expect(f.blobs.get(release.icon!.hash)).toEqual(previewPng);
    expect(job.receipts.icon).toBe(true);
    expect(await publishProject({ ...f.options, resume: true })).toMatchObject({
      currentId: job.current!.id,
      snapshotUrl: `${job.plan.targets.site}/r/${job.current!.id}`,
    });
    const remix = await createRemix(f.root, 'metadata-remix', {
      manifest: job.current!,
      artifact: f.blobs.get(job.plan.artifactHash)!,
      files: new Map(),
    });
    const config = projectSchema.parse(
      await Bun.file(join(remix.directory, 'napplet.json')).json(),
    );
    expect(config.description).toBe(release.description);
    expect(config.requires).toEqual(['storage']);
    expect(config.optionalDomains).toEqual(['theme', 'future-domain']);
    expect(config.archetypes).toEqual(release.archetypes);
    expect(config.intents).toEqual(release.intents);
    // An artifact-only remix has no local icon source to falsely claim it retained.
    expect(config.icon).toBeUndefined();
  } finally {
    await f.close();
  }
});
test('pre-migration frozen journals resume the exact legacy events then a fresh publish adopts standalone manifests', async () => {
  const f = await fixture();
  try {
    f.deps.checkpoint = async () => {
      throw new Error('simulated stop before signing');
    };
    await expect(publishProject(f.options)).rejects.toThrow('simulated stop');
    const prepared = await f.load();
    const inspected = await inspectProject(
      join(f.journal.directory(prepared.id), 'files'),
      'local',
      f.creator.pubkey,
      prepared.plan.targets,
      prepared.commit,
      prepared.plan.files.map((p) => p.path),
      'legacy',
    );
    prepared.plan = inspected.plan;
    prepared.fingerprint = inspected.fingerprint;
    await f.journal.save(prepared);
    f.deps.checkpoint = async (job) => {
      if (job.snapshot && job.current) throw new Error('simulated stop after legacy signing');
    };
    await expect(publishProject({ ...f.options, resume: true })).rejects.toThrow('simulated stop');
    const signed = await f.load();
    expect((await validateRelease(signed.current, signed.snapshot)).format).toBe('legacy');
    expect(signed.current!.content).toBe('');
    delete f.deps.checkpoint;
    await publishProject({ ...f.options, resume: true });
    const resumed = await f.load();
    expect(resumed.snapshot).toEqual(signed.snapshot);
    expect(resumed.current).toEqual(signed.current);
    // A remote-only, canonical manifest migration must not strand the local
    // project's otherwise unchanged publication journal.
    const migrationSigner = await f.accounts.signer();
    try {
      const converted = await migrationSigner.signEvent(
        await migrationTemplate(signed.current!, signed.current!.created_at + 1),
      );
      f.record(signed.plan.targets.relay, converted);
    } finally {
      await migrationSigner.close();
    }
    const migrated = await publishProject(f.options);
    const fresh = await f.load();
    expect('currentId' in migrated && migrated.currentId).not.toBe(signed.current!.id);
    expect((await validateRelease(fresh.current, fresh.snapshot)).format).toBe('standalone');
    expect(fresh.plan.artifactHash).toBe(signed.plan.artifactHash);
  } finally {
    await f.close();
  }
});
test('optional metadata preflight rejects a false icon MIME, query-bearing intent and excessive parameters without remote writes', async () => {
  const f = await fixture();
  try {
    await Bun.write(join(f.project, 'icon.png'), previewPng);
    await Bun.write(
      join(f.project, 'napplet.json'),
      JSON.stringify({
        ...f.config,
        icon: { file: 'icon.png', mime: 'image/jpeg' },
      }),
    );
    await expect(publishProject({ ...f.options, dryRun: true })).rejects.toMatchObject({
      code: 'PROJECT_ICON',
    });
    await Bun.write(
      join(f.project, 'napplet.json'),
      JSON.stringify({
        ...f.config,
        intents: [{ intent: 'napplet:track/edit?track=mine', parameters: [] }],
      }),
    );
    await expect(publishProject({ ...f.options, dryRun: true })).rejects.toMatchObject({
      code: 'PROJECT_CONFIG',
    });
    await Bun.write(
      join(f.project, 'napplet.json'),
      JSON.stringify({
        ...f.config,
        intents: [
          {
            intent: 'napplet:track/edit',
            parameters: Array.from({ length: 15 }, (_, i) => `option${i}`),
          },
        ],
      }),
    );
    await expect(publishProject({ ...f.options, dryRun: true })).rejects.toMatchObject({
      code: 'PROJECT_CONFIG',
      message: expect.stringContaining('at most 14 parameter names'),
    });
    expect(f.writes).toHaveLength(0);
    expect(await publicationStatus(f.project, 'local')).toEqual({ status: 'not_started' });
  } finally {
    await f.close();
  }
});
test('a built project uploads compiled HTML and publishes editable source with standard capability metadata', async () => {
  const f = await fixture();
  try {
    await sourceGit(f.project, ['init', '--initial-branch=main']);
    await Bun.write(
      join(f.project, 'napplet.json'),
      JSON.stringify({ ...f.config, entry: 'dist/index.html' }),
    );
    await Bun.write(join(f.project, '.gitignore'), 'dist/\nnode_modules/\n.napplet-space/\n');
    await Bun.write(join(f.project, 'src/main.ts'), 'export const message: string = "compiled";');
    await Bun.write(
      join(f.project, 'index.html'),
      '<script type="module" src="/src/main.ts"></script>',
    );
    const html =
      '<!doctype html><meta name="napplet-requires" content="storage,theme"><p>compiled</p>';
    await Bun.write(join(f.project, 'dist/index.html'), html);
    const first = await publishProject(f.options);
    const job = await f.load();
    expect(first.status).toBe('announced_pending_index');
    expect(job.plan.artifactHash).toBe(await sha256(html));
    expect(new TextDecoder().decode(f.blobs.get(job.plan.artifactHash))).toBe(html);
    const release = await validateRelease(job.current, job.snapshot);
    expect(release.current.tags.filter((t) => t[0] === 'R')).toEqual([
      ['R', 'storage'],
      ['R', 'theme'],
    ]);
    const source = join(f.journal.directory(job.id), 'source');
    expect(await sourceGit(source, ['show', 'HEAD:src/main.ts'])).toContain('export const message');
    await expect(sourceGit(source, ['show', 'HEAD:dist/index.html'])).rejects.toThrow();
    expect(job.commit).toBe(await sourceGit(f.project, ['rev-parse', 'HEAD']));
    expect(await sourceGit(source, ['show', 'HEAD:index.html'])).toContain('/src/main.ts');
    const writes = [...f.writes];
    expect(await publishProject(f.options)).toMatchObject({
      unchanged: true,
      sourceCommit: job.commit,
    });
    expect(f.writes).toEqual(writes);
  } finally {
    await f.close();
  }
});
test('uncertain upload and relay acknowledgement resume the exact saved events without a second snapshot', async () => {
  const f = await fixture();
  try {
    const upload = f.deps.upload!;
    f.deps.upload = async (input) => {
      await upload(input);
      f.deps.upload = upload;
      throw new Error('Connection lost after upload\nAuthorization: Bearer fixture-secret');
    };
    await expect(publishProject(f.options)).rejects.toMatchObject({
      code: 'PUBLISH_FAILED',
      stage: 'upload',
      retryable: true,
    });
    const prepared = await f.load();
    expect(prepared.error?.message).toContain('Connection lost after upload');
    expect(prepared.error?.message).not.toContain('fixture-secret');
    const firstHash = [...f.blobs.keys()][0];
    const ensure = f.deps.relays!.ensure;
    f.deps.relays!.ensure = async (url, event) => {
      await ensure(url, event);
      if (event.kind === 5129) {
        f.deps.relays!.ensure = ensure;
        throw new Error('Connection lost after event');
      }
    };
    await expect(publishProject({ ...f.options, resume: true })).rejects.toMatchObject({
      stage: 'snapshot',
    });
    expect(f.writes.filter((id) => id === firstHash)).toHaveLength(1);
    expect((await f.load()).snapshot!.id).toBe(prepared.snapshot!.id);
    const final = await publishProject({ ...f.options, resume: true });
    expect(final).toMatchObject({
      status: 'announced_pending_index',
      snapshotId: prepared.snapshot!.id,
      sourceCommit: prepared.commit,
    });
    expect(f.writes.filter((id) => id === prepared.snapshot!.id)).toHaveLength(1);
  } finally {
    await f.close();
  }
});
test('pending source stays frozen across editor changes; the next release retains history and release refs', async () => {
  const f = await fixture();
  try {
    f.deps.checkpoint = async (job) => {
      if (job.current) {
        delete f.deps.checkpoint;
        throw new Error('Interrupted');
      }
    };
    await expect(publishProject(f.options)).rejects.toMatchObject({ code: 'PUBLISH_FAILED' });
    const old = await f.load();
    await Bun.write(join(f.project, 'index.html'), '<!doctype html><title>Two</title>Two');
    await expect(publishProject(f.options)).rejects.toMatchObject({ code: 'PUBLISH_PENDING' });
    await publishProject({ ...f.options, resume: true });
    const next = await publishProject(f.options);
    const latest = await f.load();
    expect(latest.current!.created_at).toBeGreaterThan(old.current!.created_at);
    expect(latest.id).not.toBe(old.id);
    expect(latest.source!.state.tags.filter((t) => t[0].startsWith('refs/tags/'))).toHaveLength(2);
    expect(
      await sourceGit(join(f.journal.directory(latest.id), 'source'), ['rev-parse', 'HEAD^']),
    ).toBe(old.commit);
    expect(next).toMatchObject({
      artifactHash: await sha256(await Bun.file(join(f.project, 'index.html')).bytes()),
    });
    expect(await sha256(f.blobs.get(old.plan.artifactHash)!)).toBe(old.plan.artifactHash);
  } finally {
    await f.close();
  }
});
test('metadata-only changes create a new release with the same artifact and stable identity', async () => {
  const f = await fixture();
  try {
    await publishProject(f.options);
    const first = await f.load();
    await Bun.write(
      join(f.project, 'napplet.json'),
      JSON.stringify({ ...f.config, title: 'New title' }),
    );
    await publishProject(f.options);
    const second = await f.load();
    expect(second.plan.identifier).toBe(first.plan.identifier);
    expect(second.plan.artifactHash).toBe(first.plan.artifactHash);
    expect(second.snapshot!.id).not.toBe(first.snapshot!.id);
    expect(f.writes.filter((id) => id === first.plan.artifactHash)).toHaveLength(1);
  } finally {
    await f.close();
  }
});
test('competing remote current events prevent stale writes, including retries of an already published job', async () => {
  const f = await fixture();
  try {
    await publishProject(f.options);
    const job = await f.load();
    const signer = await f.accounts.signer();
    try {
      f.record(
        job.plan.targets.relay,
        await signer.signEvent({
          kind: 35129,
          created_at: job.createdAt + 5,
          content: 'another machine',
          tags: [['d', job.plan.identifier]],
        }),
      );
    } finally {
      await signer.close();
    }
    const writes = [...f.writes];
    await expect(publishProject({ ...f.options, resume: true })).rejects.toMatchObject({
      code: 'REMOTE_CONFLICT',
    });
    expect(f.writes).toEqual(writes);
  } finally {
    await f.close();
  }
});
test('source changing during validation stops before signing or service mutations', async () => {
  const f = await fixture();
  try {
    f.options.check = async () => {
      await Bun.write(join(f.project, 'index.html'), 'changed');
      return { profile: 'test', browser: 'test' };
    };
    await expect(publishProject(f.options)).rejects.toMatchObject({ code: 'PROJECT_CHANGED' });
    expect(f.writes).toHaveLength(0);
    expect((await f.journal.index()).active).toBeNull();
  } finally {
    await f.close();
  }
});
test('concurrent publishers are excluded and release the lock after interruption', async () => {
  const f = await fixture();
  let entered!: () => void, release!: () => void;
  const started = new Promise<void>((r) => {
    entered = r;
  });
  const wait = new Promise<void>((r) => {
    release = r;
  });
  try {
    f.options.check = async () => {
      entered();
      await wait;
      return { profile: 'test', browser: 'test' };
    };
    const running = publishProject(f.options);
    await started;
    await expect(publishProject(f.options)).rejects.toMatchObject({ code: 'PUBLISH_BUSY' });
    release();
    await running;
    expect((await publishProject(f.options)).status).toBe('announced_pending_index');
  } finally {
    release();
    await f.close();
  }
});
test('symlinks, credentials, private filenames and malformed state are rejected', async () => {
  const f = await fixture();
  try {
    await Bun.write(
      join(f.project, 'napplet.json'),
      JSON.stringify({
        ...f.config,
        publish: { files: ['index.html', 'napplet.json', 'LICENSE', '.env'] },
      }),
    );
    await Bun.write(join(f.project, '.env'), 'private');
    await expect(publishProject({ ...f.options, dryRun: true })).rejects.toMatchObject({
      code: 'SOURCE_SECRET',
    });
    await Bun.write(join(f.project, 'napplet.json'), JSON.stringify(f.config));
    await Bun.write(join(f.project, 'index.html'), '-----BEGIN OPENSSH PRIVATE KEY-----');
    await expect(publishProject({ ...f.options, dryRun: true })).rejects.toMatchObject({
      code: 'SOURCE_SECRET',
    });
    await rm(join(f.project, 'index.html'));
    await symlink(join(f.project, 'LICENSE'), join(f.project, 'index.html'));
    await expect(publishProject({ ...f.options, dryRun: true })).rejects.toMatchObject({
      code: 'SOURCE_PATH',
    });
    await Bun.write(join(f.project, '.napplet-space/local/index.json'), '{bad');
    await expect(publicationStatus(f.project, 'local')).rejects.toMatchObject({
      code: 'JOURNAL_INVALID',
    });
    expect(f.writes).toHaveLength(0);
  } finally {
    await f.close();
  }
});
test('frozen bytes and saved signatures are checked before a resumed publication can write', async () => {
  const f = await fixture();
  try {
    f.deps.checkpoint = async (job) => {
      if (job.current) {
        delete f.deps.checkpoint;
        throw new Error('Interrupted');
      }
    };
    await expect(publishProject(f.options)).rejects.toThrow();
    const job = await f.load();
    job.current!.tags.push(['title', 'forged']);
    await f.journal.save(job);
    await expect(publishProject({ ...f.options, resume: true })).rejects.toThrow();
    expect(f.writes).toHaveLength(0);
    await Bun.write(join(f.journal.directory(job.id), 'source/index.html'), 'modified');
    await expect(publishProject({ ...f.options, resume: true })).rejects.toMatchObject({
      code: 'FROZEN_SOURCE_CHANGED',
    });
  } finally {
    await f.close();
  }
});

test('a repeated publication repairs missing relay events/blobs and retries failed mirrors without signing another release', async () => {
  const f = await fixture();
  try {
    const mirror = 'ws://127.0.0.1:4567/';
    f.options.targets = { mirrors: [mirror] };
    const ensure = f.deps.relays!.ensure;
    f.deps.relays!.ensure = async (url, event) => {
      if (url === mirror && event.kind === 35129)
        throw new Error('offline mirror\nAuthorization: Bearer fixture-mirror-token');
      await ensure(url, event);
    };
    await publishProject(f.options);
    const first = await f.load();
    expect(first.mirrors[mirror]).toBe(false);
    expect(first.mirrorErrors?.[mirror]).toMatchObject({
      eventId: first.current!.id,
      eventKind: 35129,
      diagnostic: { operation: 'publish optional mirror', retryable: true },
    });
    expect(first.mirrorErrors![mirror].diagnostic.message).toContain('offline mirror');
    expect(first.mirrorErrors![mirror].attemptedAt).toBeGreaterThan(0);
    expect(JSON.stringify(first)).not.toContain('fixture-mirror-token');
    const status = await publicationStatus(f.project, 'local');
    expect('mirrorErrors' in status && status.mirrorErrors[mirror]).toEqual(
      first.mirrorErrors![mirror],
    );
    expect(first.receipts.current).toBe(true);
    expect(first.error).toBeUndefined();
    expect(f.events.get(mirror)).toHaveLength(1);
    for (const json of [false, true]) {
      const child = Bun.spawn(
        [
          ...(process.env.SPACE_TEST_CLI
            ? [process.env.SPACE_TEST_CLI]
            : [
                process.execPath,
                new URL('../../../src/index.ts', import.meta.url).pathname,
              ]),
          'status',
          '--project',
          f.project,
          '--network',
          'local',
          ...(json ? ['--json'] : []),
        ],
        { stdout: 'pipe', stderr: 'pipe', stdin: 'ignore' },
      );
      const [code, output, error] = await Promise.all([
        child.exited,
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
      ]);
      expect(code, output + error).toBe(0);
      expect(output).toContain('offline mirror');
      expect(output).not.toContain('fixture-mirror-token');
      if (json) expect(JSON.parse(output).mirrorErrors[mirror].eventId).toBe(first.current!.id);
      else expect(output).toContain('Optional mirror failed:');
    }
    f.deps.relays!.ensure = ensure;
    f.events.set(first.plan.targets.relay, []);
    f.blobs.delete(first.plan.artifactHash);
    const repaired = await publishProject(f.options);
    expect(repaired).toMatchObject({
      currentId: first.current!.id,
      snapshotId: first.snapshot!.id,
      mirrors: { [mirror]: true },
      mirrorErrors: {},
    });
    expect(f.events.get(first.plan.targets.relay)).toHaveLength(2);
    expect(f.events.get(mirror)).toHaveLength(2);
    expect(await sha256(f.blobs.get(first.plan.artifactHash)!)).toBe(first.plan.artifactHash);
  } finally {
    await f.close();
  }
});

async function relayList(f: Awaited<ReturnType<typeof fixture>>, tags: string[][]) {
  const signer = await f.accounts.signer({ kinds: [10002] });
  const event = verifiedEvent(
    await signer.signEvent({
      kind: 10002,
      created_at: Math.floor(Date.now() / 1000) - 60,
      content: '',
      tags,
    }),
  );
  await signer.close();
  return event;
}
function cliStatus(project: string, json: boolean) {
  const child = Bun.spawn(
    [
      ...(process.env.SPACE_TEST_CLI
        ? [process.env.SPACE_TEST_CLI]
        : [process.execPath, new URL('../../../src/index.ts', import.meta.url).pathname]),
      'status',
      '--project',
      project,
      '--network',
      'local',
      ...(json ? ['--json'] : []),
    ],
    { stdout: 'pipe', stderr: 'pipe', stdin: 'ignore' },
  );
  return Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
}
test('a publication is copied to the creator NIP-65 write relays on a best-effort basis', async () => {
  const f = await fixture();
  try {
    const mirror = 'ws://127.0.0.1:4567/';
    const write = 'ws://127.0.0.1:5001/';
    const both = 'ws://127.0.0.1:5003/';
    f.options.targets = { mirrors: [mirror] };
    const primary = 'ws://127.0.0.1:19347/relay';
    f.record(
      primary,
      await relayList(f, [
        ['r', write, 'write'],
        ['r', 'ws://127.0.0.1:5002/', 'read'],
        ['r', both],
        ['r', mirror],
        // A public relay is outside the local publication policy.
        ['r', 'wss://relay.example.com/', 'write'],
      ]),
    );
    f.deps.relays!.read = async (url, filter) =>
      (f.events.get(url) ?? []).filter((e) => matchFilter(filter, e));
    const ensure = f.deps.relays!.ensure;
    f.deps.relays!.ensure = async (url, event) => {
      if (url === both && event.kind === 35129)
        throw new Error('outbox refused\nAuthorization: Bearer fixture-outbox-token');
      await ensure(url, event);
    };
    const first = await publishProject(f.options);
    if (first.status === 'dry_run') throw new Error('Expected a publication');
    const job = await f.load();
    expect(job.receipts.current).toBe(true);
    expect(job.outbox).toMatchObject({
      source: 'nip65',
      relays: [write, both],
      ignored: 1,
      copies: { [write]: true, [both]: false },
      errors: {
        [both]: {
          eventId: job.current!.id,
          eventKind: 35129,
          diagnostic: { operation: 'publish to creator outbox relay', retryable: true },
        },
      },
    });
    expect(job.outbox!.errors[both].diagnostic.message).toContain('outbox refused');
    expect(JSON.stringify(job)).not.toContain('fixture-outbox-token');
    expect(f.events.get(write)!.map((e) => e.id)).toEqual([job.snapshot!.id, job.current!.id]);
    expect(f.events.get('ws://127.0.0.1:5002/')).toBeUndefined();
    expect(first.outbox).toEqual(job.outbox!);
    for (const json of [false, true]) {
      const [code, output, error] = await cliStatus(f.project, json);
      expect(code, output + error).toBe(0);
      expect(output).not.toContain('fixture-outbox-token');
      if (json) expect(JSON.parse(output).outbox.copies[write]).toBe(true);
      else {
        expect(output).toContain(`Your outbox relays (NIP-65, best effort): 1/2 copied · ${write}`);
        expect(output).toContain(`Optional outbox copy failed: ${both}`);
        expect(output).toContain('outbox refused');
      }
    }
    f.deps.relays!.ensure = ensure;
    const repaired = await publishProject(f.options);
    expect(repaired).toMatchObject({
      currentId: job.current!.id,
      outbox: { copies: { [write]: true, [both]: true }, errors: {} },
    });
    expect(f.events.get(both)).toHaveLength(2);
  } finally {
    await f.close();
  }
});
test('outbox relay-list lookup failures and missing lists never block the primary publication', async () => {
  const f = await fixture();
  try {
    f.deps.relays!.read = async (url, filter) => {
      if (filter.kinds?.includes(10002))
        throw new DiagnosticError('RELAY_READ', 'Publication relay query failed.', {
          target: url,
          cause: new Error('relay list offline token=fixture-lookup-secret'),
        });
      return [];
    };
    await publishProject(f.options);
    const job = await f.load();
    expect(job.receipts.current).toBe(true);
    expect(job.outbox).toMatchObject({
      source: 'unavailable',
      relays: [],
      lookupError: { code: 'OUTBOX_LOOKUP', operation: 'look up creator outbox relays' },
    });
    expect(job.outbox!.lookupError!.details!.join('\n')).toContain('relay list offline');
    expect(job.outbox!.lookupError!.details!.join('\n')).toContain(
      'Target: ws://127.0.0.1:19347/relay',
    );
    const [code, output, error] = await cliStatus(f.project, false);
    expect(code, output + error).toBe(0);
    expect(output).toContain('the relay list could not be read');
    expect(output).toContain('OUTBOX_LOOKUP');
    expect(output).not.toContain('fixture-lookup-secret');
    f.deps.relays!.read = async () => [];
    const unchanged = await publishProject(f.options);
    expect(unchanged).toMatchObject({ outbox: { source: 'none', relays: [] } });
    expect((unchanged as { outbox: { lookupError?: unknown } }).outbox.lookupError).toBeUndefined();
  } finally {
    await f.close();
  }
});

test('public and local endpoints cannot be mixed and saved targets cannot change during resume', async () => {
  const f = await fixture();
  try {
    for (const target of [
      'wss://relay.example',
      'ws://localhost:8080',
      'ws://127.0.0.1.evil.example',
    ])
      await expect(
        publishProject({ ...f.options, dryRun: true, targets: { relay: target } }),
      ).rejects.toMatchObject({ code: 'PUBLISH_TARGET' });
    for (const target of ['https://127.0.0.1', 'https://192.168.1.1', 'https://localhost'])
      await expect(
        publishProject({
          ...f.options,
          network: 'public',
          dryRun: true,
          targets: { blossom: target },
        }),
      ).rejects.toMatchObject({ code: 'PUBLISH_TARGET' });
    f.deps.checkpoint = async () => {
      delete f.deps.checkpoint;
      throw new Error('Interrupted');
    };
    await expect(publishProject(f.options)).rejects.toThrow();
    await expect(
      publishProject({ ...f.options, resume: true, targets: { blossom: 'http://127.0.0.1:9999' } }),
    ).rejects.toMatchObject({ code: 'PUBLISH_TARGET' });
    expect(f.writes).toHaveLength(0);
  } finally {
    await f.close();
  }
});

test('publishing unchanged code after an author deletion creates new current and snapshot events', async () => {
  const f = await fixture();
  try {
    const first = await publishProject(f.options),
      job = await f.load();
    const signer = await f.accounts.signer();
    const deletion = await signer.signEvent({
      kind: 5,
      created_at: job.createdAt + 1,
      content: 'Unpublish',
      tags: [
        ['a', `35129:${f.creator.pubkey}:${job.plan.identifier}`],
        ['e', job.snapshot!.id],
      ],
    });
    await signer.close();
    f.events.set(job.plan.targets.relay, [deletion]);
    f.deps.relays!.read = async (url, filter) =>
      (f.events.get(url) ?? []).filter((e) => !filter.kinds || filter.kinds.includes(e.kind));
    await expect(publishProject({ ...f.options, resume: true })).rejects.toThrow('fresh release');
    const second = await publishProject(f.options),
      next = await f.load();
    if (first.status === 'dry_run' || second.status === 'dry_run')
      throw new Error('Expected published releases');
    expect(second.naddr).toBe(first.naddr);
    expect(second.snapshotId).not.toBe(first.snapshotId);
    expect(next.createdAt).toBeGreaterThan(deletion.created_at);
  } finally {
    await f.close();
  }
});
test('a project with its own NIP-34 remote publishes against it without signing or pushing a second repository', async () => {
  const f = await fixture();
  f.options.check = async () => ({ profile: 'test', browser: 'test', preview: previewPng });
  const relay = 'ws://127.0.0.1:7777/';
  const clone = 'http://127.0.0.1:9999/creator/my-repo.git';
  const remote = (identifier: string, pubkey = f.creator.pubkey) =>
    `nostr://${nip19.npubEncode(pubkey)}/${encodeURIComponent(relay)}/${identifier}`;
  let served: Record<string, string> = {};
  const listed: string[] = [];
  f.deps.lsRemote = async (_directory, url, refs) => {
    listed.push(url);
    return refs
      .filter((ref) => served[ref])
      .map((ref) => `${served[ref]}\t${ref}`)
      .join('\n');
  };
  let hosted = 0;
  const source = f.deps.source!;
  f.deps.source = async (input) => {
    hosted++;
    return source(input);
  };
  try {
    // A first release used the soyLI-hosted repository.
    await publishProject(f.options);
    expect(hosted).toBe(1);
    const commit = await sourceGit(f.project, ['rev-parse', 'HEAD']);
    const signer = await f.accounts.signer();
    const state = {
      'refs/heads/master': commit,
      'refs/heads/experiment': commit,
    };
    try {
      for (const [identifier, refs] of [
        ['my-repo', state],
        ['other-repo', state],
      ] as const) {
        f.record(
          relay,
          await signer.signEvent({
            kind: 30617,
            created_at: 10,
            content: '',
            tags: [
              ['d', identifier],
              ['name', 'My repository'],
              ['clone', clone, 'https://example.invalid/also.git'],
              ['relays', relay],
            ],
          }),
        );
        f.record(
          relay,
          await signer.signEvent({
            kind: 30618,
            created_at: 10,
            content: '',
            tags: [['d', identifier], ...Object.entries(refs), ['HEAD', 'ref: refs/heads/master']],
          }),
        );
      }
    } finally {
      await signer.close();
    }
    const other = getPublicKey(generateSecretKey());
    // A remix upstream owned by another key is never used as this creator's repository.
    await sourceGit(f.project, ['remote', 'add', 'upstream', remote('theirs', other)]);
    await sourceGit(f.project, ['remote', 'add', 'origin', remote('my-repo')]);
    const dry = await publishCommitted({ ...f.options, dryRun: true });
    expect(dry).toMatchObject({
      sourceRepository: { address: `30617:${f.creator.pubkey}:my-repo`, origin: 'remote origin' },
    });

    // The release commit is not yet in a ref that the clone serves.
    const writes = [...f.writes];
    await expect(publishCommitted(f.options)).rejects.toMatchObject({ code: 'SOURCE_NOT_PUSHED' });
    expect(f.writes).toEqual(writes);
    expect(hosted).toBe(1);

    served = { ...state };
    const result = await publishCommitted(f.options);
    expect(result.sourceRepository).toEqual({
      address: `30617:${f.creator.pubkey}:my-repo`,
      origin: 'remote origin',
      hosted: false,
    });
    expect(hosted).toBe(1);
    expect(listed).toContain(clone);
    const job = await f.load();
    expect(job.current!.tags.find((t) => t[0] === 'source')).toEqual(['source', remote('my-repo')]);
    expect(job.current!.tags.find((t) => t[0] === 'source-commit')).toEqual([
      'source-commit',
      commit,
    ]);
    expect(job.current!.tags).toContainEqual([
      'soy-source-repository',
      `30617:${f.creator.pubkey}:my-repo`,
      'linked',
    ]);
    expect(job.releaseRefs).toEqual({});
    expect(job.source).toBeUndefined();
    // Only the release events were written: no repository announcement or state.
    const added = [...f.events.values()]
      .flat()
      .filter((e) => f.writes.slice(writes.length).includes(e.id));
    expect(added.map((e) => e.kind).sort((a, b) => a - b)).toEqual([5129, 35129]);

    // Unchanged source and repository reuse the release.
    expect(await publishCommitted(f.options)).toMatchObject({ unchanged: true });

    // Two owned NIP-34 remotes need an explicit choice.
    await sourceGit(f.project, ['remote', 'add', 'mirror', remote('other-repo')]);
    await expect(publishCommitted(f.options)).rejects.toMatchObject({
      code: 'REPOSITORY_AMBIGUOUS',
    });
  } finally {
    await f.close();
  }
});

test('ordinary publication and updates keep one named listing without creating independent snapshots', async () => {
  const f = await fixture();
  try {
    const options = { ...f.options, snapshot: undefined };
    const first = await publishProject(options);
    const firstJob = await f.load();
    expect(firstJob.snapshot).toBeUndefined();
    expect(first).toMatchObject({ snapshotId: null, currentId: firstJob.current!.id });
    expect('snapshotUrl' in first && first.snapshotUrl).toEndWith(`/r/${firstJob.current!.id}`);
    await Bun.write(join(f.project, 'index.html'), '<!doctype html><title>Updated</title>Two');
    const updated = await publishProject(options);
    const next = await f.load();
    expect(next.plan.identifier).toBe(firstJob.plan.identifier);
    expect(next.current!.id).not.toBe(firstJob.current!.id);
    expect(next.snapshot).toBeUndefined();
    expect('snapshotId' in updated && updated.snapshotId).toBeNull();
    expect([...f.events.values()].flat().filter((e) => e.kind === 5129)).toEqual([]);
    expect(await publishProject(options)).toMatchObject({
      unchanged: true,
      currentId: next.current!.id,
    });
  } finally {
    await f.close();
  }
});

test('an explicit snapshot is frozen with its release and can be requested after a named-only publication', async () => {
  const f = await fixture();
  try {
    await publishProject({ ...f.options, snapshot: undefined });
    const first = await f.load();
    const explicit = await publishProject({ ...f.options, snapshot: true });
    const copy = await f.load();
    expect(copy.current!.id).not.toBe(first.current!.id);
    expect(copy.snapshot).toBeDefined();
    await validateRelease(copy.current, copy.snapshot);
    expect('snapshotId' in explicit && explicit.snapshotId).toBe(copy.snapshot!.id);
    expect(await publishProject({ ...f.options, snapshot: true })).toMatchObject({
      unchanged: true,
    });
  } finally {
    await f.close();
  }
});

test('resuming a frozen named-only release cannot add a snapshot and old paired jobs retain their saved intent', async () => {
  const f = await fixture();
  try {
    f.deps.checkpoint = async () => {
      throw new Error('stop before signing');
    };
    await expect(publishProject({ ...f.options, snapshot: undefined })).rejects.toThrow(
      'stop before signing',
    );
    delete f.deps.checkpoint;
    await expect(
      publishProject({ ...f.options, snapshot: true, resume: true }),
    ).rejects.toMatchObject({ code: 'PUBLISH_OPTIONS' });
    await publishProject({ ...f.options, snapshot: undefined, resume: true });
    expect((await f.load()).snapshot).toBeUndefined();
    await Bun.write(
      join(f.project, 'index.html'),
      '<!doctype html><title>Old frozen release</title>Three',
    );
    f.deps.checkpoint = async () => {
      throw new Error('old preparation');
    };
    await expect(publishProject(f.options)).rejects.toThrow('old preparation');
    const old = await f.load();
    delete old.snapshotMode; // Journals written by previous CLI versions always published a pair.
    await f.journal.save(old);
    delete f.deps.checkpoint;
    await publishProject({ ...f.options, snapshot: undefined, resume: true });
    const resumed = await f.load();
    expect(resumed.id).toBe(old.id);
    await validateRelease(resumed.current, resumed.snapshot);
  } finally {
    await f.close();
  }
});

test('overlong canonical outbox destinations are skipped before network writes and CLI status stays completed', async () => {
  const f = await fixture();
  try {
    const long = 'ws://127.0.0.1/' + 'a'.repeat(300),
      expanded = 'ws://127.0.0.1/' + '界'.repeat(30);
    const primary = 'ws://127.0.0.1:19347/relay';
    f.record(
      primary,
      await relayList(f, [
        ['r', long],
        ['r', expanded],
      ]),
    );
    f.deps.relays!.read = async (url, filter) =>
      (f.events.get(url) ?? []).filter((e) => matchFilter(filter, e));
    await publishProject(f.options);
    const job = await f.load();
    expect(job.status).toBe('announced_pending_index');
    expect((await f.journal.index()).active).toBeNull();
    expect(job.outbox).toMatchObject({ ignored: 2, relays: [] });
    expect(f.events.has(long)).toBe(false);
    expect(f.events.has(new URL(expanded).href)).toBe(false);
    const [code, output, error] = await cliStatus(f.project, false);
    expect(code, output + error).toBe(0);
    expect(output).toContain('Skipped 2 listed write relays');
    expect(output).toContain('256-character canonical URL bound');
  } finally {
    await f.close();
  }
});

test('completed primary is durable before optional lookup and lifecycle removes retired and partial copies beyond eight relays', async () => {
  const f = await fixture();
  try {
    const primary = 'ws://127.0.0.1:19347/relay';
    const mirrors = Array.from({ length: 7 }, (_, i) => `ws://127.0.0.1:${5000 + i}/`);
    const outbox = Array.from({ length: 8 }, (_, i) => `ws://127.0.0.1:${6000 + i}/`);
    f.options.targets = { mirrors };
    f.record(
      primary,
      await relayList(
        f,
        outbox.map((url) => ['r', url]),
      ),
    );
    f.deps.relays!.read = async (url, filter) => {
      if (filter.kinds?.includes(10002)) {
        const job = await f.load();
        expect(job.status).toBe('announced_pending_index');
        expect((await f.journal.index()).active).toBeNull();
      }
      return (f.events.get(url) ?? []).filter((e) => matchFilter(filter, e));
    };
    const ensure = f.deps.relays!.ensure;
    f.deps.relays!.ensure = async (url, event) => {
      if (url === outbox[0] && event.kind === 35129)
        throw new Error('fixture current refused after snapshot accepted');
      await ensure(url, event);
    };
    await publishProject(f.options);
    const first = await f.load();
    expect(f.events.get(outbox[0])!.map((e) => e.kind)).toEqual([5129]);
    // Remove the old list so selection unambiguously follows the creator's replacement.
    f.events.set(
      primary,
      f.events.get(primary)!.filter((e) => e.kind !== 10002),
    );
    f.record(primary, await relayList(f, [['r', outbox[7]]]));
    await publishProject(f.options);
    const job = await f.load();
    expect(job.outbox!.relays).toEqual([outbox[7]]);
    expect(job.outboxHistory).toEqual(outbox);
    const relayKey = (url: string) =>
      [...f.events.keys()].find((key) => key.replace(/\/$/, '') === url.replace(/\/$/, '')) ?? url;
    const io = {
      read: async (url: string, filter: any) =>
        (f.events.get(relayKey(url)) ?? []).filter((e) => matchFilter(filter, e)),
      publish: async (url: string, deletion: SignedEvent) => {
        expect(deletion.kind).toBe(5);
        const target = relayKey(url);
        f.events.set(
          target,
          (f.events.get(target) ?? []).filter(
            (e) => !deletion.tags.some((t) => t[0] === 'e' && t[1] === e.id),
          ),
        );
        f.record(target, deletion);
      },
      fetch: async () => {
        throw new Error('unpublish must retain storage');
      },
    };
    const plan = await planLifecycle({
      operation: 'unpublish',
      manifest: job.current!,
      saved: [first.current!, first.snapshot!],
      snapshotPairs: [{ current: first.current!, snapshot: first.snapshot! }],
      relays: publicationDestinations([job]),
      local: true,
      io,
    });
    expect(plan.relays).toHaveLength(16);
    const receipt = createLifecycleReceipt(plan, 'unpublish');
    expect(parseReceipt(receipt).plan.relays).toHaveLength(16);
    const signer = await f.accounts.signer({ kinds: [5] });
    try {
      await executeLifecycle(receipt, {
        signer,
        local: true,
        io,
        save: async () => {},
      });
    } finally {
      await signer.close();
    }
    expect(lifecycleFinished(receipt)).toBe(true);
    for (const url of [primary, ...mirrors, ...outbox])
      expect(
        (f.events.get(url) ?? []).some(
          (e) => e.id === job.current!.id || e.id === job.snapshot!.id,
        ),
      ).toBe(false);
  } finally {
    await f.close();
  }
});

test('cancelling optional delivery retains primary success and does not require a nonexistent pending resume', async () => {
  const f = await fixture(),
    controller = new AbortController();
  try {
    f.options.signal = controller.signal;
    f.deps.relays!.read = async (_url, filter) => {
      if (filter.kinds?.includes(10002)) controller.abort();
      return [];
    };
    const result = await publishProject(f.options);
    expect(result.status).toBe('announced_pending_index');
    const job = await f.load();
    expect(job.error).toBeUndefined();
    expect(job.outbox!.lookupError!.code).toBe('OPTIONAL_COPY_CANCELLED');
    expect((await f.journal.index()).active).toBeNull();
    const [code, output, error] = await cliStatus(f.project, false);
    expect(code, output + error).toBe(0);
    expect(output).toContain('OPTIONAL_COPY_CANCELLED');
  } finally {
    await f.close();
  }
});

test('larger public playback does not raise soyLI publication above 25 MiB', async () => {
  const f = await fixture();
  try {
    await Bun.write(
      join(f.project, 'index.html'),
      '<!doctype html><p>Too large to publish</p>'.padEnd(32 * 1024 * 1024, ' '),
    );
    await expect(publishProject({ ...f.options, dryRun: true })).rejects.toThrow('supported size');
    expect(f.writes).toHaveLength(0);
    expect(f.blobs.size).toBe(0);
  } finally {
    await f.close();
  }
});

for (const withAliases of [false, true])
  test(`publication archives ignore Git export rules and remix exact source${withAliases ? ' with aliases' : ''}`, async () => {
    const f = await fixture();
    try {
      const encoder = new TextEncoder();
      const files = new Map<string, Uint8Array<ArrayBuffer>>(
        Object.entries({
          '.gitattributes':
            '.gitattributes export-ignore\n.gitmodules export-ignore\nsrc export-ignore\nAGENTS.md export-ignore\nCLAUDE.md export-ignore\nindex.html export-subst\n',
          '.gitmodules': '',
          'index.html': '<!doctype html><title>Exact source</title><p>$Format:%H$</p>\n',
          'AGENTS.md': '# Public instructions\n',
          'src/.gitattributes': '* export-ignore export-subst\n',
          'src/main.ts': 'export const revision = "$Format:%H$";\n',
        }).map(([path, value]) => [path, encoder.encode(value)]),
      );
      files.set('src/data.bin', new Uint8Array([0, 255, 13, 10, 10]));
      for (const [path, bytes] of files) await Bun.write(join(f.project, path), bytes);
      if (withAliases) {
        await symlink('AGENTS.md', join(f.project, 'CLAUDE.md'));
        await symlink('main.ts', join(f.project, 'src/alias.ts'));
      }
      await publishProject(f.options);
      const job = await f.load();
      const archived = sourceArchive(f.blobs.get(job.archiveHash)!);
      for (const [path, bytes] of files) expect(archived.get(path)).toEqual(bytes);
      if (withAliases) {
        expect(archived.get('CLAUDE.md')).toEqual(files.get('AGENTS.md'));
        expect(archived.get('src/alias.ts')).toEqual(files.get('src/main.ts'));
        expect(await sourceGit(f.project, ['ls-tree', 'HEAD', 'CLAUDE.md'])).toStartWith(
          '120000 blob ',
        );
      }
      const remixed = await createRemix(f.root, 'exact-source', {
        manifest: job.snapshot!,
        artifact: f.blobs.get(job.plan.artifactHash)!,
        files: archived,
      });
      for (const [path, bytes] of files)
        expect(await Bun.file(join(remixed.directory, path)).bytes()).toEqual(bytes);
      expect(await sourceGit(f.project, ['rev-parse', 'HEAD'])).toBe(job.commit);
      expect(await sourceGit(f.project, ['status', '--porcelain'])).toBe('');
      expect(await Bun.file(join(f.project, '.git/info/attributes')).exists()).toBe(false);
      await publishProject({ ...f.options, resume: true });
      expect((await f.load()).archiveHash).toBe(job.archiveHash);
    } finally {
      await f.close();
    }
  }, 15000);

// Exercise real relay discovery and delivery; only the Git ref listing is stubbed.
async function linkedProposalFixture() {
  const f = await fixture();
  const relayEvents: SignedEvent[] = [];
  const server = Bun.serve<{ hinted: boolean }>({
    hostname: '127.0.0.1',
    port: 0,
    fetch(request, server) {
      return server.upgrade(request, {
        data: { hinted: new URL(request.url).pathname === '/hinted' },
      })
        ? undefined
        : new Response('', { status: 400 });
    },
    websocket: {
      message(ws, raw) {
        const [op, id, ...filters] = JSON.parse(String(raw));
        if (op === 'REQ') {
          if (ws.data.hinted)
            for (const event of relayEvents.filter((e) => matchFilters(filters, e)))
              ws.send(JSON.stringify(['EVENT', id, event]));
          ws.send(JSON.stringify(['EOSE', id]));
        } else if (op === 'EVENT') {
          const event = verifiedEvent(id);
          if (ws.data.hinted && !relayEvents.some((e) => e.id === event.id))
            relayEvents.push(event);
          ws.send(JSON.stringify(['OK', event.id, true, '']));
        }
      },
    },
  });
  const relay = `ws://127.0.0.1:${server.port}/hinted`;
  f.options.targets = {
    relay: `ws://127.0.0.1:${server.port}/fallback`,
    grasp: `http://127.0.0.1:${server.port}`,
  };
  const signer = await f.accounts.signer();
  try {
    await publishProject(f.options);
    const original = await sourceGit(f.project, ['rev-parse', 'HEAD']);
    await Bun.write(
      join(f.project, 'index.html'),
      '<!doctype html><title>Merged</title><p>Contribution</p>',
    );
    await sourceGit(f.project, ['add', 'index.html']);
    await sourceGit(f.project, ['commit', '-m', 'Include contribution']);
    const commit = await sourceGit(f.project, ['rev-parse', 'HEAD']);
    const identifier = 'linked-review';
    const address = `30617:${f.creator.pubkey}:${identifier}`;
    await sourceGit(f.project, [
      'remote',
      'add',
      'origin',
      `nostr://${nip19.npubEncode(f.creator.pubkey)}/${encodeURIComponent(relay)}/${identifier}`,
    ]);
    // The optional relays tag is deliberately absent: only the URL tells us where to look.
    f.record(
      relay,
      await signer.signEvent({
        kind: 30617,
        created_at: 10,
        content: '',
        tags: [
          ['d', identifier],
          ['clone', `http://127.0.0.1:${server.port}/source.git`],
        ],
      }),
    );
    let served: Record<string, string> = {};
    async function state(refs: Record<string, string>, at: number, cloneRefs = refs) {
      served = cloneRefs;
      f.record(
        relay,
        await signer.signEvent({
          kind: 30618,
          created_at: at,
          content: '',
          tags: [['d', identifier], ...Object.entries(refs), ['HEAD', 'ref: refs/heads/main']],
        }),
      );
    }
    await state({ 'refs/heads/main': commit }, 10);
    f.deps.lsRemote = async (_dir, _url, refs) =>
      refs
        .filter((ref) => served[ref])
        .map((ref) => `${served[ref]}\t${ref}`)
        .join('\n');
    const proposal = finalizeEvent(
      {
        kind: 1618,
        created_at: 20,
        content: 'Contribution',
        tags: [
          ['a', address],
          ['c', commit],
          ['clone', `http://127.0.0.1:${server.port}/source.git`],
          ['target-branch', 'main'],
        ],
      },
      generateSecretKey(),
    );
    relayEvents.push(proposal);
    delete f.deps.proposalClient;
    return {
      ...f,
      original,
      commit,
      proposal,
      relayEvents,
      state,
      close: async () => {
        await signer.close();
        server.stop(true);
        await f.close();
      },
    };
  } catch (error) {
    await signer.close();
    server.stop(true);
    await f.close();
    throw error;
  }
}

test('linked publication discovers and closes included proposals using source URL relay hints', async () => {
  const f = await linkedProposalFixture();
  try {
    expect((await publishCommitted(f.options)).status).toBe('announced_pending_index');
    const job = await f.load();
    expect(job.appliedBranch).toBe('main');
    expect(job.appliedStatuses).toHaveLength(1);
    expect(JSON.parse(JSON.stringify(f.relayEvents.filter((e) => e.kind === 1631)))).toEqual(
      job.appliedStatuses!,
    );
    expect(job.appliedStatuses![0].tags).toContainEqual(['e', f.proposal.id, '', 'reply']);
  } finally {
    await f.close();
  }
}, 30000);

for (const moved of ['signed target', 'clone target', 'missing saved target'] as const)
  test(`resumed linked publication refuses applied status after ${moved} changes, then reuses its signatures`, async () => {
    const f = await linkedProposalFixture();
    try {
      let interrupted = false;
      f.deps.checkpoint = async (job) => {
        if (!interrupted && job.appliedStatuses?.length) {
          interrupted = true;
          throw new Error('Interrupt after status preparation');
        }
      };
      await expect(publishCommitted(f.options)).rejects.toThrow(
        'Interrupt after status preparation',
      );
      const saved = await f.load();
      expect(saved.appliedBranch).toBe('main');
      expect(saved.appliedStatuses).toHaveLength(1);
      // Retaining the release under a tag must not count as merging it into main.
      const movedRefs = { 'refs/heads/main': f.original, 'refs/tags/reviewed': f.commit };
      await f.state(
        moved === 'signed target'
          ? movedRefs
          : { 'refs/heads/main': f.commit, 'refs/tags/reviewed': f.commit },
        30,
        moved === 'clone target' ? movedRefs : undefined,
      );
      if (moved === 'missing saved target') {
        delete saved.appliedBranch;
        await f.journal.save(saved);
      }
      // Resuming from another local branch still checks the originally reviewed target.
      await sourceGit(f.project, ['switch', '-c', 'another-local-branch']);
      await expect(publishCommitted({ ...f.options, resume: true })).rejects.toThrow(
        moved === 'clone target'
          ? 'No clone URL'
          : 'no longer confirms the reviewed proposal target',
      );
      const failed = await f.load();
      expect(failed.appliedStatuses).toEqual(saved.appliedStatuses!);
      expect(f.relayEvents.filter((e) => e.kind === 1631)).toHaveLength(0);
      expect(failed.receipts.source).toBe(false);
      // The persisted diagnostic is useful through the actual CLI status entrypoint too.
      const [code, output, error] = await cliStatus(f.project, true);
      expect(code, output + error).toBe(0);
      expect(output).toContain(
        moved === 'clone target' ? 'SOURCE_NOT_PUSHED' : 'PROPOSAL_TARGET_CHANGED',
      );
      expect(output).toContain(
        moved === 'missing saved target' ? 'unknown branch' : 'refs/heads/main',
      );
      await f.state({ 'refs/heads/main': f.commit }, 40);
      if (moved === 'missing saved target') {
        failed.appliedBranch = 'main';
        await f.journal.save(failed);
      }
      await publishCommitted({ ...f.options, resume: true });
      expect(JSON.parse(JSON.stringify(f.relayEvents.filter((e) => e.kind === 1631)))).toEqual(
        saved.appliedStatuses!,
      );
    } finally {
      await f.close();
    }
  }, 30000);
