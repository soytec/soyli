import { expect, test } from 'bun:test';
import { mkdtemp, readlink, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Accounts, type Vault } from '../../packages/identity/src/accounts';
import { checkpoint } from '../../packages/publish/src/git-source';
import { sourceGit } from '../../packages/grasp/src/client';
import { createWorkshop, type Workshop } from '../workshop';
import { workingTree, workingDiff } from '../workshop-git';

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), 'soy-workshop-'));
  const store = new Map<string, string>();
  const vault: Vault = {
    get: async (id) => store.get(id) ?? null,
    set: async (id, value) => {
      store.set(id, value);
    },
    delete: async (id) => {
      store.delete(id);
    },
  };
  const accountRoot = await mkdtemp(join(tmpdir(), 'soy-workshop-accounts-'));
  const accounts = new Accounts('local', accountRoot, vault);
  await accounts.create();
  await Bun.write(join(directory, '.gitignore'), '.napplet-space/\n');
  await Bun.write(
    join(directory, 'napplet.json'),
    JSON.stringify({
      schema: 'space-local-project/v1',
      name: 'Workshop',
      entry: 'index.html',
      previewId: crypto.randomUUID(),
      license: 'MIT',
    }),
  );
  await Bun.write(join(directory, 'index.html'), '<p>First idea</p>');
  await Bun.write(join(directory, 'LICENSE'), 'MIT');
  await checkpoint(directory, 'Start');
  const workshop = createWorkshop({
    directory,
    network: 'local',
    accounts,
    check: async () => ({ profile: 'fixture', browser: 'fixture' }),
  });
  return {
    directory,
    accounts,
    workshop,
    close: async () => {
      await workshop.close();
      await rm(directory, { recursive: true, force: true });
      await rm(accountRoot, { recursive: true, force: true });
    },
  };
}
async function finish(workshop: Workshop) {
  for (let i = 0; i < 200; i++) {
    const state = await workshop.snapshot();
    if (!state.busy) return state;
    await Bun.sleep(10);
  }
  throw new Error('Workshop did not finish');
}
test('workshop snapshots accept 1024 source files and reject the 1025th file', async () => {
  const f = await fixture();
  try {
    // The fixture already has four tracked files; untracked source must also count.
    await Promise.all(
      Array.from({ length: 1020 }, (_, i) =>
        Bun.write(
          join(f.directory, `src/file-${String(i).padStart(4, '0')}.ts`),
          `export const n = ${i};`,
        ),
      ),
    );
    const state = await f.workshop.snapshot();
    expect(state.tree.changed).toHaveLength(1020);
    expect(state.tree.changed).toContain('src/file-1019.ts');
    expect((await f.workshop.diff(state.tree.revision, 'src/file-1019.ts')).diff).toBe(
      'export const n = 1019;',
    );
    await Bun.write(join(f.directory, 'src/overflow.ts'), 'export const overflow = true;');
    await expect(f.workshop.snapshot()).rejects.toThrow('1024 source file limit');
  } finally {
    await f.close();
  }
});
test('workshop rejects stale file and creator snapshots and checkpoints exactly the reviewed files', async () => {
  const f = await fixture();
  try {
    const before = await f.workshop.snapshot();
    await Bun.write(join(f.directory, 'index.html'), '<p>An editor changed this</p>');
    await f.workshop.start(
      { action: 'checkpoint', revision: before.revision, message: 'Stale' },
      'http://127.0.0.1:4173',
    );
    expect((await finish(f.workshop)).job?.error).toContain('changed');
    expect(await sourceGit(f.directory, ['rev-parse', 'HEAD'])).toBe(before.tree.head!);
    const changed = await f.workshop.snapshot();
    expect(changed.tree.changed).toEqual(['index.html']);
    expect((await f.workshop.diff(changed.tree.revision, 'index.html')).diff).toContain(
      '+<p>An editor changed this',
    );
    await f.accounts.create({ fresh: true });
    await f.workshop.start(
      { action: 'checkpoint', revision: changed.revision, message: 'Different creator' },
      'http://127.0.0.1:4173',
    );
    expect((await finish(f.workshop)).job?.error).toContain('identity changed');
    const current = await f.workshop.snapshot();
    await f.workshop.start(
      { action: 'checkpoint', revision: current.revision, message: 'Keep the improvement' },
      'http://127.0.0.1:4173',
    );
    const saved = await finish(f.workshop);
    expect(saved.job?.state, saved.job?.error).toBe('done');
    expect(saved.tree.changed).toEqual([]);
    expect(await sourceGit(f.directory, ['log', '-1', '--format=%s'])).toBe('Keep the improvement');
  } finally {
    await f.close();
  }
});
test('workshop checks are invalidated by edits and publishing never implicitly checkpoints', async () => {
  const f = await fixture();
  try {
    let state = await f.workshop.snapshot();
    await f.workshop.start(
      { action: 'publish', revision: state.revision },
      'http://127.0.0.1:4173',
    );
    expect((await finish(f.workshop)).job?.error).toContain('Build and check');
    await f.workshop.start({ action: 'check', revision: state.revision }, 'http://127.0.0.1:4173');
    state = await finish(f.workshop);
    expect(state.prepared?.plan.sourceCommit).toBe(state.tree.head!);
    await Bun.write(join(f.directory, 'index.html'), '<p>New, uncommitted idea</p>');
    const changed = await f.workshop.snapshot();
    expect(changed.prepared).toBeNull();
    await f.workshop.start(
      { action: 'check', revision: changed.revision },
      'http://127.0.0.1:4173',
    );
    expect((await finish(f.workshop)).job?.error).toContain('checkpoint');
    expect(await sourceGit(f.directory, ['rev-parse', 'HEAD'])).toBe(state.tree.head!);
  } finally {
    await f.close();
  }
});
test('workshop serializes capture/edit/actions and detects files edited during a check', async () => {
  const f = await fixture();
  let proceed!: () => void, entered!: () => void;
  const gate = new Promise<void>((r) => {
      proceed = r;
    }),
    started = new Promise<void>((r) => {
      entered = r;
    });
  const workshop = createWorkshop({
    directory: f.directory,
    network: 'local',
    accounts: f.accounts,
    check: async () => {
      entered();
      await gate;
      return { profile: 'fixture', browser: 'fixture' };
    },
  });
  try {
    const state = await workshop.snapshot();
    await workshop.start({ action: 'check', revision: state.revision }, 'http://127.0.0.1:4173');
    await started;
    await expect(workshop.edit(async () => {})).rejects.toThrow('Another workshop action');
    await expect(
      workshop.start(
        { action: 'checkpoint', revision: state.revision, message: 'Concurrent' },
        'http://127.0.0.1:4173',
      ),
    ).rejects.toThrow('Another workshop action');
    await Bun.write(join(f.directory, 'index.html'), '<p>Changed during check</p>');
    proceed();
    const result = await finish(workshop);
    expect(result.job?.error).toContain('during the check');
    expect(result.prepared).toBeNull();
  } finally {
    proceed();
    await workshop.close();
    await f.close();
  }
});
test('switching accounts during a workshop check preserves the selection and requires review for the new author', async () => {
  const f = await fixture();
  let selected: string | undefined;
  const workshop = createWorkshop({
    directory: f.directory,
    network: 'local',
    accounts: f.accounts,
    check: async () => {
      if (!selected) selected = (await f.accounts.create({ fresh: true })).id;
      return { profile: 'fixture', browser: 'fixture' };
    },
  });
  try {
    let state = await workshop.snapshot();
    await workshop.start({ action: 'check', revision: state.revision }, 'http://127.0.0.1:4173');
    state = await finish(workshop);
    expect(state.job?.state).toBe('done');
    expect(state.prepared).toBeNull();
    expect((await f.accounts.current())?.id).toBe(selected);
    await workshop.start({ action: 'check', revision: state.revision }, 'http://127.0.0.1:4173');
    state = await finish(workshop);
    expect(state.job?.state).toBe('done');
    expect(state.prepared?.plan.pubkey).toBe(state.identity?.pubkey);
    expect((await f.accounts.current())?.id).toBe(selected);
  } finally {
    await workshop.close();
    await f.close();
  }
});
test('diff review includes staged, deleted and new files and withholds likely secrets', async () => {
  const f = await fixture();
  try {
    await sourceGit(f.directory, ['rm', 'LICENSE']);
    await Bun.write(join(f.directory, 'README.md'), '# A new idea');
    let state = await workingTree(f.directory);
    expect(state.changed).toEqual(['LICENSE', 'README.md']);
    expect((await workingDiff(f.directory, state.revision, 'LICENSE')).diff).toContain('-MIT');
    expect((await workingDiff(f.directory, state.revision, 'README.md')).diff).toBe('# A new idea');
    await Bun.write(join(f.directory, 'README.md'), 'nsec1' + 'a'.repeat(58));
    await expect(workingDiff(f.directory, state.revision, 'README.md')).rejects.toThrow(
      'Files changed',
    );
    state = await workingTree(f.directory);
    await expect(workingDiff(f.directory, state.revision, 'README.md')).rejects.toThrow(
      'likely credential',
    );
    await expect(workingDiff(f.directory, state.revision, '../accounts.json')).rejects.toThrow(
      'Choose a changed file',
    );
  } finally {
    await f.close();
  }
});

test('Git workshop reviews safe aliases and invalidates review when equal-content targets change', async () => {
  const f = await fixture();
  try {
    await Bun.write(join(f.directory, 'AGENTS.md'), '# Shared guidance\n');
    await Bun.write(join(f.directory, 'OTHER.md'), '# Shared guidance\n');
    await checkpoint(f.directory, 'Add agent guidance');
    await symlink('AGENTS.md', join(f.directory, 'CLAUDE.md'));
    const added = await workingTree(f.directory);
    expect(added.changed).toContain('CLAUDE.md');
    expect((await workingDiff(f.directory, added.revision, 'CLAUDE.md')).diff).toBe(
      'New file alias: AGENTS.md',
    );
    await checkpoint(f.directory, 'Share the agent guidance');
    const committed = await workingTree(f.directory);
    expect(committed.changed).toEqual([]);
    await rm(join(f.directory, 'CLAUDE.md'));
    await symlink('OTHER.md', join(f.directory, 'CLAUDE.md'));
    const changed = await workingTree(f.directory);
    expect(changed.revision).not.toBe(committed.revision);
    expect(changed.changed).toContain('CLAUDE.md');
    await expect(workingDiff(f.directory, committed.revision, 'CLAUDE.md')).rejects.toThrow(
      'Files changed',
    );
    const diff = await workingDiff(f.directory, changed.revision, 'CLAUDE.md');
    expect(diff.diff).toContain('-AGENTS.md');
    expect(diff.diff).toContain('+OTHER.md');
    expect(await readlink(join(f.directory, 'CLAUDE.md'))).toBe('OTHER.md');
    await Bun.write(join(f.directory, 'OTHER.md'), 'nsec1' + 'a'.repeat(58));
    const sensitive = await workingTree(f.directory);
    await expect(workingDiff(f.directory, sensitive.revision, 'CLAUDE.md')).rejects.toThrow(
      'likely credential',
    );
  } finally {
    await f.close();
  }
});
