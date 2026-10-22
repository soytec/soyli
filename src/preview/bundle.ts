import { appearanceBootstrap } from '../../packages/runtime/src/appearance';
import { readFile } from 'node:fs/promises';
import type { PreviewAssets } from './assets';

/** Build-time only in distributed CLIs. Source development runs this in a fresh process. */
export async function compilePreviewAssets(): Promise<PreviewAssets> {
  const controllers = await Bun.build({
    entrypoints: [new URL('./controllers-client.ts', import.meta.url).pathname],
    target: 'browser',
    format: 'iife',
    minify: true,
  });
  if (!controllers.success)
    throw new Error(`Could not prepare controller tester: ${controllers.logs.join('\n')}`);
  const controllerHtml = await readFile(
    new URL('../../templates/controllers.html', import.meta.url),
    'utf8',
  );
  const controllerScript = (await controllers.outputs[0].text()).replace(
    /<\/script/gi,
    '<\\/script',
  );
  const built = await Bun.build({
    entrypoints: [new URL('./client.ts', import.meta.url).pathname],
    target: 'browser',
    format: 'esm',
    minify: true,
    define: {
      SOYLI_CONTROLLER_TESTER: JSON.stringify(
        controllerHtml + `<script>${controllerScript}</script>`,
      ),
    },
    plugins: [
      {
        name: 'raw-napplet-prelude',
        setup(build) {
          build.onResolve({ filter: /^@napplet\/shim\/prelude.global\?raw$/ }, () => ({
            path: Bun.resolveSync('@napplet/shim/prelude.global', import.meta.dir),
            namespace: 'raw',
          }));
          build.onLoad({ filter: /.*/, namespace: 'raw' }, async ({ path }) => ({
            contents: await readFile(path, 'utf8'),
            loader: 'text',
          }));
        },
      },
    ],
  });
  if (!built.success) throw new Error(`Could not prepare preview: ${built.logs.join('\n')}`);
  return {
    client: await built.outputs[0].text(),
    html: (
      await readFile(new URL('../../templates/preview.html', import.meta.url), 'utf8')
    ).replace(
      '<!-- appearance -->',
      `<script>${appearanceBootstrap}</script><style>${await readFile(new URL('../../packages/runtime/src/appearance.css', import.meta.url), 'utf8')}</style>`,
    ),
  };
}
if (import.meta.main) console.log(JSON.stringify(await compilePreviewAssets()));
