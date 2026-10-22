import { expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const command = process.env.SPACE_TEST_CLI
  ? [process.env.SPACE_TEST_CLI]
  : [process.execPath, new URL('../index.ts', import.meta.url).pathname];

test('soyli imports a custom binary asset pack and retains it through assets sync', async () => {
  const root = await mkdtemp(join(tmpdir(), 'soy-data-asset-'));
  try {
    await Bun.write(
      join(root, 'napplet.json'),
      JSON.stringify({
        schema: 'space-local-project/v1',
        name: 'Asset pack',
        entry: 'index.html',
        previewId: crypto.randomUUID(),
        license: 'MIT',
      }),
    );
    const bytes = new Uint8Array([83, 83, 82, 67, 0, 1, 255, 128, 10, 42]);
    await Bun.write(join(root, 'game.ssrcpack'), bytes);
    async function cli(args: string[]) {
      const child = Bun.spawn(
        [...command, ...args, '--project', root, '--network', 'local', '--json'],
        {
          cwd: root,
          stdin: 'ignore',
          stdout: 'pipe',
          stderr: 'pipe',
          env: { PATH: process.env.PATH, SPACE_ACCOUNT_HOME: join(root, 'accounts') },
        },
      );
      const [code, stdout, stderr] = await Promise.all([
        child.exited,
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
      ]);
      return { code, stdout, stderr };
    }
    const added = await cli([
      'assets',
      'add',
      join(root, 'game.ssrcpack'),
      'game-pack',
      '--storage',
      'external',
      '--license',
      'MIT',
    ]);
    expect(added.stderr).toBe('');
    expect(added.code, added.stdout + added.stderr).toBe(0);
    const lock = await Bun.file(join(root, 'napplet.assets.json')).json();
    expect(lock.assets[0].mime).toBe('application/octet-stream');
    expect(await Bun.file(join(root, lock.assets[0].path)).bytes()).toEqual(bytes);
    const synced = await cli(['assets', 'sync']);
    expect(synced.stderr).toBe('');
    expect(synced.code).toBe(0);
    expect(JSON.parse(synced.stdout).assets[0].error).toBeNull();
    for (const [id, content, mime] of [
      ['levels', '{"start": [1, 2]}', 'application/json'],
      ['dialogue', 'Hello world — 你好', 'text/plain'],
    ]) {
      await Bun.write(join(root, id + '.pack'), content);
      const result = await cli(['assets', 'add', join(root, id + '.pack'), id]);
      expect(result.code, result.stdout + result.stderr).toBe(0);
      expect(JSON.parse(result.stdout).assets.find((a: { id: string }) => a.id === id).mime).toBe(
        mime,
      );
    }
    // Neither a custom extension nor binary classification bypasses content policy.
    for (const [id, content, code] of [
      ['active', '<svg><script>alert(1)</script></svg>', 'ASSET_INVALID'],
      ['credential', '-----BEGIN PRIVATE KEY-----\nnot-a-real-key', 'SOURCE_SECRET'],
    ]) {
      await Bun.write(join(root, id + '.pack'), content);
      const result = await cli(['assets', 'add', join(root, id + '.pack'), id]);
      expect(result.code).toBe(1);
      const error = JSON.parse(result.stdout).error;
      expect(error.code).toBe(code);
      expect(error.operation).toBe('soyli assets');
      expect(result.stdout).not.toContain(content);
      if (id === 'active') expect(error.message).toContain('HTML');
    }
    const before = await Bun.file(join(root, 'napplet.assets.json')).text();
    expect(JSON.parse(before).assets).toHaveLength(3);
    await Bun.write(join(root, lock.assets[0].path), new Uint8Array([0, 2, 3]));
    const listing = await cli(['assets', 'list']);
    expect(JSON.parse(listing.stdout).assets[0].error).toContain('changed');
    expect(await Bun.file(join(root, 'napplet.assets.json')).text()).toBe(before);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}, 20_000);
