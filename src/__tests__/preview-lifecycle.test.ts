import { expect, test } from 'bun:test';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pins from '../../vendor/toolchain.json';

const command = process.env.SPACE_TEST_CLI
  ? [process.env.SPACE_TEST_CLI]
  : [process.execPath, new URL('../index.ts', import.meta.url).pathname];
const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
async function eventually(predicate: () => Promise<boolean>, message: string) {
  for (let tries = 0; tries < 60; tries++) {
    if (await predicate()) return;
    await Bun.sleep(50);
  }
  throw new Error(message);
}
async function reachable(url: string) {
  return fetch(url, { signal: AbortSignal.timeout(200) }).then(
    () => true,
    () => false,
  );
}

for (const ending of ['SIGHUP', 'SIGINT', 'SIGTERM', 'parent-exit'] as const) {
  test(`dev releases its listener and detached build processes on ${ending}`, async () => {
    const root = await mkdtemp(join(tmpdir(), 'soyli-preview-lifetime-'));
    const cache = join(root, 'toolchain');
    let child: ReturnType<typeof Bun.spawn> | undefined;
    let launcher: ReturnType<typeof Bun.spawn> | undefined;
    let cliPid: number | undefined;
    let watcherPid: number | undefined;
    const stderr: Promise<string>[] = [];
    try {
      await Bun.write(
        join(root, 'napplet.json'),
        JSON.stringify({
          schema: 'space-local-project/v1',
          name: 'Lifetime fixture',
          entry: 'dist/index.html',
          description: 'Local test only',
          previewId: crypto.randomUUID(),
          license: 'MIT',
        }),
      );
      await Bun.write(join(root, 'dist/index.html'), '<!doctype html><p>Lifetime fixture</p>');
      await Bun.write(
        join(root, 'package.json'),
        JSON.stringify({ packageManager: `pnpm@${pins.pnpm.version}` }),
      );
      await Bun.write(join(root, 'node_modules/.modules.yaml'), '# isolated fixture');
      // A real long-lived process stands in for Vite. Its listener proves the
      // detached process group is gone, even where orphan zombies linger briefly.
      await Bun.write(
        join(root, 'watcher.ts'),
        `
        const server = Bun.serve({hostname: '127.0.0.1', port: 0, fetch: () => new Response('watcher')});
        await Bun.write('watcher.json', JSON.stringify({pid: process.pid, url: server.url.href}));
        console.log('built in 1ms');
      `,
      );
      for (const pin of [pins.node, pins.nodeLegacyMac]) {
        const platform = (pin.platforms as Record<string, { directory: string }>)[
          `${process.platform}-${process.arch}`
        ];
        if (!platform) continue;
        const bin = join(cache, platform.directory, 'bin');
        await mkdir(bin, { recursive: true });
        await writeFile(
          join(bin, 'node'),
          `#!/bin/sh
if [ "$1" = --version ]; then printf 'v${pin.version}\\n'; exit 0; fi
if [ "$2" = run ]; then exit 0; fi
exec ${quote(process.execPath)} ${quote(join(root, 'watcher.ts'))}
`,
          { mode: 0o755 },
        );
      }
      await Bun.write(
        join(cache, `pnpm-${pins.pnpm.version}/package/bin/pnpm.cjs`),
        '// isolated fixture',
      );
      const args = [...command, 'dev', '--no-open', '--json', '--port', '0'];
      const env = {
        PATH: '/usr/bin:/bin',
        SPACE_TOOLCHAIN_CACHE: cache,
        SPACE_ACCOUNT_HOME: join(root, 'accounts'),
      };
      if (ending === 'parent-exit') {
        // An agent launcher can disappear without sending a signal to the CLI.
        // Keep streams separate so the test can read the child's URL after exit.
        await Bun.write(
          join(root, 'launcher.ts'),
          `
          const child = Bun.spawn(${JSON.stringify(args)}, {
            cwd: ${JSON.stringify(root)}, detached: true, stdin: 'ignore',
            stdout: Bun.file('preview.out'), stderr: Bun.file('preview.err'),
          });
          await Bun.write('preview.pid', String(child.pid));
          setInterval(() => {}, 1000);
        `,
        );
        const started = Bun.spawn([process.execPath, join(root, 'launcher.ts')], {
          cwd: root,
          env,
          stdout: 'ignore',
          stderr: 'pipe',
        });
        launcher = started;
        stderr.push(new Response(started.stderr).text());
      } else {
        const started = Bun.spawn(args, {
          cwd: root,
          env,
          stdin: 'ignore',
          stdout: Bun.file(join(root, 'preview.out')),
          stderr: 'pipe',
        });
        child = started;
        cliPid = started.pid;
        stderr.push(new Response(started.stderr).text());
      }
      let url = '';
      await eventually(async () => {
        const output = await readFile(join(root, 'preview.out'), 'utf8').catch(() => '');
        const line = output.split('\n').find((line) => line.startsWith('{'));
        if (!line) return false;
        const result = JSON.parse(line);
        if (result.error) throw new Error(JSON.stringify(result.error));
        url = result.url;
        return Boolean(url);
      }, 'Preview never became ready');
      if (launcher) cliPid = Number(await readFile(join(root, 'preview.pid'), 'utf8'));
      const watcher = await Bun.file(join(root, 'watcher.json')).json();
      watcherPid = watcher.pid;
      expect(await reachable(url)).toBe(true);
      expect(await reachable(watcher.url)).toBe(true);
      // Closing stdin alone must not end an agent's intentional preview session.
      await Bun.sleep(350);
      expect(await reachable(url)).toBe(true);
      if (launcher) {
        launcher.kill('SIGTERM');
        await launcher.exited;
      } else child!.kill(ending as 'SIGHUP' | 'SIGINT' | 'SIGTERM');
      await eventually(
        async () => !(await reachable(url)),
        'Preview kept its port after its owner exited',
      );
      await eventually(
        async () => !(await reachable(watcher.url)),
        'Detached build watcher survived preview shutdown',
      );
    } finally {
      // Only fixture-owned PIDs/groups; never touch another project preview.
      cliPid ??= Number(await readFile(join(root, 'preview.pid'), 'utf8').catch(() => '0'));
      watcherPid ??= (
        await Bun.file(join(root, 'watcher.json'))
          .json()
          .catch(() => null)
      )?.pid;
      if (launcher) {
        launcher.kill('SIGKILL');
        await launcher.exited;
      }
      if (cliPid) {
        try {
          process.kill(cliPid, 'SIGKILL');
        } catch {}
      }
      if (watcherPid) {
        try {
          process.kill(-watcherPid, 'SIGKILL');
        } catch {}
      }
      if (child) {
        child.kill('SIGKILL');
        await child.exited;
      }
      await Promise.all(stderr);
      await rm(root, { recursive: true, force: true });
    }
  }, 15000);
}
