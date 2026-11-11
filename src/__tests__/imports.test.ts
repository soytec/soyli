import { expect, test } from 'bun:test';
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { help } from '../commands/help.ts';

const root = resolve(import.meta.dir, '../..');

test('CLI help keeps its formatting when loaded from a focused command module', () => {
  expect(help).toStartWith('napplet soyLI\n\nUsage:\n  bun run soyli new ');
  expect(help).toContain('\nAll commands accept --network public|local and --json.');
});

test('source imports resolve without package-specific aliases or directories', async () => {
  const manifest = await Bun.file(resolve(root, 'package.json')).json();
  expect(manifest.imports).toEqual({ '#src/*': './src/*' });
  expect(existsSync(resolve(root, 'packages'))).toBe(false);
  const typescript = new Bun.Transpiler({ loader: 'ts' });
  const tsx = new Bun.Transpiler({ loader: 'tsx' });
  let aliases = 0;
  for (const directory of [
    'src',
    'scripts',
    'examples',
    'tests',
    'docs/examples',
    'templates/__tests__',
  ]) {
    for await (const file of new Bun.Glob('**/*.{ts,tsx}').scan(resolve(root, directory))) {
      if (file.split('/').includes('node_modules')) continue;
      const path = resolve(root, directory, file);
      const transpiler = file.endsWith('.tsx') ? tsx : typescript;
      const source = (await Bun.file(path).text()).replace(/^#![^\n]*\n/, '\n');
      for (const entry of transpiler.scanImports(source)) {
        // createRequire may be anchored to an external dependency, not this file.
        if (entry.kind === 'require-call') continue;
        const specifier = entry.path.replace(/\?raw$/, '');
        if (specifier.startsWith('#')) {
          expect(specifier).toStartWith('#src/');
          expect(Bun.resolveSync(specifier, dirname(path))).toStartWith(`${root}/src/`);
          aliases++;
        } else if (specifier.startsWith('.')) {
          expect(Bun.resolveSync(specifier, dirname(path))).toStartWith(`${root}/`);
        }
      }
    }
  }
  expect(aliases).toBeGreaterThan(0);
});

test('preview browser entrypoint does not pull server-only modules into its bundle', async () => {
  // Match source/packaged builds: compile in a fresh process. Bun's in-process
  // resolver cache can retain the server pino entry after signer tests import it.
  const build = Bun.spawn([process.execPath, 'src/preview/bundle.ts'], {
    cwd: root,
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const [output, errors, code] = await Promise.all([
    new Response(build.stdout).text(),
    new Response(build.stderr).text(),
    build.exited,
  ]);
  expect(code, errors).toBe(0);
  const assets = JSON.parse(output);
  expect(assets.client.length).toBeGreaterThan(0);
  expect(assets.html).toContain('<style>');
  expect(assets.html).not.toContain('<!-- appearance -->');
});
