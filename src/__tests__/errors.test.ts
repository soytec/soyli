import { expect, test } from 'bun:test';
import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pins from '../../vendor/toolchain.json';
import { sourceGit } from '../../packages/grasp/src/client';
import { encodeAddress } from '../../packages/protocol/src';

const command = process.env.SPACE_TEST_CLI
  ? [process.env.SPACE_TEST_CLI]
  : [process.execPath, new URL('../index.ts', import.meta.url).pathname];

test('real CLI dry-run reports historical source blockers and accepts only removed public backend context', async () => {
  const root = await mkdtemp(join(tmpdir(), 'soyli-history-errors-'));
  const project = join(root, 'project');
  const run = async (args: string[]) => {
    const child = Bun.spawn([...command, ...args, '--network', 'local'], {
      cwd: root,
      env: {
        PATH: process.env.PATH,
        SPACE_ACCOUNT_HOME: join(root, 'accounts'),
        SOYLI_DANGEROUS_PLAINTEXT_KEYS: '1', // disposable fixture; never touch the OS keychain
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
  try {
    const created = await run(['account', 'create', '--json']);
    expect(created.code, created.out + created.err).toBe(0);
    await Bun.write(
      join(project, 'napplet.json'),
      JSON.stringify({
        schema: 'space-local-project/v1',
        name: 'History fixture',
        entry: 'index.html',
        previewId: crypto.randomUUID(),
        license: 'MIT',
      }),
    );
    await Bun.write(join(project, 'index.html'), '<!doctype html><title>History fixture</title>');
    await Bun.write(join(project, 'LICENSE'), 'MIT');
    const path = '.napplet-space/soy-backend.json';
    await Bun.write(
      join(project, path),
      JSON.stringify({
        version: 1,
        napplet: encodeAddress({ kind: 35129, pubkey: 'a'.repeat(64), identifier: 'test' }),
        boards: [],
        modules: ['world'],
      }),
    );
    await sourceGit(project, ['init']);
    await sourceGit(project, ['add', '.']);
    await sourceGit(project, ['commit', '-m', 'Historical public context']);
    await sourceGit(project, ['rm', path]);
    await Bun.write(join(project, '.gitignore'), '.napplet-space/\n');
    await sourceGit(project, ['add', '.']);
    await sourceGit(project, ['commit', '-m', 'Keep generated context ignored']);
    const accepted = await run(['publish', '--dry-run', '--project', project, '--json']);
    expect(accepted.code, accepted.out + accepted.err).toBe(0);
    expect(JSON.parse(accepted.out).sourceHistory).toMatchObject({
      status: 'checked',
      legacyPublicContexts: [{ path }],
    });
    const privatePath = '.napplet-space/project.json';
    const secret = 'fixture-history-secret-do-not-print';
    await Bun.write(join(project, privatePath), JSON.stringify({ privateKey: secret }));
    await sourceGit(project, ['add', '-f', privatePath]);
    await sourceGit(project, ['commit', '-m', 'Private historical file']);
    const badCommit = await sourceGit(project, ['rev-parse', 'HEAD']);
    const blob = await sourceGit(project, ['rev-parse', `HEAD:${privatePath}`]);
    await sourceGit(project, ['rm', privatePath]);
    await sourceGit(project, ['commit', '-m', 'Removed private file']);
    const head = await sourceGit(project, ['rev-parse', 'HEAD']);
    for (const dry of [true, false])
      for (const json of [true, false]) {
        const rejected = await run([
          'publish',
          '--project',
          project,
          ...(dry ? ['--dry-run'] : []),
          ...(json ? ['--json'] : []),
        ]);
        expect(rejected.code, rejected.out + rejected.err).toBe(1);
        const text = rejected.out + rejected.err;
        expect(text).toContain(privatePath);
        expect(text).toContain(blob);
        expect(text).toContain(badCommit);
        expect(text).toContain('history cleanup');
        expect(text).not.toContain(secret);
        expect(text).not.toContain('Remove it from publish.files');
        if (json)
          expect(JSON.parse(rejected.out).error).toMatchObject({
            code: 'SOURCE_SECRET',
            operation: 'inspect public Git history',
            retryable: false,
            recovery: expect.stringContaining('history cleanup'),
          });
      }
    expect(await sourceGit(project, ['rev-parse', 'HEAD'])).toBe(head);
    expect(await sourceGit(project, ['status', '--porcelain'])).toBe('');
    const status = await run(['status', '--project', project, '--json']);
    expect(status.code).toBe(0);
    expect(JSON.parse(status.out)).toEqual({ status: 'not_started' });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}, 15000);

test('Git failures reach the real CLI with stdout, stderr, status and redaction', async () => {
  const root = await mkdtemp(join(tmpdir(), 'soyli-git-errors-'));
  try {
    const bin = join(root, 'tools');
    await mkdir(bin);
    const git = Bun.which('git')!;
    await writeFile(
      join(bin, 'git'),
      `#!/bin/sh
for arg in "$@"; do
  if [ "$arg" = commit ]; then
    printf 'CONFLICT: fixture game.ts needs attention\\n'
    printf 'Authorization: Bearer fixture-git-token\\n'
    printf 'fixture: cannot finish Git operation\\n' >&2
    exit 23
  fi
done
exec '${git.replace(/'/g, "'\\''")}' "$@"
`,
      { mode: 0o755 },
    );
    const project = join(root, 'project');
    await Bun.write(join(project, 'game.ts'), 'export const game = true;');
    for (const json of [false, true]) {
      const child = Bun.spawn(
        [...command, 'checkpoint', 'Fixture', '--project', project, ...(json ? ['--json'] : [])],
        {
          cwd: project,
          env: { PATH: `${bin}:${process.env.PATH}`, SPACE_ACCOUNT_HOME: join(root, 'accounts') },
          stdin: 'ignore',
          stdout: 'pipe',
          stderr: 'pipe',
        },
      );
      const [code, out, err] = await Promise.all([
        child.exited,
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
      ]);
      expect(code).toBe(1);
      const text = out + err;
      expect(text).not.toContain('fixture-git-token');
      expect(text).toContain('game.ts needs attention');
      expect(text).toContain('cannot finish Git operation');
      expect(text).toContain('Exit status: 23');
      if (json)
        expect(JSON.parse(out).error).toMatchObject({
          code: 'GIT_COMMAND',
          operation: 'Git commit',
        });
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('real CLI preserves actionable dependency errors and identifies missing project files', async () => {
  const root = await mkdtemp(join(tmpdir(), 'soyli-errors-'));
  const run = async () => {
    const child = Bun.spawn([...command, 'backend', 'status', '--project', root, '--json'], {
      cwd: root,
      env: { PATH: process.env.PATH, SPACE_ACCOUNT_HOME: join(root, 'accounts') },
      stdin: 'ignore',
      stdout: 'pipe',
      stderr: 'pipe',
    });
    const [code, out, err] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    expect(code, out + err).toBe(1);
    expect(err).toBe('');
    return JSON.parse(out).error;
  };
  try {
    const missing = await run();
    expect(missing.code).toBe('ENOENT');
    expect(missing.message).toContain('napplet.json');
    expect(missing.operation).toContain('backend');
    expect(missing.recovery).toBeTruthy();
    await writeFile(
      join(root, 'napplet.json'),
      JSON.stringify({
        schema: 'space-local-project/v1',
        name: 'Fixture',
        entry: 'index.html',
        previewId: crypto.randomUUID(),
        license: 'MIT',
      }),
    );
    const actionable = await run();
    expect(actionable.message).toContain('Add backend:');
    expect(actionable.message).toContain('napplet.json');
    expect(actionable.code).not.toBe('CLI_FAILED');
    const invalidSchema = {
      schema: 'space-local-project/v1',
      name: 'Fixture',
      entry: 'index.html',
      previewId: crypto.randomUUID(),
      license: 'MIT',
      backend: {
        boards: [
          {
            board: 'race',
            title: 'Race',
            order: 'lowest',
            minimum: 1,
            maximum: 100,
            dataSchema: {
              type: 'object',
              properties: { car: { type: 'string', pattern: 'private-schema-pattern' } },
            },
          },
        ],
      },
    };
    await writeFile(join(root, 'napplet.json'), JSON.stringify(invalidSchema));
    const schemaError = await run();
    expect(schemaError.message).toContain('dataSchema');
    expect(schemaError.message).toContain('Unsupported schema keyword pattern');
    expect(JSON.stringify(schemaError)).not.toContain('private-schema-pattern');
    await writeFile(join(root, 'napplet.json'), '{"password":"do-not-print-my-password",');
    const invalid = await run();
    expect(invalid.code).toBe('INVALID_JSON');
    expect(JSON.stringify(invalid)).not.toContain('do-not-print-my-password');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('wrapped tool failures retain exit status and stderr in both terminal and JSON output', async () => {
  const root = await mkdtemp(join(tmpdir(), 'soyli-tool-errors-'));
  try {
    // Isolated executable fixtures exercise the real wrapper without downloads,
    // global toolchain changes, credentials or project scripts.
    const cache = join(root, 'toolchain');
    for (const pin of [pins.node, pins.nodeLegacyMac]) {
      const archive = (pin.platforms as Record<string, { directory: string }>)[
        `${process.platform}-${process.arch}`
      ];
      if (!archive) continue;
      const bin = join(cache, archive.directory, 'bin');
      await mkdir(bin, { recursive: true });
      await writeFile(
        join(bin, 'node'),
        `#!/bin/sh
if [ "$1" = --version ]; then printf 'v${pin.version}\\n'; exit 0; fi
printf 'Authorization: Bearer fixture-token\\n' >&2
printf 'fixture: could not resolve src/missing.ts\\n' >&2
exit 23
`,
        { mode: 0o755 },
      );
    }
    const pnpm = join(cache, `pnpm-${pins.pnpm.version}`, 'package/bin');
    await mkdir(pnpm, { recursive: true });
    await writeFile(join(pnpm, 'pnpm.cjs'), '// fixture');
    await writeFile(
      join(root, 'package.json'),
      JSON.stringify({ packageManager: `pnpm@${pins.pnpm.version}` }),
    );
    for (const json of [false, true]) {
      const child = Bun.spawn(
        [...command, 'setup', '--project', root, ...(json ? ['--json'] : [])],
        {
          cwd: root,
          env: {
            PATH: '/usr/bin:/bin',
            SPACE_TOOLCHAIN_CACHE: cache,
            SPACE_ACCOUNT_HOME: join(root, 'accounts'),
          },
          stdin: 'ignore',
          stdout: 'pipe',
          stderr: 'pipe',
        },
      );
      const [code, stdout, stderr] = await Promise.all([
        child.exited,
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
      ]);
      expect(code).toBe(1);
      expect(stdout + stderr).not.toContain('fixture-token');
      if (json) {
        const { error } = JSON.parse(stdout);
        expect(error.code).toBe('PROJECT_TOOL');
        expect(error.operation).toBe('install project dependencies');
        expect(error.details).toContain('Exit status: 23');
        expect(error.details.join('\n')).toContain('could not resolve src/missing.ts');
      } else {
        expect(stderr).toContain('Exit status: 23');
        expect(stderr).toContain('could not resolve src/missing.ts');
        expect(stderr).toContain('Next:');
      }
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('a packager-provided toolchain is used without downloads and reports mismatches', async () => {
  const root = await mkdtemp(join(tmpdir(), 'soyli-provided-toolchain-'));
  try {
    const provided = join(root, 'provided');
    await mkdir(provided, { recursive: true });
    const node = join(provided, 'node');
    const pnpm = join(provided, 'pnpm.cjs');
    await writeFile(pnpm, '// fixture');
    await writeFile(
      join(root, 'package.json'),
      JSON.stringify({ packageManager: `pnpm@${pins.pnpm.version}` }),
    );
    const cache = join(root, 'cache');
    const setup = async (env: Record<string, string>) => {
      const child = Bun.spawn([...command, 'setup', '--project', root, '--json'], {
        cwd: root,
        env: {
          PATH: '/usr/bin:/bin',
          SPACE_TOOLCHAIN_CACHE: cache,
          SPACE_ACCOUNT_HOME: join(root, 'accounts'),
          ...env,
        },
        stdin: 'ignore',
        stdout: 'pipe',
        stderr: 'pipe',
      });
      const [code, stdout, stderr] = await Promise.all([
        child.exited,
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
      ]);
      expect(code, stdout + stderr).toBe(1);
      expect(stderr).not.toContain('Preparing');
      return JSON.parse(stdout).error;
    };
    const fixture = (version: string) =>
      writeFile(
        node,
        `#!/bin/sh
if [ "$1" = --version ]; then printf '${version}\\n'; exit 0; fi
printf 'fixture: provided node ran\\n' >&2
exit 29
`,
        { mode: 0o755 },
      );
    const pinned = process.platform === 'darwin' ? undefined : `v${pins.node.version}`;
    if (pinned) {
      await fixture(pinned);
      const used = await setup({ SOYLI_NODE: node, SOYLI_PNPM: pnpm });
      expect(used.code).toBe('PROJECT_TOOL');
      expect(used.details.join('\n')).toContain('provided node ran');
      // Only the writable pnpm link directory is created; nothing was downloaded.
      expect((await readdir(cache)).filter((name) => !name.startsWith('bin-'))).toEqual([]);
    }
    await fixture('v0.0.1');
    const mismatch = await setup({ SOYLI_NODE: node, SOYLI_PNPM: pnpm });
    expect(mismatch.code).toBe('TOOLCHAIN_VERSION');
    expect(mismatch.details).toContain(`Target: ${node}`);
    expect(mismatch.recovery).toContain('SOYLI_NODE');
    const incomplete = await setup({ SOYLI_NODE: node });
    expect(incomplete.code).toBe('TOOLCHAIN_PROVIDED');
    expect(incomplete.recovery).toContain('SOYLI_PNPM');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('snapshot is an explicit publication option and invalid use reports recovery through the real CLI', async () => {
  for (const args of [
    ['status', '--snapshot'],
    ['check', '--snapshot'],
  ]) {
    const child = Bun.spawn([...command, ...args, '--json'], {
      stdin: 'ignore',
      stdout: 'pipe',
      stderr: 'pipe',
    });
    const [code, out, err] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    expect(code, out + err).not.toBe(0);
    const diagnostic = JSON.parse(out).error;
    expect(diagnostic.code).toBe('USAGE');
    expect(diagnostic.message).toContain('only with soyli publish');
  }
  const help = Bun.spawn([...command, '--help'], { stdout: 'pipe', stderr: 'pipe' });
  expect(await new Response(help.stdout).text()).toContain(
    'publish [--project <folder>] [--snapshot]',
  );
  expect(await help.exited).toBe(0);
});
