import { mkdir, writeFile, lstat } from 'node:fs/promises';
import { join } from 'node:path';
import { PrivateKeySigner } from '@contextvm/sdk/signer';
import { captureAccount, type Accounts } from '../packages/identity/src/accounts';
import type { Network, SignerOptions } from '../packages/identity/src/signer';
import { DiagnosticError } from '../packages/diagnostics/src';
import { regularFile } from '../packages/publish/src/project';
import { committedSource } from '../packages/publish/src/git-source';
import {
  projectIdentity,
  projectRepositoryReference,
  resolveTargets,
} from '../packages/publish/src/config';
import { selectRepository } from '../packages/publish/src/repository';
import { sourceUrls } from '../packages/grasp/src/client';
import { CvmConnection } from '../packages/multiplayer/src/client';
import {
  ABI,
  PROFILE,
  manifestSchema,
  canonical,
  authorizationTemplate,
} from '../packages/dynamic-backends/src/contracts';
import { buildArtifact, type BuildInput } from '../packages/dynamic-backends/src/build';
import { readModule } from '../packages/dynamic-backends/src/module-source';
import { backendProject, resolveBackendProvider } from './backend';

export async function localModule(directory: string, path: string): Promise<BuildInput> {
  return readModule(path, (file, limit) => regularFile(directory, file, limit));
}

export async function initModule(directory: string) {
  // Exclusive writes preserve existing work. Generated content is ordinary tracked source.
  const root = join(directory, 'backend');
  await mkdir(root, { recursive: true });
  const metadata = await lstat(root);
  if (metadata.isSymbolicLink() || !metadata.isDirectory())
    throw new Error('Backend source must be a real project directory, not a symlink.');
  const object = (properties: Record<string, unknown>) => ({
    type: 'object',
    properties,
    required: Object.keys(properties),
    additionalProperties: false,
  });
  const state = object({ value: { type: 'integer', minimum: 0, maximum: 1000000 } });
  const files = {
    'backend.json':
      JSON.stringify(
        {
          format: 'soy.backend/1',
          name: 'main',
          buildProfile: PROFILE,
          entry: 'backend/handler.ts',
          schemas: 'backend/schemas.json',
          stateVersion: 1,
          abi: ABI,
        },
        null,
        2,
      ) + '\n',
    'handler.ts': `// This runs in a fresh WASM sandbox for each operation. No browser/Node APIs.\nexport async function handle(ctx: any, input: any) {\n  if (ctx.operation === 'create') {\n    await ctx.state.set('counter', 'value', {value: 0});\n    return {value: 0};\n  }\n  const state = await ctx.state.get('counter', 'value');\n  if (ctx.operation === 'increment') {\n    if (state.value !== input.expectedValue) throw new Error('CONFLICT: Counter changed; refresh before making a new request.');\n    state.value++;\n    await ctx.state.set('counter', 'value', state);\n  }\n  return state;\n}\n`,
    'schemas.json':
      JSON.stringify(
        {
          version: 1,
          records: { counter: state },
          operations: {
            create: {
              effect: 'create',
              access: 'owner',
              account: true,
              input: object({}),
              output: state,
            },
            read: {
              effect: 'query',
              access: 'reader',
              account: false,
              input: object({}),
              output: state,
            },
            increment: {
              effect: 'command',
              access: 'writer',
              account: true,
              input: object({ expectedValue: { type: 'integer', minimum: 0, maximum: 999999 } }),
              output: state,
            },
          },
        },
        null,
        2,
      ) + '\n',
  };
  for (const [name, text] of Object.entries(files))
    await writeFile(join(root, name), text, { flag: 'wx' });
  return {
    manifest: 'backend/backend.json',
    next: 'Add backend.modules: ["backend/backend.json"] to napplet.json, then soyli backend check and soyli dev. Instances start private to their signed-in owner.',
  };
}

export async function checkModule(directory: string, path = 'backend/backend.json') {
  const input = await localModule(directory, path),
    artifact = await buildArtifact(input);
  return {
    status: 'compiled',
    profile: PROFILE,
    manifest: path,
    artifactHash: artifact.artifactHash,
    schemaHash: artifact.schemaHash,
    operations: Object.keys(artifact.schemas.operations),
    sourceMode: 'local-preview',
    next: 'soyli dev previews configured backend.modules. Compilation does not verify your game rules; test its operations.',
  };
}

export async function moduleCommand(
  directory: string,
  network: Network,
  accounts: Pick<Accounts, 'current' | 'signer'>,
  action: string,
  argument: string,
  signerOptions: SignerOptions = {},
  release?: string,
) {
  accounts = await captureAccount(accounts);
  const account = await accounts.current();
  if (!account) throw new Error('Select a creator with soyli account create or connect first.');
  const prepared = await backendProject(directory, account.pubkey);
  if (!prepared)
    throw new Error(
      'Add backend: { boards: [], modules: ["backend/backend.json"] } to napplet.json first.',
    );
  // Linked frontend source support does not yet extend to the backend build path.
  // Refuse before a remote build or authorization instead of requesting a missing
  // generated repository and reporting its misleading HTTP 404.
  if (action === 'deploy') {
    const linked = await selectRepository({
      directory,
      pubkey: account.pubkey,
      configured: projectRepositoryReference(prepared.project, network),
      signal: signerOptions.signal,
    });
    if (linked)
      throw new DiagnosticError(
        'BACKEND_SOURCE_LINKED',
        'Backend deployment from an existing NIP-34 repository is not supported yet.',
        {
          operation: 'select backend source',
          target: linked.address,
          recovery:
            'Keep your account and repository. Use soyli dev for local backend previews; remote deployment currently requires a project with soyLI-managed GRASP source. No build or authorization was sent.',
        },
      );
  }
  const provider = await resolveBackendProvider(directory, network),
    transport = new PrivateKeySigner(),
    actor = await transport.getPublicKey();
  const connection = new CvmConnection(provider, transport);
  let signer: Awaited<ReturnType<Accounts['signer']>> | undefined;
  const call = async (name: string, args: Record<string, unknown>) => {
    const result = await connection.request('tools/call', {
      name: `soy_backend_${name}`,
      arguments: args,
    });
    const value = result.structuredContent as Record<string, any> | undefined;
    if (result.isError || !value)
      throw new DiagnosticError(
        String(value?.error?.code ?? 'BACKEND_CALL'),
        String(value?.error?.message ?? 'Provider did not return a dynamic backend result.'),
        {
          operation: `backend ${name}`,
          target: provider.pubkey,
          recovery:
            'Keep the selected account. Inspect backend describe and the reported cause before retrying.',
        },
      );
    return value;
  };
  const authorized = async (name: string, args: Record<string, unknown>) => {
    signerOptions.signal?.throwIfAborted();
    signer ??= await accounts.signer({ ...signerOptions, kinds: [1] });
    const input = { ...args, requestId: crypto.randomUUID() };
    const template = authorizationTemplate(
      provider.pubkey,
      actor,
      name === 'delete_release' ? 'deleteRelease' : name,
      input,
    );
    const authorization = await signer.signEvent(template);
    if (
      authorization.pubkey !== account.pubkey ||
      authorization.content !== template.content ||
      canonical(authorization.tags) !== canonical(template.tags)
    )
      throw new Error('Signer changed the backend authorization. No action was sent.');
    signerOptions.signal?.throwIfAborted();
    return call(name, { ...input, authorization });
  };
  try {
    const session = await connection.tool('soy_session');
    if (!Array.isArray(session.families) || !session.families.includes('soy.backends.v1'))
      throw new DiagnosticError(
        'BACKEND_VERSION',
        'This provider has not enabled dynamic backends (soy.backends.v1).',
        {
          operation: `backend ${action}`,
          target: provider.pubkey,
          recovery:
            'Use soyli dev for local development, or select a provider advertising soy.backends.v1 and request creator deployment access from its administrator.',
        },
      );
    if (action === 'deploy') {
      const input = await localModule(directory, argument),
        manifest = manifestSchema.parse(JSON.parse(input.files[argument]));
      const commit = await committedSource(directory);
      const targets = resolveTargets(prepared.project, network),
        identifier = projectIdentity(prepared.project);
      const module = { napplet: prepared.napplet, name: manifest.name };
      const source = {
        repository: `30617:${account.pubkey}:${identifier}`,
        cloneUrl: sourceUrls(targets.grasp, account.pubkey, identifier, network === 'local').clone,
        commit,
        manifest: argument,
      };
      const queued = await authorized('build', { module, source, buildProfile: PROFILE });
      let built: Record<string, any> = queued;
      for (let tries = 0; tries < 120 && built.status !== 'ready'; tries++) {
        signerOptions.signal?.throwIfAborted();
        await Bun.sleep(1000);
        built = await call('build_status', { build: queued.build });
        if (built.status === 'failed')
          throw new DiagnosticError(
            built.code ?? 'BUILD_FAILED',
            built.message ?? 'Provider compilation failed.',
            {
              operation: 'build backend release',
              target: source.cloneUrl,
              detail: built.diagnostic?.detail,
              recovery:
                'Publish/push the selected account’s committed source first, fix the reported compiler/source cause and retry. The active release was not changed.',
            },
          );
      }
      if (built.status !== 'ready')
        throw new Error(
          `Backend build ${queued.build} did not finish within two minutes. Active release was not changed.`,
        );
      const current = await call('describe', { module });
      await authorized('activate', {
        module,
        release: built.release,
        expectedActiveRelease: current.active,
      });
      return {
        module,
        release: built.release,
        receipt: built.receipt,
        active: true,
        existingInstances: 'remain pinned to their previous release',
      };
    }
    const module = { napplet: prepared.napplet, name: argument },
      current = await call('describe', { module });
    if (action === 'describe') return current;
    if (action === 'disable' || action === 'enable')
      return await authorized('disable', {
        module,
        expectedModuleRevision: current.revision,
        disabled: action === 'disable',
      });
    if (action === 'delete-release' && release)
      return await authorized('delete_release', { module, release });
    throw new Error(
      'Use backend describe|disable|enable <module-name>, or delete-release <module-name> --revision <release-hash>.',
    );
  } finally {
    await signer?.close();
    await connection.close();
  }
}
