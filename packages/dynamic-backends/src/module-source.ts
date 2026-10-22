import { LIMITS, manifestSchema, pathSchema, digest, canonical } from './contracts';
import type { BuildInput } from './build';

/** One bounded source selection for live projects and immutable preview snapshots. */
export async function readModule(
  path: string,
  read: (path: string, limit: number) => Promise<Uint8Array>,
): Promise<BuildInput> {
  pathSchema.parse(path);
  const files: Record<string, string> = {};
  const load = async (file: string, limit: number) => {
    const bytes = await read(file, limit);
    if (bytes.length > limit) throw new Error(`Backend source exceeds its size limit: ${file}`);
    files[file] = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  };
  await load(path, 8192);
  const manifest = manifestSchema.parse(JSON.parse(files[path]));
  await load(manifest.entry, LIMITS.sourceBytes);
  await load(manifest.schemas, LIMITS.schemaBytes);
  return {
    source: { mode: 'local-preview', manifest: path, workspaceDigest: digest(canonical(files)) },
    files,
  };
}
