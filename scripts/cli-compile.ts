import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import type { previewAssets } from '../src/preview/assets';

const root = resolve(import.meta.dir, '..');

/** Release and standalone integration fixtures share loaders and runtime isolation. */
export async function compileCli(
  outfile: string,
  version: string,
  options: {
    target?: Bun.Build.CompileTarget;
    previewAssets?: Awaited<ReturnType<typeof previewAssets>>;
    /** Package manager that owns the installation; disables soyli update. */
    distribution?: string;
  } = {},
) {
  const bunVersion = (await Bun.file(join(root, '.bun-version')).text()).trim();
  if (Bun.version !== bunVersion)
    throw new Error(
      `CLI builds require Bun ${bunVersion} (running ${Bun.version}). Install the version in .bun-version before building.`,
    );
  const build = await Bun.build({
    entrypoints: [join(root, 'src/index.ts')],
    target: 'bun',
    minify: true,
    define: {
      NAPPLET_STANDALONE: 'true',
      NAPPLET_CLI_VERSION: JSON.stringify(version),
      ...(options.previewAssets
        ? { NAPPLET_PREVIEW_ASSETS: JSON.stringify(options.previewAssets) }
        : {}),
      ...(options.distribution
        ? { NAPPLET_DISTRIBUTION: JSON.stringify(options.distribution) }
        : {}),
    },
    plugins: [
      {
        name: 'raw-creator-source',
        setup(build) {
          // Keep the shipped helper text separate from its executable module identity.
          build.onResolve(
            {
              filter:
                /\/(gamepad|app-data|app-data-contract|handler|handler-types|coordinated-audio)\.ts\?raw$/,
            },
            ({ path }) => ({
              path: resolve(root, 'src', path.slice(0, -4)),
              namespace: 'creator-source',
            }),
          );
          build.onLoad({ filter: /.*/, namespace: 'creator-source' }, async ({ path }) => ({
            contents: await Bun.file(path).text(),
            loader: 'text',
          }));
        },
      },
    ],
    compile: {
      ...(options.target ? { target: options.target } : {}),
      outfile,
      autoloadDotenv: false,
      autoloadBunfig: false,
    },
  });
  if (!build.success) throw new Error(build.logs.join('\n'));
}

if (import.meta.main) {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      'preview-assets': { type: 'boolean' },
      distribution: { type: 'string' },
    },
  });
  const [outfile, version] = positionals;
  if (!outfile || !version)
    throw new Error(
      'Usage: bun scripts/cli-compile.ts <outfile> <version> [--preview-assets] [--distribution <name>]',
    );
  if (values.distribution !== undefined && !/^[a-z][a-z0-9-]*$/.test(values.distribution))
    throw new Error('--distribution must be a lowercase package manager name, e.g. nix.');
  const { previewAssets } = await import('../src/preview/assets');
  await compileCli(outfile, version, {
    previewAssets: values['preview-assets'] ? await previewAssets() : undefined,
    distribution: values.distribution,
  });
}
