import { expect, test } from 'bun:test';
import { dirname, relative, resolve } from 'node:path';

test('cross-package runtime imports use resolvable package aliases', async () => {
  const root = resolve(import.meta.dir, '../..');
  const typescript = new Bun.Transpiler({ loader: 'ts' });
  const tsx = new Bun.Transpiler({ loader: 'tsx' });
  const violations: string[] = [];
  let aliases = 0;
  for (const directory of ['packages', 'src', 'scripts']) {
    for await (const file of new Bun.Glob('**/*.{ts,tsx}').scan(resolve(root, directory))) {
      if (file.split('/').includes('node_modules')) continue;
      const path = resolve(root, directory, file);
      const owner = /^packages\/[^/]+/.exec(relative(root, path))?.[0];
      const transpiler = file.endsWith('.tsx') ? tsx : typescript;
      const source = (await Bun.file(path).text()).replace(/^#![^\n]*\n/, '\n');
      for (const entry of transpiler.scanImports(source)) {
        if (entry.path.startsWith('#')) {
          expect(Bun.resolveSync(entry.path, dirname(path))).toStartWith(`${root}/packages/`);
          aliases++;
        } else if (entry.path.startsWith('.') && !entry.path.includes('?')) {
          const target = relative(root, resolve(dirname(path), entry.path));
          const dependency = /^packages\/[^/]+/.exec(target)?.[0];
          if (dependency && dependency !== owner)
            violations.push(`${relative(root, path)}: ${entry.path}`);
        }
      }
    }
  }
  expect(aliases).toBeGreaterThan(0);
  expect(violations).toEqual([]);
});
