import { compileCli } from './cli-compile';
import { previewAssets } from '../src/preview/assets';
import { cp, mkdir, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { playwrightDirectory } from '../src/distribution';
import boilerplate from '../vendor/boilerplate.json';
import skills from '../vendor/skills.json';
import version from '../distribution/version.json';

const output = resolve(import.meta.dir, '../dist');
await mkdir(output, { recursive: true });
await compileCli(resolve(output, 'soyli'), version.version, {
  previewAssets: await previewAssets(),
});
// These libraries use runtime resolution and must travel beside the executable.
for (const profile of ['current', 'mac-compat'] as const) {
  const name = profile === 'current' ? 'playwright-core' : 'playwright-core-mac-compat';
  await cp(playwrightDirectory(profile), join(output, 'lib', name), {
    recursive: true, dereference: true,
  });
}
await cp(dirname(Bun.resolveSync('ws/package.json', import.meta.dir)), join(output, 'lib/ws'), {
  recursive: true, dereference: true,
});
await cp(resolve(import.meta.dir, '../LICENSE'), join(output, 'LICENSE'));
const licenses = join(output, 'licenses');
await mkdir(licenses, { recursive: true });
await writeFile(join(licenses, 'napplet-boilerplate-MIT.txt'), boilerplate.files.LICENSE);
await writeFile(join(licenses, 'napplet-skills-MIT.txt'), skills.files.LICENSE);
await cp(resolve(import.meta.dir, '../distribution/BUN-LICENSE.txt'), join(licenses, 'BUN-LICENSE.txt'));
// Include dependency notices, including transitive dependencies bundled by Bun.
const store = resolve(import.meta.dir, '../node_modules');
for await (const relative of new Bun.Glob('**/{LICENSE*,LICENCE*,license*,NOTICE*,ThirdPartyNotices*}').scan({ cwd: store, onlyFiles: true })) {
  await cp(join(store, relative), join(licenses, relative.replaceAll('/', '__')));
}
console.log(`Built ${output}/soyli`);
