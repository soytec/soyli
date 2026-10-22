import { test, expect } from 'bun:test';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { generateSecretKey, getPublicKey, finalizeEvent } from 'nostr-tools';
import { backendProject, syncBackend } from '../backend';
import { startBackend } from '../../packages/multiplayer/src/service';
import { startLocalBackendRelay } from '../../packages/multiplayer/src/local-relay';
import type { Accounts, Account } from '../../packages/identity/src/accounts';
import { encodeAddress } from '../../packages/protocol/src';
import { CallToolRequestSchema } from '@modelcontextprotocol/sdk/types.js';

test('creator sync registers boards over encrypted CVM and generated public context changes for a remix', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'soy-backend-cli-'));
  const relay = startLocalBackendRelay(),
    key = generateSecretKey(),
    pubkey = getPublicKey(key);
  const service = await startBackend({
    relays: [relay.url],
    keyPath: join(directory, 'server-key'),
    dataPath: join(directory, 'boards.sqlite'),
  });
  const project = {
    schema: 'space-local-project/v1',
    name: 'test',
    entry: 'index.html',
    previewId: crypto.randomUUID(),
    identifier: 'original',
    license: 'MIT',
    creator: { pubkey, network: 'local' },
    publish: { relay: relay.url },
    backend: {
      provider: service.provider,
      boards: [
        {
          board: 'main',
          title: 'Score',
          order: 'highest',
          minimum: 0,
          maximum: 99,
          dataSchema: {
            type: 'object',
            additionalProperties: false,
            required: ['car'],
            properties: { car: { type: 'string' } },
          },
        },
      ],
    },
  };
  const accounts: Pick<Accounts, 'current' | 'signer'> = {
    current: async () => ({ pubkey }) as Account,
    signer: async () => ({
      getPublicKey: async () => pubkey,
      signEvent: async (event) => finalizeEvent(event, key),
      close: async () => {},
    }),
  };
  try {
    await Bun.write(join(directory, 'napplet.json'), JSON.stringify(project));
    await backendProject(directory);
    const result = await syncBackend(directory, 'local', accounts);
    expect(result.boards).toBe(1);
    const address = encodeAddress({ kind: 35129, pubkey, identifier: 'original' });
    service.boards.submit('b'.repeat(64), {
      napplet: address,
      board: 'main',
      score: 10,
      data: { car: 'coral' },
    });
    await syncBackend(directory, 'local', accounts);
    expect(
      service.boards.read('b'.repeat(64), { napplet: address, board: 'main' }).own,
    ).toMatchObject({
      score: 10,
    });
    expect(
      service.boards.entry({ napplet: address, board: 'main', actor: 'b'.repeat(64) }).entry?.data,
    ).toEqual({ car: 'coral' });
    project.identifier = 'remix';
    await Bun.write(join(directory, 'napplet.json'), JSON.stringify(project));
    await backendProject(directory);
    await syncBackend(directory, 'local', accounts);
    const context = JSON.parse(
      await readFile(join(directory, '.napplet-space/soy-backend.json'), 'utf8'),
    );
    expect(context.napplet).not.toBe(address);
    expect(service.boards.read('guest', { napplet: context.napplet, board: 'main' }).rows).toEqual(
      [],
    );
    expect(context.provider).toEqual(service.provider);
    const secondKey = generateSecretKey(),
      secondPubkey = getPublicKey(secondKey);
    const selected: Pick<Accounts, 'current' | 'signer'> = {
      current: async () => ({ pubkey: secondPubkey }) as Account,
      signer: async () => ({
        getPublicKey: async () => secondPubkey,
        signEvent: async (event) => finalizeEvent(event, secondKey),
        close: async () => {},
      }),
    };
    await syncBackend(directory, 'local', selected);
    const changed = await backendProject(directory);
    expect(changed?.pubkey).toBe(secondPubkey);
    expect(changed?.napplet).not.toBe(context.napplet);
    expect(service.boards.read('guest', { napplet: changed!.napplet, board: 'main' }).rows).toEqual(
      [],
    );
    expect(
      service.boards.read('b'.repeat(64), { napplet: address, board: 'main' }).own,
    ).toMatchObject({
      score: 10,
    });
  } finally {
    await service.close();
    relay.close();
    await rm(directory, { recursive: true, force: true });
  }
}, 15000);

test('real CLI explains an older CVM provider before opening a signing key', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'soy-backend-version-'));
  const relay = startLocalBackendRelay();
  const service = await startBackend({
    relays: [relay.url],
    keyPath: join(directory, 'server-key'),
    dataPath: join(directory, 'boards.sqlite'),
  });
  // An isolated old provider reports no attachment family. No signing credential exists.
  service.server.server.setRequestHandler(CallToolRequestSchema, async () => ({
    structuredContent: { families: ['soy.boards.v1'] },
    content: [{ type: 'text', text: '{"families":["soy.boards.v1"]}' }],
  }));
  const account = {
    id: crypto.randomUUID(),
    pubkey: 'b'.repeat(64),
    type: 'local',
    status: 'ready',
  };
  try {
    await Bun.write(
      join(directory, 'accounts', 'local', 'accounts.json'),
      JSON.stringify({ version: 1, network: 'local', active: account.id, accounts: [account] }),
    );
    await Bun.write(
      join(directory, 'napplet.json'),
      JSON.stringify({
        schema: 'space-local-project/v1',
        name: 'test',
        entry: 'index.html',
        previewId: crypto.randomUUID(),
        license: 'MIT',
        publish: { relay: relay.url },
        backend: {
          provider: service.provider,
          boards: [
            {
              board: 'test',
              title: 'Test',
              order: 'highest',
              minimum: 0,
              maximum: 99,
              dataSchema: { type: 'object' },
            },
          ],
        },
      }),
    );
    const child = Bun.spawn(
      [
        process.execPath,
        new URL('../index.ts', import.meta.url).pathname,
        'backend',
        'sync',
        '--project',
        directory,
        '--network',
        'local',
        '--json',
      ],
      {
        cwd: directory,
        env: { PATH: process.env.PATH, SPACE_ACCOUNT_HOME: directory },
        stdin: 'ignore',
        stdout: 'pipe',
        stderr: 'pipe',
      },
    );
    const timer = setTimeout(() => child.kill(), 10000);
    try {
      const [code, out, err] = await Promise.all([
        child.exited,
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
      ]);
      expect(code, out + err).toBe(1);
      expect(err).toBe('');
      expect(JSON.parse(out).error).toMatchObject({
        code: 'BACKEND_VERSION',
        operation: 'register scoreboard data schema',
      });
      expect(out).toContain('soy.boards.v2');
      expect(out).toContain('soyli backend sync');
      expect(out).not.toContain('KEYSTORE');
    } finally {
      clearTimeout(timer);
    }
  } finally {
    await service.close();
    relay.close();
    await rm(directory, { recursive: true, force: true });
  }
}, 15000);
