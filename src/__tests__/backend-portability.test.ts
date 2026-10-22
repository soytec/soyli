import { test, expect } from 'bun:test';
import { cp, mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { initModule } from '../dynamic-backend';
import { backendProject } from '../backend';
import { writeBinding } from '../../packages/publish/src/binding';
import { checkSource } from '../../packages/publish/src/project';

async function cli(directory: string, ...args: string[]) {
  const child = Bun.spawn(
    [
      process.execPath,
      new URL('../index.ts', import.meta.url).pathname,
      ...args,
      ...(args[0] === 'browser' ? [] : ['--project', directory]),
      '--json',
    ],
    {
      cwd: directory,
      env: {
        PATH: process.env.PATH,
        HOME: process.env.HOME,
        SPACE_ACCOUNT_HOME: join(directory, 'private-accounts'),
      },
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
  return { code, out, err, data: JSON.parse(out) };
}

test('backend init makes old local declarations portable; a fresh checkout regenerates context before build', async () => {
  const root = await mkdtemp(join(tmpdir(), 'soy-backend-portable-'));
  const copy = join(root, 'checkout');
  try {
    await initModule(root);
    const config = {
      schema: 'space-local-project/v1',
      name: 'Portable backend',
      license: 'MIT',
      previewId: crypto.randomUUID(),
      identifier: 'portable',
      entry: 'dist/index.html',
      build: { kind: 'command', command: [process.execPath, 'build.mjs'] },
    };
    await Bun.write(join(root, 'napplet.json'), JSON.stringify(config));
    const backend = {
      provider: { pubkey: 'f'.repeat(64), relays: ['wss://backend.invalid'] },
      boards: [],
      modules: ['backend/backend.json'],
    };
    await writeBinding(root, {
      version: 1,
      project: { creator: { pubkey: 'a'.repeat(64), network: 'public' }, backend },
    });
    const initialized = await cli(root, 'backend', 'init');
    expect(initialized.code, initialized.out + initialized.err).toBe(0);
    expect(initialized.data).toMatchObject({
      config: 'napplet.json',
      identityBinding: '.napplet-space/project.json',
      contextGenerated: true,
    });
    const portable = await Bun.file(join(root, 'napplet.json')).json();
    expect(portable.backend).toEqual(backend);
    expect(portable.creator).toBeUndefined();
    expect(
      (await Bun.file(join(root, '.napplet-space/project.json')).json()).project.backend,
    ).toBeUndefined();
    await Bun.write(join(copy, 'napplet.json'), JSON.stringify(portable));
    await cp(join(root, 'backend'), join(copy, 'backend'), { recursive: true });
    await Bun.write(
      join(copy, 'build.mjs'),
      `import ctx from '../.napplet-space/soy-backend.json' with {type:'json'};
      if(ctx.provider.pubkey !== '${'f'.repeat(64)}' || ctx.modules[0] !== 'main') throw new Error('Missing backend build context');
      await Bun.write('dist/index.html','<!doctype html><p>Fresh checkout</p>');`,
    );
    expect((await cli(copy, 'setup')).code).toBe(0);
    await rm(join(copy, '.napplet-space'), { recursive: true });
    const built = await cli(copy, 'build');
    expect(built.code, built.out + built.err).toBe(0);
    expect(await Bun.file(join(copy, 'dist/index.html')).text()).toContain('Fresh checkout');
    expect(() =>
      checkSource('.napplet-space/soy-backend.json', new TextEncoder().encode('{}')),
    ).toThrow();
    // Editing the portable module list beats a legacy local override.
    await writeBinding(copy, { version: 1, project: { backend } });
    await Bun.write(
      join(copy, 'napplet.json'),
      JSON.stringify({ ...portable, backend: { ...backend, modules: [] } }),
    );
    expect((await backendProject(copy))!.project.backend!.modules).toEqual([]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}, 15000);

test('CLI names missing backend source before browser startup; browser path is read-only discovery', async () => {
  const root = await mkdtemp(join(tmpdir(), 'soy-backend-diagnostics-'));
  try {
    const config = {
      schema: 'space-local-project/v1',
      name: 'Missing module',
      license: 'MIT',
      previewId: crypto.randomUUID(),
      entry: 'index.html',
      backend: { boards: [], modules: ['backend/backend.json'] },
    };
    await Bun.write(join(root, 'napplet.json'), JSON.stringify(config));
    await Bun.write(join(root, 'index.html'), '<!doctype html><p>Missing source</p>');
    await Bun.write(join(root, 'LICENSE'), 'MIT');
    const checked = await cli(root, 'check');
    expect(checked.code).toBe(1);
    expect(checked.data.error.code).toBe('SOURCE_REQUIRED');
    expect(checked.out).toContain('backend/backend.json');
    expect(checked.out).toContain('Track every declared module');
    const browser = await cli(root, 'browser', 'path');
    expect(browser.code, browser.out + browser.err).toBe(0);
    expect(browser.data.executables.map((x: any) => x.name)).toEqual([
      'chromium-headless-shell',
      'chromium',
      'ffmpeg',
    ]);
    expect(browser.data.executables.every((x: any) => typeof x.installed === 'boolean')).toBe(true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}, 15000);
