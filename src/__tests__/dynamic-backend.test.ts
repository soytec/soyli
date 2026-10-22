import { test, expect } from 'bun:test';
import { mkdtemp, mkdir, rm, readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { generateSecretKey, getPublicKey, finalizeEvent, nip19 } from 'nostr-tools';
import { sourceGit } from '../../packages/grasp/src/client';
import { PrivateKeySigner } from '@contextvm/sdk/signer';
import { CvmConnection } from '../../packages/multiplayer/src/client';
import { BackendAccount } from '../../packages/runtime/src/backend-account';
import { NappletBackend } from '../../packages/runtime/src/backend-session';
import { backendProject, localBackend } from '../backend';
import { startBackend } from '../../packages/multiplayer/src/service';
import { initModule, moduleCommand } from '../dynamic-backend';
import type { Account } from '../../packages/identity/src/accounts';

const entry = resolve(import.meta.dir, '../index.ts');
async function cli(root: string, ...args: string[]) {
  const child = Bun.spawn(
    [process.execPath, entry, 'backend', ...args, '--project', root, '--json'],
    { cwd: root, env: { PATH: process.env.PATH, HOME: root }, stdout: 'pipe', stderr: 'pipe' },
  );
  const [stdout, stderr, status] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  return { stdout, stderr, status };
}
test('real CLI scaffolds and compiles a module, preserves existing files, and reports compiler causes', async () => {
  const root = await mkdtemp(join(tmpdir(), 'soy-backend-cli-check-'));
  try {
    expect((await cli(root, 'init-module')).status).toBe(0);
    expect((await cli(root, 'check')).stdout).toContain('"status": "compiled"');
    expect((await cli(root, 'init-module')).status).not.toBe(0);
    const path = join(root, 'backend/handler.ts');
    await Bun.write(path, 'import fs from "node:fs"; export function handle() { return fs; }');
    const failed = await cli(root, 'check');
    expect(failed.status).not.toBe(0);
    expect(failed.stderr + failed.stdout).toContain('self-contained TypeScript handler');
    expect(await readFile(path, 'utf8')).toContain('node:fs');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}, 15000);

test('soyLI local preview reaches dynamic tools over encrypted CVM with host-scoped account proofs', async () => {
  const root = await mkdtemp(join(tmpdir(), 'soy-backend-cvm-'));
  const key = generateSecretKey(),
    pubkey = getPublicKey(key),
    viewerKey = generateSecretKey(),
    viewer = getPublicKey(viewerKey);
  let service: Awaited<ReturnType<typeof localBackend>>,
    connection: CvmConnection | undefined,
    host: NappletBackend | undefined;
  try {
    await initModule(root);
    await Bun.write(
      join(root, 'napplet.json'),
      JSON.stringify({
        schema: 'space-local-project/v1',
        name: 'World',
        entry: 'index.html',
        previewId: crypto.randomUUID(),
        identifier: 'world',
        license: 'MIT',
        creator: { pubkey, network: 'local' },
        backend: { boards: [], modules: ['backend/backend.json'] },
      }),
    );
    const project = await backendProject(root);
    service = await localBackend(root);
    const signer = new PrivateKeySigner();
    connection = new CvmConnection(service!.provider, signer);
    const capability = await connection.tool('soy_session');
    expect(capability.families).toContain('soy.backends.v1');
    const module = { napplet: project!.napplet, name: 'main' };
    const described = await connection.tool('soy_backend_describe', { module });
    expect(JSON.parse((described.receipt as any).content).materials.source.mode).toBe(
      'local-preview',
    );
    const target = { module, release: described.release };
    const intent = {
      target,
      operation: 'create',
      requestId: crypto.randomUUID(),
      expiresAt: Math.floor(Date.now() / 1000) + 240,
      input: {},
    };
    let signatures = 0,
      consents = 0;
    const options = {
      identity: `${pubkey}:35129:world:${'a'.repeat(64)}`,
      pubkey: viewer,
      signal: new AbortController().signal,
      sign: async (_: string, event: any) => {
        signatures++;
        return finalizeEvent(event, viewerKey);
      },
      consent: async () => {
        consents++;
        return true;
      },
    };
    const bound = new BackendAccount(options, () => signer.getPublicKey());
    const args = await bound.arguments(
      connection,
      service!.provider.pubkey,
      'soy_backend_invoke',
      intent,
    );
    const created = await connection.tool('soy_backend_invoke', args);
    expect(created.result).toEqual({ value: 0 });
    const increment = {
      ...intent,
      target: { ...target, instance: created.instance },
      operation: 'increment',
      requestId: crypto.randomUUID(),
      input: { expectedValue: 0 },
    };
    const incrementArgs = await bound.arguments(
      connection,
      service!.provider.pubkey,
      'soy_backend_invoke',
      increment,
    );
    expect((await connection.tool('soy_backend_invoke', incrementArgs)).result).toEqual({
      value: 1,
    });
    expect((await connection.tool('soy_backend_invoke', incrementArgs)).result).toEqual({
      value: 1,
    });
    expect(signatures).toBe(1);
    expect(consents).toBe(1);
    const wrongHost = new BackendAccount(
      { ...options, identity: `${viewer}:35129:other:${'b'.repeat(64)}` },
      () => signer.getPublicKey(),
    );
    await expect(
      wrongHost.arguments(connection, service!.provider.pubkey, 'soy_backend_invoke', intent),
    ).rejects.toThrow('this signed napplet');
    const malicious = {
      tool: async () => ({
        challenge: crypto.randomUUID(),
        module: `35129:${pubkey}:world/main`,
        expiresAt: Math.floor(Date.now() / 1000) + 300,
        scope: 'instance-actions',
        proof: {
          kind: 1,
          created_at: Math.floor(Date.now() / 1000),
          tags: [],
          content: 'sign something else',
        },
      }),
    };
    const fresh = new BackendAccount(options, () => signer.getPublicKey());
    await expect(
      fresh.arguments(malicious, service!.provider.pubkey, 'soy_backend_invoke', intent),
    ).rejects.toThrow('unexpected account proof');
    expect(signatures).toBe(1);
    host = new NappletBackend(
      new PrivateKeySigner(),
      service!.provider.relays,
      service!.provider,
      () => {},
      async () => true,
      [],
      options,
    );
    expect(await host.handle({ type: 'cvm.registry.has', family: 'soy.backends.v1' })).toEqual({
      has: true,
    });
    const listed = await host.handle({ type: 'cvm.registry.list' });
    expect((listed.entries as any[]).some((x) => x.family === 'soy.backends.v1')).toBe(true);
    const hostCall = async (tool: string, args: Record<string, unknown>) => {
      const response = await host!.handle({
        type: 'cvm.registry.call',
        family: 'soy.backends.v1',
        tool: `soy_backend_${tool}`,
        args,
      });
      const result = response.result as {
        isError?: boolean;
        structuredContent: Record<string, any>;
      };
      expect(result.isError).not.toBe(true);
      return result.structuredContent;
    };
    const hosted = await hostCall('invoke', { ...intent, requestId: crypto.randomUUID() });
    const hostedTarget = { ...target, instance: hosted.instance };
    const plan = await hostCall('purge_plan', { target: hostedTarget });
    expect(
      (
        await hostCall('purge_confirm', {
          target: hostedTarget,
          plan: plan.plan,
          planHash: plan.planHash,
        })
      ).deleted,
    ).toBe(true);
    expect(signatures).toBe(2);
    const config = await Bun.file(join(root, 'napplet.json')).json();
    config.backend.provider = service!.provider;
    config.publish = { relay: service!.provider.relays[0] };
    await Bun.write(join(root, 'napplet.json'), JSON.stringify(config));
    let closed = false;
    const accounts = {
      current: async () => ({ pubkey }) as Account,
      signer: async () => {
        closed = false;
        return {
          getPublicKey: async () => pubkey,
          signEvent: async (event: Parameters<typeof finalizeEvent>[0]) => {
            await Bun.sleep(10);
            if (closed) throw new Error('Signer closed before operation finished');
            return finalizeEvent(event, key);
          },
          close: async () => {
            closed = true;
          },
        };
      },
    };
    expect(await moduleCommand(root, 'local', accounts, 'disable', 'main')).toHaveProperty(
      'disabled',
      true,
    );
    expect(await moduleCommand(root, 'local', accounts, 'enable', 'main')).toHaveProperty(
      'disabled',
      false,
    );
    // The rollout gate is checked before keys, files or sockets are opened.
    await expect(
      startBackend({
        relays: ['wss://relay.example'],
        keyPath: join(root, 'unused'),
        dataPath: join(root, 'unused.sqlite'),
        dynamic: { sourceOrigins: [] },
      }),
    ).rejects.toThrow('explicit creator admission');
  } finally {
    await host?.close();
    await connection?.close();
    await service?.close();
    await rm(root, { recursive: true, force: true });
  }
}, 25000);

test('real CLI explains linked backend source before connecting to a provider or asking for authorization', async () => {
  const root = await mkdtemp(join(tmpdir(), 'soy-backend-linked-source-'));
  const project = join(root, 'project');
  await mkdir(project);
  const env = {
    PATH: process.env.PATH,
    HOME: root,
    SPACE_ACCOUNT_HOME: join(root, 'accounts'),
    SOYLI_DANGEROUS_PLAINTEXT_KEYS: '1',
  };
  const run = async (args: string[]) => {
    const child = Bun.spawn(
      [
        process.execPath,
        entry,
        ...args,
        '--network',
        'local',
        ...(args[0] === 'backend' ? ['--project', project] : []),
        '--json',
      ],
      { cwd: root, env, stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' },
    );
    const [out, err, code] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    return { out, err, code };
  };
  try {
    const created = await run(['account', 'create']);
    expect(created.code, created.out + created.err).toBe(0);
    const { account } = JSON.parse(created.out);
    await initModule(project);
    await Bun.write(
      join(project, 'napplet.json'),
      JSON.stringify({
        schema: 'space-local-project/v1',
        name: 'Linked backend',
        entry: 'index.html',
        previewId: crypto.randomUUID(),
        identifier: 'world',
        license: 'MIT',
        backend: { boards: [], modules: ['backend/backend.json'] },
      }),
    );
    await sourceGit(project, ['init']);
    await sourceGit(project, [
      'remote',
      'add',
      'origin',
      `nostr://${nip19.npubEncode(account.pubkey)}/${encodeURIComponent('ws://127.0.0.1:1/')}/world`,
    ]);
    const result = await run(['backend', 'deploy', 'backend/backend.json']);
    expect(result.code).not.toBe(0);
    const diagnostic = JSON.parse(result.out || result.err).error;
    expect(diagnostic.code).toBe('BACKEND_SOURCE_LINKED');
    expect(diagnostic.operation).toBe('select backend source');
    expect(diagnostic.recovery).toContain('No build or authorization was sent');
    expect(result.out + result.err).not.toContain('KEYSTORE');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}, 15000);
