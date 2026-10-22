import { expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

test('dev avoids a busy default port, reports explicit conflicts and accepts port zero', async () => {
  const root = await mkdtemp(join(tmpdir(), 'soyli-dev-port-'));
  let occupied: ReturnType<typeof Bun.serve> | undefined;
  try {
    try {
      occupied = Bun.serve({
        hostname: '127.0.0.1',
        port: 4173,
        fetch: () => new Response('existing preview'),
      });
    } catch (error) {
      // A developer may already have a preview here. Never stop or replace it.
      if ((error as NodeJS.ErrnoException).code !== 'EADDRINUSE') throw error;
    }
    await Bun.write(
      join(root, 'napplet.json'),
      JSON.stringify({
        schema: 'space-local-project/v1',
        name: 'Port regression',
        description: 'Local fixture',
        entry: 'index.html',
        previewId: crypto.randomUUID(),
        license: 'MIT',
      }),
    );
    await Bun.write(join(root, 'index.html'), '<!doctype html><p>Port regression</p>');
    for (const args of [[], ['--port', '4173'], ['--port', '0']]) {
      const child = Bun.spawn(
        [
          ...(process.env.SPACE_TEST_CLI
            ? [process.env.SPACE_TEST_CLI]
            : [process.execPath, new URL('../index.ts', import.meta.url).pathname]),
          'dev',
          '--no-open',
          '--json',
          ...args,
        ],
        {
          cwd: root,
          env: { PATH: process.env.PATH, SPACE_ACCOUNT_HOME: join(root, 'accounts') },
          stdin: 'ignore',
          stdout: 'pipe',
          stderr: 'pipe',
        },
      );
      const timer = setTimeout(() => child.kill('SIGKILL'), 10000);
      const stderr = new Response(child.stderr).text();
      try {
        const reader = child.stdout.getReader();
        let output = '';
        while (!output.includes('\n')) {
          const { value, done } = await reader.read();
          if (done) break;
          output += new TextDecoder().decode(value);
        }
        reader.releaseLock();
        expect(output).not.toBe('');
        const result = JSON.parse(output.split('\n')[0]);
        if (args[1] === '4173') {
          expect(result.error?.code).toBe('PREVIEW_PORT_IN_USE');
          expect(result.error.message).toContain('4173');
          expect(result.error.message).toContain('soyli dev --port 0');
          expect(await child.exited).toBe(1);
        } else {
          expect(result.error).toBeUndefined();
          const url = new URL(result.url);
          expect(url.hostname).toBe('127.0.0.1');
          expect(url.port).not.toBe('4173');
          const revision = await fetch(new URL('revision', url));
          expect(revision.status).toBe(200);
          expect((await revision.json()).artifactHash).toMatch(/^[a-f0-9]{64}$/);
          const html = await (await fetch(url)).text();
          expect(html).toContain('name="soyli-workshop" content="true"');
          child.kill('SIGTERM');
          await child.exited;
          await expect(fetch(new URL('revision', url))).rejects.toThrow();
        }
        if (occupied) expect(await (await fetch(occupied.url)).text()).toBe('existing preview');
      } finally {
        child.kill('SIGTERM');
        await child.exited;
        clearTimeout(timer);
        await stderr;
      }
    }
  } finally {
    occupied?.stop(true);
    await rm(root, { recursive: true, force: true });
  }
}, 30000);
