import { expect, test } from 'bun:test';
import { lstat, mkdtemp, readlink, rename, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sourceGit } from '../../packages/grasp/src/client';
import { sha256 } from '../../packages/protocol/src';

const command = process.env.SPACE_TEST_CLI
  ? [process.env.SPACE_TEST_CLI]
  : [process.execPath, new URL('../index.ts', import.meta.url).pathname];

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'soyli-source-links-'));
  const project = join(root, 'project');
  const run = async (args: string[]) => {
    const child = Bun.spawn([...command, ...args, '--network', 'local'], {
      cwd: root,
      env: {
        PATH: process.env.PATH,
        SPACE_ACCOUNT_HOME: join(root, 'accounts'),
        SOYLI_DANGEROUS_PLAINTEXT_KEYS: '1',
      },
      stdin: 'ignore',
      stdout: 'pipe',
      stderr: 'pipe',
    });
    const [code, out, err] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    return { code, out, err };
  };
  const created = await run(['account', 'create', '--json']);
  expect(created.code, created.out + created.err).toBe(0);
  await Bun.write(
    join(project, 'napplet.json'),
    JSON.stringify({
      schema: 'space-local-project/v1',
      name: 'Source aliases',
      entry: 'index.html',
      previewId: crypto.randomUUID(),
      license: 'MIT',
    }),
  );
  await Bun.write(join(project, 'index.html'), '<!doctype html><title>Source aliases</title>');
  await Bun.write(join(project, 'LICENSE'), 'MIT');
  await Bun.write(join(project, '.gitignore'), '.napplet-space/\n.env\nuntracked.md\n');
  const instructions = '# Project guidance\n\nMake something distinctive and accessible.\n';
  await Bun.write(join(project, 'AGENTS.md'), instructions);
  await sourceGit(project, ['init']);
  return {
    root,
    project,
    instructions,
    run,
    dry: () => run(['publish', '--dry-run', '--project', project, '--json']),
    commit: async () => {
      await sourceGit(project, ['add', '.']);
      await sourceGit(project, ['commit', '-m', 'Tracked source aliases']);
      return sourceGit(project, ['rev-parse', 'HEAD']);
    },
    close: () => rm(root, { recursive: true, force: true }),
  };
}

test('real CLI publishes a tracked CLAUDE.md alias as target bytes without rewriting its link or history', async () => {
  const f = await fixture();
  try {
    await symlink('AGENTS.md', join(f.project, 'CLAUDE.md'));
    const head = await f.commit();
    const beforeTree = await sourceGit(f.project, ['ls-tree', 'HEAD', 'CLAUDE.md']);
    expect(beforeTree).toStartWith('120000 blob ');
    const accepted = await f.dry();
    expect(accepted.code, accepted.out + accepted.err).toBe(0);
    const result = JSON.parse(accepted.out);
    const expected = {
      hash: await sha256(new TextEncoder().encode(f.instructions)),
      size: new TextEncoder().encode(f.instructions).length,
    };
    expect(result.plan.files).toContainEqual({ path: 'AGENTS.md', ...expected });
    expect(result.plan.files).toContainEqual({ path: 'CLAUDE.md', ...expected });
    expect(result.sourceHistory.status).toBe('checked');
    expect(await readlink(join(f.project, 'CLAUDE.md'))).toBe('AGENTS.md');
    expect((await lstat(join(f.project, 'CLAUDE.md'))).isSymbolicLink()).toBe(true);
    expect(await sourceGit(f.project, ['ls-tree', 'HEAD', 'CLAUDE.md'])).toBe(beforeTree);
    expect(await sourceGit(f.project, ['rev-parse', 'HEAD'])).toBe(head);
    expect(await sourceGit(f.project, ['status', '--porcelain'])).toBe('');
  } finally {
    await f.close();
  }
}, 15000);

test('real CLI checkpoints a new relative alias chain when all targets are selected public source', async () => {
  const f = await fixture();
  try {
    const initial = await f.commit();
    await Bun.write(join(f.project, 'docs/README.md'), '# Project documentation\n');
    await symlink('../AGENTS.md', join(f.project, 'docs/guidance.md'));
    await symlink('docs/guidance.md', join(f.project, 'CLAUDE.md'));
    const checkpoint = await f.run([
      'checkpoint',
      'Share agent guidance aliases',
      '--project',
      f.project,
      '--json',
    ]);
    expect(checkpoint.code, checkpoint.out + checkpoint.err).toBe(0);
    expect(await sourceGit(f.project, ['rev-parse', 'HEAD'])).not.toBe(initial);
    expect(await sourceGit(f.project, ['rev-parse', 'HEAD^'])).toBe(initial);
    const dry = await f.dry();
    expect(dry.code, dry.out + dry.err).toBe(0);
    const files = JSON.parse(dry.out).plan.files;
    for (const path of ['AGENTS.md', 'docs/guidance.md', 'CLAUDE.md'])
      expect(files).toContainEqual({
        path,
        hash: await sha256(new TextEncoder().encode(f.instructions)),
        size: new TextEncoder().encode(f.instructions).length,
      });
    expect(await readlink(join(f.project, 'CLAUDE.md'))).toBe('docs/guidance.md');
    expect(await readlink(join(f.project, 'docs/guidance.md'))).toBe('../AGENTS.md');
    expect(await sourceGit(f.project, ['status', '--porcelain'])).toBe('');
  } finally {
    await f.close();
  }
}, 15000);

for (const variant of [
  'escape',
  'absolute',
  'private',
  'untracked',
  'dangling',
  'cycle',
  'directory',
])
  test(`real CLI explains and rejects a ${variant} source alias without leaking target content`, async () => {
    const f = await fixture();
    const privateContent = 'source-link-fixture-content-must-never-reach-diagnostics';
    try {
      let target = 'absent.md';
      if (variant === 'escape') {
        target = '../outside.md';
        await Bun.write(join(f.root, 'outside.md'), privateContent);
      } else if (variant === 'absolute') {
        target = join(f.project, 'AGENTS.md');
      } else if (variant === 'private') {
        target = '.env';
        await Bun.write(join(f.project, '.env'), privateContent);
      } else if (variant === 'untracked') {
        target = 'untracked.md';
        await Bun.write(join(f.project, 'untracked.md'), privateContent);
      } else if (variant === 'cycle') {
        target = 'OTHER.md';
        await symlink('CLAUDE.md', join(f.project, 'OTHER.md'));
      } else if (variant === 'directory') {
        target = 'docs';
        await Bun.write(join(f.project, 'docs/README.md'), '# A directory, not a file\n');
      }
      await symlink(target, join(f.project, 'CLAUDE.md'));
      const head = await f.commit();
      const rejected = await f.dry();
      expect(rejected.code, rejected.out + rejected.err).toBe(1);
      const error = JSON.parse(rejected.out).error;
      expect(['SOURCE_PATH', 'SOURCE_SECRET']).toContain(error.code);
      expect(rejected.out + rejected.err).toContain('CLAUDE.md');
      expect(rejected.out + rejected.err).toMatch(/link|symlink|alias/i);
      expect(rejected.out + rejected.err).not.toContain(privateContent);
      expect(`${error.message} ${error.recovery ?? ''}`).toMatch(
        /replace|remove|target|link|alias|track|history/i,
      );
      expect(await readlink(join(f.project, 'CLAUDE.md'))).toBe(target);
      expect(await sourceGit(f.project, ['rev-parse', 'HEAD'])).toBe(head);
    } finally {
      await f.close();
    }
  }, 15000);

for (const path of ['napplet.json', 'index.html'])
  test(`real CLI keeps ${path} regular-only even with a safe selected alias target`, async () => {
    const f = await fixture();
    try {
      const target = `original-${path}`;
      await rename(join(f.project, path), join(f.project, target));
      await symlink(target, join(f.project, path));
      await f.commit();
      const rejected = await f.dry();
      expect(rejected.code).toBe(1);
      const { error } = JSON.parse(rejected.out);
      expect(error.code).toBe('SOURCE_PATH');
      expect(error.message).toContain(path);
      expect(error.message).toContain('must be a regular file');
      expect(await readlink(join(f.project, path))).toBe(target);
    } finally {
      await f.close();
    }
  });

for (const variant of ['space', 'submodule', 'secret-path'])
  test(`real CLI identifies a historical ${variant} entry and redacts credentials`, async () => {
    const f = await fixture();
    try {
      const initial = await f.commit();
      const secret = 'nsec1' + 'q'.repeat(58);
      const path =
        variant === 'submodule'
          ? 'library'
          : variant === 'space'
            ? 'public notes.md'
            : `${secret} notes.md`;
      if (variant === 'submodule') {
        await sourceGit(f.project, [
          'update-index',
          '--add',
          '--cacheinfo',
          `160000,${initial},${path}`,
        ]);
        await sourceGit(f.project, ['commit', '-m', 'Historical unsupported entry']);
      } else {
        await Bun.write(join(f.project, path), 'Ordinary public documentation');
        await f.commit();
      }
      const containing = await sourceGit(f.project, ['rev-parse', 'HEAD']);
      await sourceGit(f.project, ['rm', '--cached', '--', path]);
      if (variant !== 'submodule') await rm(join(f.project, path));
      await sourceGit(f.project, ['commit', '-m', 'Remove entry from current source']);
      const head = await sourceGit(f.project, ['rev-parse', 'HEAD']);
      const result = await f.dry();
      if (variant === 'submodule') {
        expect(result.code, result.out + result.err).toBe(0);
        expect(JSON.parse(result.out).sourceHistory.status).toBe('checked');
        expect(await sourceGit(f.project, ['rev-parse', 'HEAD'])).toBe(head);
        return;
      }
      expect(result.code, result.out + result.err).toBe(1);
      const error = JSON.parse(result.out).error;
      expect(error.code).toBe('SOURCE_PATH');
      expect(error.message).toContain(variant === 'submodule' ? 'submodule entries' : 'whitespace');
      expect(error.details.join('\n')).toContain(containing);
      expect(error.recovery).toContain('not a credential detection');
      expect(result.out + result.err).not.toContain(secret);
      if (variant !== 'secret-path') expect(error.message).toContain(path);
      expect(await sourceGit(f.project, ['rev-parse', 'HEAD'])).toBe(head);
      expect(await sourceGit(f.project, ['status', '--porcelain'])).toBe('');
    } finally {
      await f.close();
    }
  }, 15000);
