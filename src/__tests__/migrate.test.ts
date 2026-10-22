import { test, expect } from 'bun:test';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { finalizeEvent, nip19, matchFilter, verifyEvent } from 'nostr-tools';
import {
  sha256,
  aggregateHash,
  encodeAddress,
  type SignedEvent,
} from '../../packages/protocol/src';
import { validateManifest } from '../../packages/protocol/src/manifest';
const command = process.env.SPACE_TEST_CLI
  ? [process.env.SPACE_TEST_CLI]
  : [process.execPath, new URL('../index.ts', import.meta.url).pathname];

test('real migrate CLI previews, confirms, retries exact signatures, preserves optional references and surfaces wrapped download causes', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'soyli-manifest-migration-'));
  const bytes = new TextEncoder().encode(
      '<!doctype html><title>Migration fixture</title><p>Same game</p>',
    ),
    hash = await sha256(bytes);
  let current: SignedEvent | undefined,
    rejected = false,
    assetStatus = 200,
    reads = 0;
  const published: string[] = [],
    requests: string[] = [];
  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch(request, server) {
      if (server.upgrade(request)) return;
      requests.push(`${request.method} ${new URL(request.url).pathname}`);
      return new Response(assetStatus === 200 ? bytes : 'fixture unavailable', {
        status: assetStatus,
      });
    },
    websocket: {
      message(socket, raw) {
        const [type, id, ...filters] = JSON.parse(String(raw));
        if (type === 'REQ') {
          reads++;
          if (current && filters.some((f: any) => matchFilter(f, current!)))
            socket.send(JSON.stringify(['EVENT', id, current]));
          socket.send(JSON.stringify(['EOSE', id]));
        } else if (type === 'EVENT') {
          const event = id as SignedEvent;
          if (!verifyEvent(event)) throw Error('Invalid fixture signature');
          published.push(event.id);
          if (!rejected) {
            socket.send(
              JSON.stringify(['OK', event.id, false, 'fixture relay delivery unavailable']),
            );
            rejected = true;
          } else {
            current = event;
            socket.send(JSON.stringify(['OK', event.id, true, 'accepted']));
          }
        }
      },
    },
  });
  const origin = `http://127.0.0.1:${server.port}`,
    relay = `ws://127.0.0.1:${server.port}/`;
  const run = async (args: string[], accountHome = join(dir, 'accounts')) => {
    const child = Bun.spawn([...command, ...args, '--network', 'local', '--json'], {
      cwd: dir,
      env: {
        PATH: process.env.PATH,
        SPACE_ACCOUNT_HOME: accountHome,
        SOYLI_DANGEROUS_PLAINTEXT_KEYS: '1',
      },
      stdin: 'ignore',
      stdout: 'pipe',
      stderr: 'pipe',
    });
    const timer = setTimeout(() => child.kill('SIGKILL'), 15000);
    try {
      const [code, out, err] = await Promise.all([
        child.exited,
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
      ]);
      return { code, out, err };
    } finally {
      clearTimeout(timer);
    }
  };
  try {
    const create = await run(['account', 'create']);
    expect(create.code, create.err).toBe(0);
    const account = JSON.parse(create.out);
    const decoded = nip19.decode((await readFile(account.backupFile, 'utf8')).trim());
    if (decoded.type !== 'nsec') throw Error('Fixture backup missing');
    const key = decoded.data;
    current = finalizeEvent(
      {
        kind: 35129,
        created_at: 100,
        content: '',
        tags: [
          ['d', 'fixture'],
          ['title', 'Migration fixture'],
          ['description', 'A shared game'],
          ['path', '/index.html', hash],
          ['x', await aggregateHash([{ path: '/index.html', hash }]), 'aggregate'],
          ['server', origin],
          ['requires', 'storage'],
          ['source', 'https://git.example/repository'],
          ['app', `32267:${account.account.pubkey}:fixture`],
        ],
      },
      key,
    );
    const old = current,
      ref = encodeAddress({ kind: 35129, pubkey: current.pubkey, identifier: 'fixture' }),
      base = ['migrate', ref, '--relay', relay];
    const freshHome = join(dir, 'fresh-account-state');
    const freshPreview = await run([...base, '--dry-run'], freshHome);
    expect(freshPreview.code, freshPreview.out + freshPreview.err).toBe(0);
    expect(JSON.parse(freshPreview.out).status).toBe('dry_run');
    expect(await Bun.file(join(freshHome, 'accounts/local/accounts.json')).exists()).toBe(false);
    expect(published).toHaveLength(0);
    const dry = await run([...base, '--dry-run']);
    expect(dry.code, dry.out + dry.err).toBe(0);
    const plan = JSON.parse(dry.out);
    expect(plan.artifactHash).toBe(hash);
    expect(plan.status).toBe('dry_run');
    expect(published).toHaveLength(0);
    const noConfirm = await run(base);
    expect(noConfirm.code).toBe(1);
    expect(noConfirm.out + noConfirm.err).toContain('CONFIRMATION_REQUIRED');
    expect(published).toHaveLength(0);
    const first = await run([...base, '--confirm', plan.confirmation]);
    expect(first.code).toBe(1);
    expect(first.out + first.err).toContain('fixture relay delivery unavailable');
    expect(published).toHaveLength(1);
    expect(current.id).toBe(old.id);
    const resumed = await run([...base, '--resume', '--confirm', plan.confirmation]);
    expect(resumed.code, resumed.out + resumed.err).toBe(0);
    expect(published).toHaveLength(2);
    expect(published[0]).toBe(published[1]);
    expect((await validateManifest(current)).format).toBe('standalone');
    expect(current.tags).toContainEqual(['source', 'https://git.example/repository']);
    expect(current.tags).toContainEqual(['app', `32267:${account.account.pubkey}:fixture`]);
    expect(requests.every((r) => r === `GET /${hash}`)).toBe(true);
    expect(reads).toBeGreaterThan(2);
    const already = await run([...base, '--dry-run']);
    expect(already.code, already.err).toBe(0);
    expect(JSON.parse(already.out).status).toBe('current');
    current = old;
    assetStatus = 503;
    const broken = await run([...base, '--dry-run']);
    expect(broken.code).toBe(1);
    expect(broken.out + broken.err).toContain('MIGRATION_ARTIFACT');
    expect(broken.out + broken.err).toContain('503');
    expect(published).toHaveLength(2);
    expect(await Bun.file(join(dir, 'package.json')).exists()).toBe(false);
  } finally {
    server.stop(true);
    await rm(dir, { recursive: true, force: true });
  }
}, 30000);
