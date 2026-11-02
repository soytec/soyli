import { join } from 'node:path';
import { ASSET_LOCK, parseAssets } from '#src/services/assets/assets.ts';
import { readModule } from '#src/backend/dynamic/module-source.ts';
import { executableEntry } from '#src/services/publish/artifact.ts';
import { projectSchema, PublishError } from '#src/services/publish/config.ts';
import { checkSource, durableFile } from '#src/services/publish/project.ts';

/** Materialize only runtime inputs; never copy credentials, bindings or a dev database. */
export async function materializePreview(directory: string, contents: Map<string, Uint8Array>) {
  const read = async (path: string) => {
    const bytes = contents.get(path);
    if (!bytes)
      throw new PublishError(
        'SOURCE_REQUIRED',
        `The frozen preview is missing ${path}. Track the declared backend files and include them in publish.files when selecting source explicitly.`,
      );
    checkSource(path, bytes);
    return bytes;
  };
  const config = projectSchema.parse(
    JSON.parse(new TextDecoder().decode(await read('napplet.json'))),
  );
  const paths = new Set([
    'napplet.json',
    executableEntry(contents),
    ...(contents.has(ASSET_LOCK)
      ? [ASSET_LOCK, ...parseAssets(contents.get(ASSET_LOCK)).assets.map((a) => a.path)]
      : []),
  ]);
  for (const path of config.backend?.modules ?? []) {
    const module = await readModule(path, read);
    for (const file of Object.keys(module.files)) paths.add(file);
  }
  for (const path of paths) await durableFile(join(directory, path), await read(path));
}
