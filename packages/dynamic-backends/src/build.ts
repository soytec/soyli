import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { nip19 } from 'nostr-tools';
import { sourceGit } from '../../grasp/src/client';
import { blob } from './source-files';
import { downloadPack } from './source-http';
import { workerExchange, type WorkerCommand } from './worker-process';
import { ISOLATION } from './sandbox';
import {
  ABI,
  BackendError,
  LIMITS,
  PROFILE,
  canonical,
  digest,
  manifestSchema,
  sourceSchema,
  type Source,
} from './contracts';
import { admitSchemas, jsonBytes, type Schemas } from './schema';
import { compileHandler } from './runtime';

export type BuildInput = {
  source: Source | { mode: 'local-preview'; manifest: string; workspaceDigest: string };
  files: Record<string, string>;
};
export type BuiltArtifact = {
  code: string;
  schemas: Schemas;
  manifest: ReturnType<typeof manifestSchema.parse>;
  materials: Record<string, unknown>;
  artifactHash: string;
  schemaHash: string;
  policyHash: string;
};
export const executionPolicy = Object.freeze({
  profile: PROFILE,
  abi: ABI,
  quickjs: '0.31.0',
  variant: '@jitl/quickjs-singlefile-cjs-release-sync',
  capabilities: ['instance-state'],
  limits: LIMITS,
});

/** No project configuration, scripts, dependencies or source are executed by the provider. */
export async function buildArtifact(
  input: BuildInput,
  workerCommand?: WorkerCommand,
): Promise<BuiltArtifact> {
  const source = 'mode' in input.source ? input.source : sourceSchema.parse(input.source);
  const manifestText = input.files[source.manifest];
  if (typeof manifestText !== 'string' || Buffer.byteLength(manifestText) > 8192)
    throw new BackendError('BAD_INPUT', 'Backend manifest is missing or exceeds 8 KiB.');
  const manifest = manifestSchema.parse(JSON.parse(manifestText));
  const codeSource = input.files[manifest.entry],
    schemasText = input.files[manifest.schemas];
  if (typeof codeSource !== 'string' || Buffer.byteLength(codeSource) > LIMITS.sourceBytes)
    throw new BackendError('BAD_INPUT', 'Backend source is missing or exceeds 256 KiB.');
  if (typeof schemasText !== 'string' || Buffer.byteLength(schemasText) > LIMITS.schemaBytes)
    throw new BackendError('BAD_INPUT', 'Backend schemas are missing or exceed 64 KiB.');
  const schemas = admitSchemas(JSON.parse(schemasText));
  const code = await compileHandler(codeSource, workerCommand);
  const files = Object.fromEntries(
    [source.manifest, manifest.entry, manifest.schemas]
      .sort()
      .map((path) => [path, digest(input.files[path])]),
  );
  const materials = {
    source,
    files,
    selectedSourceDigest: digest(canonical(files)),
    compiler: { name: 'Bun.Transpiler', version: Bun.version },
    runtime: {
      name: 'quickjs-emscripten',
      version: '0.31.0',
      variant: '@jitl/quickjs-singlefile-cjs-release-sync',
    },
  };
  return {
    code,
    schemas,
    manifest,
    materials,
    artifactHash: digest(code),
    schemaHash: digest(canonical(schemas)),
    policyHash: digest(canonical(executionPolicy)),
  };
}

/** Source fetch is separately admitted by the operator; it never accepts arbitrary origins. */
export function gitSourceLoader(
  allowedOrigins: string[],
  local = false,
  sourceCommand?: WorkerCommand,
) {
  const origins = new Set(allowedOrigins.map((origin) => new URL(origin).origin));
  return async (raw: Source): Promise<BuildInput> => {
    const source = sourceSchema.parse(raw),
      url = new URL(source.cloneUrl);
    if (
      !origins.has(url.origin) ||
      url.username ||
      url.password ||
      url.search ||
      url.hash ||
      (url.protocol !== 'https:' &&
        !(local && url.protocol === 'http:' && ['127.0.0.1', '[::1]'].includes(url.hostname)))
    )
      throw new BackendError(
        'FORBIDDEN',
        'Source origin is not admitted by this provider. Use an approved public Git host.',
      );
    const [, author, identifier] = source.repository.split(':');
    if (url.pathname !== `/${nip19.npubEncode(author)}/${identifier}.git`)
      throw new BackendError(
        'BAD_INPUT',
        'This source profile requires the author-qualified GRASP clone URL matching the repository address.',
      );
    if (sourceCommand) {
      const pack = await downloadPack(url, source.commit, local);
      const files = (await workerExchange(
        sourceCommand,
        { type: 'source', source, pack: pack.toString('base64') },
        {
          maximum: LIMITS.sourceBytes * 4,
          timeoutMs: ISOLATION.sourceDeadlineMs,
        },
      )) as Record<string, string>;
      jsonBytes(files, LIMITS.sourceBytes * 2);
      return { source, files };
    }
    if (!local)
      throw new BackendError(
        'FORBIDDEN',
        'Public source builds require the bounded offline source worker.',
      );
    const directory = await mkdtemp(join(tmpdir(), 'soy-backend-source-'));
    try {
      await sourceGit(directory, ['init', '--bare']);
      await sourceGit(directory, [
        '-c',
        'protocol.allow=never',
        '-c',
        'protocol.https.allow=always',
        ...(local ? ['-c', 'protocol.http.allow=always'] : []),
        '-c',
        'fetch.fsckObjects=true',
        'fetch',
        '--depth=1',
        '--no-tags',
        '--no-recurse-submodules',
        url.href,
        source.commit,
      ]);
      if ((await sourceGit(directory, ['rev-parse', 'FETCH_HEAD^{commit}'])) !== source.commit)
        throw new BackendError(
          'BUILD_FAILED',
          'Fetched source does not match the requested Git commit.',
        );
      const files: Record<string, string> = Object.create(null);
      files[source.manifest] = await blob(directory, source.commit, source.manifest, 8192);
      const manifest = manifestSchema.parse(JSON.parse(files[source.manifest]));
      files[manifest.entry] = await blob(
        directory,
        source.commit,
        manifest.entry,
        LIMITS.sourceBytes,
      );
      files[manifest.schemas] = await blob(
        directory,
        source.commit,
        manifest.schemas,
        LIMITS.schemaBytes,
      );
      jsonBytes(files, LIMITS.sourceBytes * 2);
      return { source, files };
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  };
}
