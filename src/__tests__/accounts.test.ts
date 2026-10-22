import { expect, test } from 'bun:test';
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getPublicKey } from 'nostr-tools';

test('plaintext opt-in survives CLI restarts and keeps native account selection separate', async () => {
  const home = await mkdtemp(join(tmpdir(), 'soyli-plaintext-cli-'));
  async function invoke(args: string[], enabled: boolean) {
    const child = Bun.spawn(
      [process.execPath, new URL('../index.ts', import.meta.url).pathname, ...args, '--json'],
      {
        cwd: home,
        env: {
          PATH: process.env.PATH,
          SPACE_ACCOUNT_HOME: home,
          ...(enabled ? { SOYLI_DANGEROUS_PLAINTEXT_KEYS: '1' } : {}),
        },
        stdin: 'ignore',
        stdout: 'pipe',
        stderr: 'pipe',
      },
    );
    const [code, output, warning] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    expect(code).toBe(0);
    expect(warning.includes('NOT encrypted')).toBe(enabled);
    return JSON.parse(output);
  }
  try {
    await invoke(['account', 'create'], true);
    await invoke(['account', 'check'], true);
    const selected = await invoke(['account', 'show'], true);
    expect(selected.account).not.toBeNull();
    expect(await invoke(['account', 'show'], false)).toEqual({ account: null });
    expect(await invoke(['account', 'show'], true)).toEqual(selected);
    expect(await Bun.file(join(home, 'accounts/public/accounts.json')).exists()).toBe(false);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
}, 15000);

async function run(args: string[], input = '', onSpawn?: (stop: () => void) => void) {
  const directory = await mkdtemp(join(tmpdir(), 'napplet-account-command-'));
  try {
    const child = Bun.spawn(
      [process.execPath, new URL('../index.ts', import.meta.url).pathname, ...args, '--json'],
      {
        cwd: directory,
        env: { PATH: process.env.PATH, SPACE_ACCOUNT_HOME: directory },
        stdin: new Blob([input]),
        stdout: 'pipe',
        stderr: 'pipe',
      },
    );
    onSpawn?.(() => child.kill('SIGINT'));
    const timer = onSpawn ? setTimeout(() => child.kill('SIGTERM'), 3000) : undefined;
    const [code, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    clearTimeout(timer);
    return {
      code,
      stdout,
      stderr,
      saved: await Bun.file(join(directory, 'accounts/public/accounts.json')).exists(),
    };
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}
test('account show reports absence without provisioning a key or account files', async () => {
  const result = await run(['account', 'show']);
  expect(result.code).toBe(0);
  expect(JSON.parse(result.stdout)).toEqual({ account: null });
  expect(result.saved).toBe(false);
});
test('fresh identity flag cannot silently affect unrelated commands', async () => {
  for (const args of [
    ['account', 'show', '--new'],
    ['new', 'unexpected', '--new'],
  ]) {
    const result = await run(args);
    expect(result.code).toBe(1);
    expect(JSON.parse(result.stdout).error.code).toBe('USAGE');
    expect(result.saved).toBe(false);
  }
});
test('pair reports a one-time connection URI, times out without credentials and rejects unrelated options', async () => {
  const relay = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch: (req, server) => (server.upgrade(req) ? undefined : new Response()),
    websocket: { message() {} },
  });
  try {
    const result = await run([
      'account',
      'pair',
      '--network',
      'local',
      '--signer-relay',
      `ws://127.0.0.1:${relay.port}`,
      '--timeout',
      '1',
    ]);
    expect(result.code).toBe(1);
    const lines = result.stdout
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));
    expect(new URL(lines[0].pairing.uri).protocol).toBe('nostrconnect:');
    expect(lines[1].error.code).toBe('SIGNER_TIMEOUT');
    expect(result.saved).toBe(false);
    expect(result.stdout).not.toContain('clientKey');
    for (const args of [
      ['account', 'pair', '--timeout', '0'],
      ['account', 'pair', '--relay', 'wss://example.test'],
      ['account', 'show', '--signer-relay', 'wss://example.test'],
    ]) {
      const bad = await run(args);
      expect(JSON.parse(bad.stdout).error.code).toBe('USAGE');
    }
  } finally {
    relay.stop(true);
  }
});
test('CLI rejects sensitive arguments and invalid stdin with structured errors that do not echo secrets', async () => {
  const secret = 'nsec1sensitive-input-must-not-appear';
  for (const [args, stdin, code] of [
    [['account', 'import', secret], '', 'USAGE'],
    [['account', 'import', '--nsec', secret], '', 'USAGE'],
    [['account', 'import', '--stdin'], secret, 'INVALID_RECOVERY'],
    [['account', 'connect', '--stdin'], secret, 'INVALID_BUNKER'],
  ] as [string[], string, string][]) {
    const result = await run(args, stdin);
    expect(result.code).toBe(1);
    expect(JSON.parse(result.stdout).error.code).toBe(code);
    expect(result.stdout + result.stderr).not.toContain(secret);
    expect(result.saved).toBe(false);
  }
});

test('real CLI accepts four bunker relays, reaches transport, and gives a specific over-limit error without exposing its secret', async () => {
  let contacted = false;
  let stop: (() => void) | undefined;
  const relay = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch: (request, server) => (server.upgrade(request) ? undefined : new Response()),
    websocket: {
      message() {
        if (!contacted) {
          contacted = true;
          stop?.();
        }
      },
    },
  });
  try {
    const link = new URL(`bunker://${getPublicKey(new Uint8Array(32).fill(2))}`);
    for (let i = 0; i < 4; i++)
      link.searchParams.append('relay', `ws://127.0.0.1:${relay.port}/${i}`);
    link.searchParams.set('secret', 'synthetic-bunker-secret-do-not-echo');
    const accepted = await run(
      ['account', 'connect', '--stdin', '--network', 'local'],
      link.href,
      (cancel) => {
        stop = cancel;
      },
    );
    expect(contacted).toBe(true);
    expect(accepted.stdout + accepted.stderr).not.toContain('INVALID_BUNKER');
    expect(accepted.stdout + accepted.stderr).not.toContain('synthetic-bunker-secret-do-not-echo');
    for (let i = 4; i < 9; i++)
      link.searchParams.append('relay', `ws://127.0.0.1:${relay.port}/${i}`);
    const refused = await run(['account', 'connect', '--stdin', '--network', 'local'], link.href);
    expect(JSON.parse(refused.stdout).error.message).toContain('8 distinct signer relays');
    expect(refused.stdout + refused.stderr).not.toContain('synthetic-bunker-secret-do-not-echo');
  } finally {
    relay.stop(true);
  }
}, 10000);

// Twelve real CLI startups plus scaffolding/Git exceed Bun's 5s default on the VPS.
// Keep a separate deadline on each child so a hang cannot consume the whole budget.
test('boilerplate onboarding reports a reusable backup outside Git and the CLI can restore it', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'napplet-onboarding-backup-'));
  // Exercise the real CLI with an isolated credential-store adapter; never touch OS accounts.
  const preload = join(directory, 'vault-preload.ts');
  await mkdir(join(directory, 'vault'));
  await writeFile(
    preload,
    `
    import { join } from 'node:path';
    import { rm } from 'node:fs/promises';
    import { NativeVault } from ${JSON.stringify(new URL('../../packages/identity/src/accounts.ts', import.meta.url).pathname)};
    const path = (name) => join(process.env.TEST_VAULT, name);
    NativeVault.prototype.get = async (name) => {
      const file = Bun.file(path(name));
      return await file.exists() ? file.text() : null;
    };
    NativeVault.prototype.set = async (name, value) => { await Bun.write(path(name), value); };
    NativeVault.prototype.delete = async (name) => { await rm(path(name), { force: true }); };
  `,
  );
  async function cli(args: string[], accountHome = join(directory, 'accounts'), input = '') {
    const child = Bun.spawn(
      [
        process.execPath,
        '--preload',
        preload,
        new URL('../index.ts', import.meta.url).pathname,
        ...args,
        '--json',
      ],
      {
        cwd: directory,
        env: {
          PATH: process.env.PATH,
          SPACE_ACCOUNT_HOME: accountHome,
          TEST_VAULT: join(directory, 'vault'),
        },
        stdin: new Blob([input]),
        stdout: 'pipe',
        stderr: 'pipe',
      },
    );
    let timedOut = false;
    const deadline = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, 10000);
    try {
      const [code, stdout, stderr] = await Promise.all([
        child.exited,
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
      ]);
      if (timedOut) throw new Error(`CLI ${args.slice(0, 2).join(' ')} timed out after 10 seconds`);
      expect(code).toBe(0);
      expect(stderr).toBe('');
      expect(stdout.includes('nsec1')).toBe(false);
      return JSON.parse(stdout);
    } finally {
      clearTimeout(deadline);
    }
  }
  try {
    const created = await cli(['new', 'my-boilerplate', '--identity', 'create', '--no-install']);
    const { backupFile, account } = created;
    expect(backupFile).toBe(join(directory, 'accounts/accounts/public', `${account.pubkey}.nsec`));
    expect((await stat(backupFile)).mode & 0o777).toBe(0o600);
    const secret = (await readFile(backupFile, 'utf8')).trim();
    const config = await Bun.file(join(created.directory, '.napplet-space/project.json')).json();
    expect(config.project.creator).toEqual({ pubkey: account.pubkey, network: 'public' });
    expect((await cli(['account', 'backup'])).backupFile).toBe(backupFile);
    expect((await cli(['account', 'create'])).backupFile).toBe(backupFile);
    const reused = await cli(['new', 'second-boilerplate', '--no-install']);
    expect(reused.backupFile).toBe(backupFile);
    const fresh = await cli(['account', 'create', '--new']);
    expect(fresh.account.pubkey).not.toBe(account.pubkey);
    expect(fresh.backupFile).not.toBe(backupFile);
    expect((await stat(fresh.backupFile)).mode & 0o777).toBe(0o600);
    expect((await cli(['account', 'show'])).account).toEqual(fresh.account);
    const draft = join(directory, 'draft');
    await Bun.write(
      join(draft, 'napplet.json'),
      JSON.stringify({
        schema: 'space-local-project/v1',
        name: 'Identity selection',
        entry: 'index.html',
        previewId: crypto.randomUUID(),
        license: 'MIT',
        creator: { pubkey: account.pubkey, network: 'public' },
      }),
    );
    await Bun.write(join(draft, 'index.html'), '<!doctype html><title>Draft</title><p>Preview</p>');
    await Bun.write(join(draft, 'LICENSE'), 'MIT');
    const dryRun = await cli(['publish', '--dry-run', '--project', draft]);
    expect(dryRun.plan.pubkey).toBe(fresh.account.pubkey);
    expect((await cli(['account', 'show'])).account.id).toBe(fresh.account.id);
    expect(await cli(['status', '--project', draft])).toEqual({ status: 'not_started' });
    expect((await cli(['account', 'create'])).backupFile).toBe(fresh.backupFile);
    const saved = (await cli(['account', 'list'])).accounts;
    expect(saved.map((entry: { pubkey: string }) => entry.pubkey)).toEqual([
      account.pubkey,
      fresh.account.pubkey,
    ]);
    expect(saved.find((entry: { selected: boolean }) => entry.selected).id).toBe(fresh.account.id);
    expect((await cli(['account', 'use', account.id])).account).toEqual(account);
    expect((await cli(['account', 'backup'])).backupFile).toBe(backupFile);
    expect((await readFile(backupFile, 'utf8')).trim()).toBe(secret);
    expect(await Bun.file(join(created.directory, '.napplet-space/project.json')).json()).toEqual(
      config,
    );
    const deferred = await cli(['new', 'later-boilerplate', '--identity', 'later', '--no-install']);
    expect(deferred.backupFile).toBeUndefined();
    const imported = await cli(
      ['account', 'import', '--stdin'],
      join(directory, 'restored'),
      secret,
    );
    expect(imported.account.pubkey).toBe(account.pubkey);
    const add = Bun.spawn(['git', '-C', created.directory, 'add', '.'], {
      stdout: 'pipe',
      stderr: 'pipe',
    });
    expect(await add.exited).toBe(0);
    const list = Bun.spawn(['git', '-C', created.directory, 'ls-files', '-z'], { stdout: 'pipe' });
    const paths = (await new Response(list.stdout).text()).split('\0').filter(Boolean);
    expect(await list.exited).toBe(0);
    expect(paths.length).toBeGreaterThan(10);
    for (const path of paths)
      expect((await readFile(join(created.directory, path), 'utf8')).includes(secret)).toBe(false);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}, 30000);
