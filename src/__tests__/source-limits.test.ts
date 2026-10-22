import { expect, test } from 'bun:test';
import { mkdtemp, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sourceGit } from '../../packages/grasp/src/client';

const command = process.env.SPACE_TEST_CLI
  ? [process.env.SPACE_TEST_CLI]
  : [process.execPath, new URL('../index.ts', import.meta.url).pathname];

test('real CLI accepts 131 tracked files plus a 12 MiB built entry and explains the 1024-input boundary', async () => {
  const root = await mkdtemp(join(tmpdir(), 'soyli-source-limit-'));
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
  const dry = () => run(['publish', '--dry-run', '--project', project, '--json']);
  try {
    const account = await run(['account', 'create', '--json']);
    expect(account.code, account.out + account.err).toBe(0);
    const config = {
      schema: 'space-local-project/v1',
      name: 'Large project',
      entry: 'dist/index.html',
      previewId: crypto.randomUUID(),
      license: 'MIT',
      // This list is additive: it must not hide the tracked files below.
      publish: { files: ['index.html', 'napplet.json', 'LICENSE'] },
    };
    await Bun.write(join(project, 'napplet.json'), JSON.stringify(config));
    await Bun.write(join(project, 'index.html'), '<!doctype html><title>Source</title>');
    const builtBytes = 12 * 1024 * 1024;
    await Bun.write(
      join(project, 'dist/index.html'),
      '<!doctype html><title>Built</title>'.padEnd(builtBytes, ' '),
    );
    await Bun.write(join(project, 'LICENSE'), 'MIT');
    await Bun.write(join(project, '.gitignore'), '.napplet-space/\ndist/\n');
    for (let i = 0; i < 127; i++)
      await Bun.write(join(project, `src/${String(i).padStart(4, '0')}.ts`), 'export {};\n');
    await sourceGit(project, ['init']);
    await sourceGit(project, ['add', '.']);
    await sourceGit(project, ['commit', '-m', '131 tracked source files']);
    const accepted = await dry();
    expect(accepted.code, accepted.out + accepted.err).toBe(0);
    expect(JSON.parse(accepted.out).plan.files).toHaveLength(132);
    expect(JSON.parse(accepted.out).plan.files).toContainEqual(
      expect.objectContaining({ path: 'dist/index.html', size: builtBytes }),
    );
    expect(JSON.parse(accepted.out).sourceHistory.status).toBe('checked');

    await symlink('index.html', join(project, 'CLAUDE.md'));
    await sourceGit(project, ['add', '.']);
    await sourceGit(project, ['commit', '-m', 'Historical internal file alias']);
    const linked = await dry();
    expect(linked.code, linked.out + linked.err).toBe(0);
    const linkedFiles = JSON.parse(linked.out).plan.files;
    expect(linkedFiles.find((file: { path: string }) => file.path === 'CLAUDE.md')).toEqual({
      ...linkedFiles.find((file: { path: string }) => file.path === 'index.html'),
      path: 'CLAUDE.md',
    });
    await rm(join(project, 'CLAUDE.md'));
    await Bun.write(join(project, 'CLAUDE.md'), 'See index.html.\n');
    await sourceGit(project, ['add', '.']);
    await sourceGit(project, ['commit', '-m', 'Replace alias without rewriting history']);
    const historical = await dry();
    expect(historical.code, historical.out + historical.err).toBe(0);
    expect(JSON.parse(historical.out).sourceHistory.status).toBe('checked');
    await sourceGit(project, ['rm', 'CLAUDE.md']);
    await sourceGit(project, ['commit', '-m', 'Remove optional guide']);

    // 1023 tracked files + the ignored built artifact = 1024 selected inputs.
    for (let i = 127; i < 1019; i++)
      await Bun.write(join(project, `src/${String(i).padStart(4, '0')}.ts`), 'export {};\n');
    await sourceGit(project, ['add', '.']);
    await sourceGit(project, ['commit', '-m', 'Reach the supported input boundary']);
    const boundary = await dry();
    expect(boundary.code, boundary.out + boundary.err).toBe(0);
    expect(JSON.parse(boundary.out).plan.files).toHaveLength(1024);

    await Bun.write(join(project, 'src/extra.ts'), 'export {};\n');
    const rejected = await dry();
    expect(rejected.code).toBe(1);
    const error = JSON.parse(rejected.out).error;
    expect(error.code).toBe('SOURCE_LIMIT');
    expect(error.message).toContain('1025');
    expect(error.message).toContain('1024');
    expect(error.message).toContain('publish.files is additive');
    expect(error.message).toContain('tracked');

    await rm(join(project, 'src/extra.ts'));
    await symlink('.git/config', join(project, 'CLAUDE.md'));
    await sourceGit(project, ['add', 'CLAUDE.md']);
    await sourceGit(project, ['commit', '-m', 'Unsafe historical alias']);
    const blockedCommit = await sourceGit(project, ['rev-parse', 'HEAD']);
    await sourceGit(project, ['rm', 'CLAUDE.md']);
    await sourceGit(project, ['commit', '-m', 'Remove unsafe alias from current tree']);
    const unsafe = await dry();
    expect(unsafe.code).toBe(1);
    expect(JSON.parse(unsafe.out).error.code).toBe('SOURCE_SECRET');
    expect(unsafe.out).toContain('CLAUDE.md');
    expect(unsafe.out).toContain(blockedCommit);
    expect(unsafe.out).toContain('history cleanup');
    expect(unsafe.out).not.toContain('Remove it from publish.files');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}, 30000);
