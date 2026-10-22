import { expect, test } from 'bun:test';
import { mkdir, mkdtemp, readlink, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sourceGit } from '../../packages/grasp/src/client';
import { sha256 } from '../../packages/protocol/src';

const command = process.env.SPACE_TEST_CLI
  ? [process.env.SPACE_TEST_CLI]
  : [process.execPath, new URL('../index.ts', import.meta.url).pathname];

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'soyli-git-metadata-'));
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
      name: 'Git metadata',
      entry: 'index.html',
      previewId: crypto.randomUUID(),
      license: 'MIT',
    }),
  );
  await Bun.write(join(project, 'index.html'), '<!doctype html><title>Git metadata</title>');
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
      await sourceGit(project, ['commit', '-m', 'Git metadata checkpoint']);
      return sourceGit(project, ['rev-parse', 'HEAD']);
    },
    close: () => rm(root, { recursive: true, force: true }),
  };
}

test('real CLI dry-run accepts empty Git metadata and preserves deleted metadata history', async () => {
  const f = await fixture();
  try {
    await Bun.write(join(f.project, '.gitmodules'), '');
    await Bun.write(join(f.project, '.gitattributes'), '* text=auto\n');
    const original = await f.commit();
    const accepted = await f.dry();
    expect(accepted.code, accepted.out + accepted.err).toBe(0);
    const result = JSON.parse(accepted.out);
    expect(result.sourceHistory.status).toBe('checked');
    expect(result.plan.files).toContainEqual({
      path: '.gitmodules',
      hash: await sha256(new Uint8Array()),
      size: 0,
    });
    expect(result.plan.files.some((file: { path: string }) => file.path === '.gitattributes')).toBe(
      true,
    );
    await sourceGit(f.project, ['rm', '.gitmodules', '.gitattributes']);
    const head = await f.commit();
    const historical = await f.dry();
    expect(historical.code, historical.out + historical.err).toBe(0);
    expect(JSON.parse(historical.out).sourceHistory.status).toBe('checked');
    expect(await sourceGit(f.project, ['rev-parse', 'HEAD'])).toBe(head);
    expect(await sourceGit(f.project, ['rev-parse', 'HEAD^'])).toBe(original);
    expect(await sourceGit(f.project, ['status', '--porcelain'])).toBe('');
  } finally {
    await f.close();
  }
}, 15000);

test('real CLI accepts source-code and Git metadata symlinks in current source and history', async () => {
  const f = await fixture();
  const code = 'export const answer = 42;\n';
  const attributes = '* text=auto\n';
  try {
    await Bun.write(join(f.project, 'src/shared.ts'), code);
    await Bun.write(join(f.project, '.gitmodules'), '');
    await Bun.write(join(f.project, '.gitattributes'), attributes);
    const links = {
      'src/alias.ts': 'shared.ts',
      'src/chain.ts': 'alias.ts',
      'modules-alias': '.gitmodules',
      'attributes-alias': '.gitattributes',
    };
    for (const [path, target] of Object.entries(links))
      await symlink(target, join(f.project, path));
    const checkpoint = await f.run([
      'checkpoint',
      'Source symlinks',
      '--project',
      f.project,
      '--json',
    ]);
    expect(checkpoint.code, checkpoint.out + checkpoint.err).toBe(0);
    const original = await sourceGit(f.project, ['rev-parse', 'HEAD']);
    const accepted = await f.dry();
    expect(accepted.code, accepted.out + accepted.err).toBe(0);
    const result = JSON.parse(accepted.out);
    expect(result.sourceHistory.status).toBe('checked');
    for (const [path, text] of Object.entries({
      'src/alias.ts': code,
      'src/chain.ts': code,
      'modules-alias': '',
      'attributes-alias': attributes,
    })) {
      const bytes = new TextEncoder().encode(text);
      expect(result.plan.files).toContainEqual({
        path,
        hash: await sha256(bytes),
        size: bytes.length,
      });
      expect(await readlink(join(f.project, path))).toBe(links[path as keyof typeof links]);
      expect(await sourceGit(f.project, ['ls-tree', 'HEAD', path])).toStartWith('120000 blob ');
    }
    await sourceGit(f.project, ['rm', ...Object.keys(links)]);
    const head = await f.commit();
    const historical = await f.dry();
    expect(historical.code, historical.out + historical.err).toBe(0);
    expect(JSON.parse(historical.out).sourceHistory.status).toBe('checked');
    expect(await sourceGit(f.project, ['rev-parse', 'HEAD'])).toBe(head);
    expect(await sourceGit(f.project, ['rev-parse', 'HEAD^'])).toBe(original);
    expect(await sourceGit(f.project, ['status', '--porcelain'])).toBe('');
  } finally {
    await f.close();
  }
}, 15000);

test('real CLI explains current submodule removal without history cleanup and redacts its path', async () => {
  const f = await fixture();
  const secret = 'nsec1' + 'q'.repeat(58);
  const path = `library-${secret}`;
  try {
    const original = await f.commit();
    await mkdir(join(f.project, path));
    await sourceGit(f.project, ['update-index', '--add', '--cacheinfo', `160000,${original},${path}`]);
    await sourceGit(f.project, ['commit', '-m', 'Current submodule']);
    const head = await sourceGit(f.project, ['rev-parse', 'HEAD']);
    for (const json of [false, true]) {
      const result = await f.run(['publish', '--project', f.project, ...(json ? ['--json'] : [])]);
      expect(result.code, result.out + result.err).toBe(1);
      expect(result.out + result.err).not.toContain(secret);
      if (json) {
        const error = JSON.parse(result.out).error;
        expect(error.code).toBe('SOURCE_PATH');
        expect(error.message).toContain('submodule entries');
        expect(error.details.join('\n')).toContain(head);
        expect(error.recovery).toContain('ordinary commit');
        expect(error.recovery).toContain('No history rewrite is needed');
        expect(error.recovery).not.toContain('history cleanup');
      } else {
        expect(result.err).toContain('ordinary commit');
        expect(result.err).toContain('No history rewrite is needed');
      }
    }
    expect(await sourceGit(f.project, ['rev-parse', 'HEAD'])).toBe(head);
    await sourceGit(f.project, ['rm', '--cached', '--', path]);
    await rm(join(f.project, path), { recursive: true });
    await sourceGit(f.project, ['commit', '-m', 'Remove current submodule']);
    const fixed = await f.dry();
    expect(fixed.code, fixed.out + fixed.err).toBe(0);
    expect(JSON.parse(fixed.out).sourceHistory.status).toBe('checked');
    expect(await sourceGit(f.project, ['rev-parse', 'HEAD^'])).toBe(head);
    expect(await sourceGit(f.project, ['status', '--porcelain'])).toBe('');
  } finally {
    await f.close();
  }
}, 15000);
