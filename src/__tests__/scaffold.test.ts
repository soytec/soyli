import { afterAll, expect, test } from 'bun:test';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sourceGit } from '../../packages/grasp/src/client';
// Exercise the shipped command in its own process. Besides checking the real
// entrypoint, this avoids Bun 1.3.11 build/read failures observed after unrelated
// filesystem/network tests in the same VM.
async function scaffold(parent: string, name: string, template: string) {
  const child = Bun.spawn(
    [
      process.execPath,
      new URL('../index.ts', import.meta.url).pathname,
      'new',
      name,
      '--template',
      template,
      '--identity',
      'later',
    ],
    {
      cwd: parent,
      stdout: 'pipe',
      stderr: 'pipe',
    },
  );
  const [code, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  if (code !== 0) throw new Error(stderr || stdout);
  return join(parent, name);
}
const root = await mkdtemp(join(tmpdir(), 'space-cli-test-'));
afterAll(() => rm(root, { recursive: true, force: true }));
test('bootstrap supports older Git and preserves actionable, redacted initialization and checkpoint errors', async () => {
  const tools = join(root, 'old-git-tools');
  await mkdir(tools);
  await writeFile(
    join(tools, 'git'),
    `#!/bin/sh
for argument in "$@"; do
  case "$argument" in --initial-branch*) exit 129;; esac
  if [ "$argument" = init ]; then
    case "$PWD" in */git-init-failure) printf 'fixture: repository initialization refused\n' >&2; exit 7;; esac
  fi
  if [ "$argument" = add ]; then
    case "$PWD" in */git-stage-failure) printf 'fixture: index.lock is held\ntoken=fixture-scaffold-secret\n' >&2; exit 8;; esac
  fi
  if [ "$argument" = commit ]; then
    case "$PWD" in */git-commit-failure*) printf 'fixture: cannot write commit object\ntoken=fixture-scaffold-secret\n' >&2; exit 9;; esac
  fi
done
exec '${Bun.which('git')!.replaceAll("'", "'\\''")}' "$@"
`,
    { mode: 0o755 },
  );
  const run = async (name: string, json = true) => {
    const child = Bun.spawn(
      [
        process.execPath,
        new URL('../index.ts', import.meta.url).pathname,
        'new',
        name,
        '--identity',
        'later',
        '--no-install',
        ...(json ? ['--json'] : []),
      ],
      {
        cwd: root,
        env: {
          PATH: `${tools}:${process.env.PATH}`,
          SPACE_ACCOUNT_HOME: join(root, 'isolated-accounts'),
        },
        stdout: 'pipe',
        stderr: 'pipe',
      },
    );
    const [code, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    return { code, data: json ? JSON.parse(stdout) : undefined, stdout, stderr };
  };
  const created = await run('intel-boilerplate');
  expect(created.code).toBe(0);
  const head = Bun.spawn(['git', '-C', join(root, 'intel-boilerplate'), 'symbolic-ref', 'HEAD'], {
    stdout: 'pipe',
  });
  expect(await new Response(head.stdout).text()).toBe('refs/heads/main\n');
  expect(await head.exited).toBe(0);
  await writeFile(join(root, 'intel-boilerplate/README.md'), 'Keep my work');
  const repeated = await run('intel-boilerplate');
  expect(repeated.data.error.code).toBe('DESTINATION_EXISTS');
  expect(await Bun.file(join(root, 'intel-boilerplate/README.md')).text()).toBe('Keep my work');
  const failed = await run('git-init-failure');
  expect(failed.data.error.code).toBe('GIT_INIT_FAILED');
  expect(failed.data.error.message).toContain('git-init-failure');
  expect(failed.data.error.details.join('\n')).toContain('repository initialization refused');
  expect(failed.data.error.details.join('\n')).toContain('Exit status: 7');
  for (const [name, message, status] of [
    ['git-stage-failure', 'index.lock is held', 8],
    ['git-commit-failure', 'cannot write commit object', 9],
  ] as const) {
    const failure = await run(name);
    expect(failure.code).toBe(1);
    expect(failure.data.error.code).toBe('GIT_INITIAL_COMMIT_FAILED');
    expect(failure.data.error.operation).toBe('save initial scaffold checkpoint');
    expect(failure.data.error.details.join('\n')).toContain(message);
    expect(failure.data.error.details.join('\n')).toContain(`Exit status: ${status}`);
    expect(failure.data.error.recovery).toContain('soyli checkpoint');
    expect(failure.data.error.message).toContain(join(root, name));
    expect(failure.stdout + failure.stderr).not.toContain('fixture-scaffold-secret');
    expect(await Bun.file(join(root, name, 'src/main.ts')).exists()).toBe(true);
    expect(await sourceGit(join(root, name), ['status', '--porcelain'])).not.toBe('');
  }
  const terminal = await run('git-commit-failure-terminal', false);
  expect(terminal.code).toBe(1);
  expect(terminal.stderr).toContain('GIT_INITIAL_COMMIT_FAILED');
  expect(terminal.stderr).toContain('cannot write commit object');
  expect(terminal.stderr).toContain('Exit status: 9');
  expect(terminal.stderr).toContain('soyli checkpoint');
  expect(terminal.stderr).not.toContain('fixture-scaffold-secret');
});

test('new saves the complete scaffold once without a creator, Git identity, signer or global config changes', async () => {
  const parent = join(root, 'initial-checkpoint');
  await mkdir(parent);
  const config = join(parent, 'caller.gitconfig');
  const configText = '[user]\n\tuseConfigOnly = true\n[commit]\n\tgpgSign = true\n';
  await writeFile(config, configText);
  const tools = join(parent, 'tools');
  await mkdir(tools);
  const marker = join(parent, 'signer-invoked');
  for (const executable of ['security', 'secret-tool', 'gpg'])
    await writeFile(join(tools, executable), `#!/bin/sh\ntouch '${marker}'\nexit 91\n`, {
      mode: 0o755,
    });

  // Nested creation must leave the containing repository's history/index alone.
  await sourceGit(parent, ['init']);
  await sourceGit(parent, ['add', 'caller.gitconfig']);
  await sourceGit(parent, ['commit', '-m', 'Existing parent']);
  const parentHead = await sourceGit(parent, ['rev-parse', 'HEAD']);
  const parentIndex = await sourceGit(parent, ['ls-files', '--stage']);
  for (const template of ['boilerplate', 'soft-orbit']) {
    const child = Bun.spawn(
      [
        process.execPath,
        new URL('../index.ts', import.meta.url).pathname,
        'new',
        template,
        '--template',
        template,
        '--identity',
        'later',
        '--no-install',
      ],
      {
        cwd: parent,
        env: {
          ...process.env,
          PATH: `${tools}:${process.env.PATH}`,
          GIT_CONFIG_GLOBAL: config,
          GIT_AUTHOR_NAME: 'Caller identity',
          GIT_AUTHOR_EMAIL: 'caller@example.com',
          SPACE_ACCOUNT_HOME: join(parent, 'no-accounts'),
        },
        stdout: 'pipe',
        stderr: 'pipe',
      },
    );
    const [code, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    expect(code, stderr).toBe(0);
    expect(stdout).toContain('Starting scaffold committed locally. Nothing has been uploaded.');
    const project = join(parent, template);
    expect(await sourceGit(project, ['rev-list', '--count', 'HEAD'])).toBe('1');
    expect(await sourceGit(project, ['status', '--porcelain'])).toBe('');
    expect(await sourceGit(project, ['remote'])).toBe('');
    expect(await sourceGit(project, ['log', '-1', '--format=%s%n%an <%ae>%n%cn <%ce>'])).toBe(
      'Initialize napplet with soyLI\nnapplet soyLI <scaffold@napplet.invalid>\nnapplet soyLI <scaffold@napplet.invalid>',
    );
    const files = (await sourceGit(project, ['ls-tree', '-r', '--name-only', 'HEAD'])).split('\n');
    for (const path of [
      'napplet.json',
      'README.md',
      'AGENTS.md',
      '.gitignore',
      'docs/napplet-space.md',
      '.agents/skills/napplet-make/SKILL.md',
    ])
      expect(files).toContain(path);
    if (template === 'boilerplate') {
      expect(files).toContain('pnpm-lock.yaml');
      expect(files).toContain('napplet.upstream.json');
    }
    expect(files.some((path) => /^(\.napplet-space|node_modules|dist)\//.test(path))).toBe(false);
    expect(await Bun.file(join(project, '.napplet-space/skills.json')).exists()).toBe(true);
    expect(await Bun.file(join(project, '.git/config')).text()).not.toMatch(/\[user\]|\[commit\]/);
    // The first authored edit is a diff against a real starting point.
    await writeFile(join(project, 'README.md'), 'My first change\n');
    await writeFile(join(project, 'docs/napplet-space.md'), 'My project-specific guidance\n');
    expect(await sourceGit(project, ['diff', '--', 'README.md'])).toContain('+My first change');
    const head = await sourceGit(project, ['rev-parse', 'HEAD']);
    const update = Bun.spawn(
      [
        process.execPath,
        new URL('../index.ts', import.meta.url).pathname,
        'skills',
        'update',
        '--project',
        project,
        '--json',
      ],
      { cwd: parent, stdout: 'pipe', stderr: 'pipe' },
    );
    const [updateCode, updateOutput, updateError] = await Promise.all([
      update.exited,
      new Response(update.stdout).text(),
      new Response(update.stderr).text(),
    ]);
    expect(updateCode, updateOutput + updateError).toBe(1);
    expect(JSON.parse(updateOutput).conflicts).toContain('docs/napplet-space.md');
    expect(await Bun.file(join(project, 'docs/napplet-space.md')).text()).toBe(
      'My project-specific guidance\n',
    );
    expect(await sourceGit(project, ['rev-parse', 'HEAD'])).toBe(head);
    expect(await sourceGit(project, ['diff', '--', 'README.md'])).toContain('+My first change');
    expect(await sourceGit(project, ['rev-list', '--count', 'HEAD'])).toBe('1');
  }
  expect(await sourceGit(parent, ['rev-parse', 'HEAD'])).toBe(parentHead);
  expect(await sourceGit(parent, ['ls-files', '--stage'])).toBe(parentIndex);
  expect(await Bun.file(config).text()).toBe(configText);
  expect(await Bun.file(marker).exists()).toBe(false);
});
test('scaffolds a standalone Git project with shared restricted preview', async () => {
  const path = await scaffold(root, 'little-orbit', 'soft-orbit');
  expect(await Bun.file(join(path, 'index.html')).text()).toContain('<canvas');
  expect((await Bun.file(join(path, 'napplet.json')).json()).topics).toEqual([
    'visual',
    'generative',
    'animation',
  ]);
  expect(await Bun.file(join(path, 'AGENTS.md')).text()).toContain('No CDN');
  expect(await Bun.file(join(path, 'dev.ts')).exists()).toBe(false);
  expect((await Bun.file(join(path, 'package.json')).json()).scripts.dev).toBe('soyli dev');
  const process = Bun.spawn(['git', '-C', path, 'rev-parse', '--is-inside-work-tree'], {
    stdout: 'pipe',
  });
  expect(await new Response(process.stdout).text()).toBe('true\n');
  await process.exited;
  await writeFile(join(path, 'index.html'), 'precious existing work');
  await expect(scaffold(root, 'little-orbit', 'soft-orbit')).rejects.toThrow();
  expect(await Bun.file(join(path, 'index.html')).text()).toBe('precious existing work');
});
test('rejects path escape and unknown templates before writing', async () => {
  await expect(scaffold(root, '../escape', 'soft-orbit')).rejects.toThrow('folder name');
  await expect(scaffold(root, 'invalid-template', 'https://evil.example')).rejects.toThrow(
    'Unknown template',
  );
});

test('missing Git gives an actionable error before creating a project', async () => {
  const child = Bun.spawn(
    [
      process.execPath,
      new URL('../index.ts', import.meta.url).pathname,
      'new',
      'needs-git',
      '--identity',
      'later',
      '--json',
    ],
    {
      cwd: root,
      env: { PATH: '/no-installed-tools' },
      stdout: 'pipe',
      stderr: 'pipe',
    },
  );
  const [code, output] = await Promise.all([child.exited, new Response(child.stdout).text()]);
  expect(code).toBe(1);
  expect(JSON.parse(output).error.code).toBe('GIT_REQUIRED');
  expect(await Bun.file(join(root, 'needs-git/index.html')).exists()).toBe(false);
});

test('generated preview runs independently and enforces the shared runtime policy', async () => {
  const path = await scaffold(root, 'running-example', 'tiny-tennis');
  const reservation = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: () => new Response('') });
  const port = reservation.port;
  reservation.stop(true);
  const process = Bun.spawn(
    [
      'bun',
      new URL('../index.ts', import.meta.url).pathname,
      'dev',
      '--no-open',
      '--port',
      String(port),
    ],
    {
      cwd: path,
      env: { PATH: String(Bun.env.PATH ?? ''), PORT: String(port) },
      stdout: 'ignore',
      stderr: 'pipe',
    },
  );
  try {
    let ready = false;
    for (let attempt = 0; attempt < 40; attempt++) {
      try {
        if ((await fetch(`http://127.0.0.1:${port}/revision`)).ok) {
          ready = true;
          break;
        }
      } catch {}
      await Bun.sleep(50);
    }
    expect(ready).toBe(true);
    const shell = await (await fetch(`http://127.0.0.1:${port}/`)).text();
    const runtimePath = shell.match(/<script[^>]+src="([^"]*runtime\.js)"/)?.[1];
    expect(runtimePath).toBe('./runtime.js');
    const runtime = await fetch(new URL(runtimePath!, `http://127.0.0.1:${port}/`));
    expect(runtime.ok).toBe(true);
    expect(runtime.headers.get('content-type')).toContain('javascript');
    expect(shell).not.toContain('src="/preview"');
    const info = await (await fetch(`http://127.0.0.1:${port}/revision`)).json();
    const response = await fetch(`http://127.0.0.1:${port}/artifacts/${info.artifactHash}`);
    expect(response.headers.get('content-type')).toBe('application/octet-stream');
    expect(await response.text()).toContain('<canvas');
    const resources = (
      manifest: string,
      origin = `http://127.0.0.1:${port}`,
      url = 'data:text/plain,hello',
    ) =>
      fetch(`http://127.0.0.1:${port}/api/resources`, {
        method: 'POST',
        headers: { Origin: origin, 'X-Space-Host': '1' },
        body: JSON.stringify({ manifest, url }),
      });
    expect((await resources(info.id)).status).toBe(405);
    expect((await resources('0'.repeat(64))).status).toBe(405);
    expect((await resources(info.id, 'null')).status).toBe(403);
    expect(
      (await resources(info.id, `http://127.0.0.1:${port}`, 'https://127.0.0.1/private')).status,
    ).toBe(405);
    expect((await fetch(`http://127.0.0.1:${port}/napplet.json`)).status).toBe(404);
    expect(
      (await fetch(`http://127.0.0.1:${port}/revision`, { headers: { Host: 'attacker.example' } }))
        .status,
    ).toBe(403);
  } finally {
    process.kill();
    await process.exited;
  }
});
