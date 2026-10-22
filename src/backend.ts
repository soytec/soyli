import { DiagnosticError, diagnose, formatDiagnostic } from '../packages/diagnostics/src';
import { effectiveProject, readBinding, writeBinding } from '../packages/publish/src/binding';
import { join } from 'node:path';
import { mkdir, writeFile, rename, rm } from 'node:fs/promises';
import { PrivateKeySigner } from '@contextvm/sdk/signer';
import { Accounts, captureAccount } from '../packages/identity/src/accounts';
import type { CreatorSigner, Network } from '../packages/identity/src/signer';
import { encodeAddress } from '../packages/protocol/src';
import {
  projectSchema,
  projectIdentity,
  resolveTargets,
} from '../packages/publish/src/config';
import { regularFile } from '../packages/publish/src/project';
import {
  CvmConnection,
  validateProvider,
  type BackendProvider,
} from '../packages/multiplayer/src/client';
import { boardAuthorization } from '../packages/multiplayer/src/contracts';
import { startBackend } from '../packages/multiplayer/src/service';
import { startLocalBackendRelay } from '../packages/multiplayer/src/local-relay';
import { localModule } from './dynamic-backend';
import { manifestSchema } from '../packages/dynamic-backends/src/contracts';

export const developmentAuthor = '79be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798';
async function publicFile(path: string, bytes: Uint8Array | string) {
  const temporary = `${path}.${crypto.randomUUID()}.tmp`;
  try {
    await writeFile(temporary, bytes, { flag: 'wx', mode: 0o644 });
    await rename(temporary, path);
  } finally {
    await rm(temporary, { force: true });
  }
}
async function saveBackendConfiguration(
  directory: string,
  config: import('../packages/publish/src/config').Project,
) {
  // Module/board declarations and the provider are portable public configuration.
  // The creator choice remains local so contributions do not change authorship.
  const path = join(directory, 'napplet.json');
  const bytes = await regularFile(directory, 'napplet.json', 16384);
  const raw = JSON.parse(new TextDecoder().decode(bytes));
  if (JSON.stringify(raw.backend) !== JSON.stringify(config.backend))
    await publicFile(path, JSON.stringify({ ...raw, backend: config.backend }, null, 2) + '\n');
  const binding = (await readBinding(directory)) ?? { version: 1 as const, project: {} };
  binding.project.creator = config.creator;
  delete binding.project.backend;
  await writeBinding(directory, binding);
}
export async function backendProject(directory: string, creator?: string) {
  let raw: Uint8Array;
  try {
    raw = await regularFile(directory, 'napplet.json', 16384);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw e;
  }
  const project = await effectiveProject(
    directory,
    projectSchema.parse(JSON.parse(new TextDecoder().decode(raw))),
  );
  if (!project.backend) return undefined;
  const pubkey = creator ?? project.creator?.pubkey ?? developmentAuthor;
  const napplet = encodeAddress({ kind: 35129, pubkey, identifier: projectIdentity(project) });
  const context = {
    version: 1,
    napplet,
    provider: project.backend.provider,
    boards: project.backend.boards.map((b) => b.board),
    ...(project.backend.modules?.length
      ? {
          modules: await Promise.all(
            project.backend.modules.map(
              async (path) =>
                manifestSchema.parse(JSON.parse((await localModule(directory, path)).files[path]))
                  .name,
            ),
          ),
        }
      : {}),
  };
  const bytes = new TextEncoder().encode(JSON.stringify(context, null, 2) + '\n');
  let previous: Uint8Array | undefined;
  try {
    previous = await regularFile(directory, '.napplet-space/soy-backend.json', 16384);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
  }
  if (!previous || !Buffer.from(previous).equals(Buffer.from(bytes))) {
    await mkdir(join(directory, '.napplet-space'), { recursive: true, mode: 0o700 });
    await publicFile(join(directory, '.napplet-space/soy-backend.json'), bytes);
  }
  return { project, napplet, pubkey };
}
export async function resolveBackendProvider(directory: string, network: Network) {
  const project = await effectiveProject(
    directory,
    projectSchema.parse(
      JSON.parse(new TextDecoder().decode(await regularFile(directory, 'napplet.json', 16384))),
    ),
  );
  if (!project.backend) throw new Error('Add backend: { boards: [] } to napplet.json first.');
  const target = resolveTargets(project, network);
  if (project.backend.provider)
    return validateProvider(project.backend.provider, network === 'local' ? [target.relay] : []);
  const response = await fetch(`${target.site}/.well-known/napplet.json`, {
    signal: AbortSignal.timeout(10000),
    redirect: 'error',
  }).catch((cause) => {
    throw new DiagnosticError('BACKEND_DISCOVERY', 'Default backend discovery failed.', {
      operation: 'discover backend provider',
      target: target.site,
      cause,
      recovery: 'Check the configured site, or set backend.provider in napplet.json.',
    });
  });
  if (!response.ok || Number(response.headers.get('Content-Length') ?? 0) > 16384) {
    await response.body?.cancel();
    throw new DiagnosticError(
      'BACKEND_DISCOVERY',
      'Default backend unavailable or discovery response too large.',
      {
        operation: 'discover backend provider',
        target: target.site,
        status: response.status,
        recovery: 'Check the configured site, or set backend.provider in napplet.json.',
      },
    );
  }
  const text = await response.text();
  if (text.length > 16384) throw new Error('Invalid backend discovery');
  return validateProvider(JSON.parse(text).backend, network === 'local' ? [target.relay] : []);
}
export async function syncBackend(
  directory: string,
  network: Network,
  accounts: Pick<Accounts, 'current' | 'signer'>,
  signerOptions = {},
  prepare = true,
) {
  accounts = await captureAccount(accounts);
  const config = await effectiveProject(
    directory,
    projectSchema.parse(
      JSON.parse(new TextDecoder().decode(await regularFile(directory, 'napplet.json', 16384))),
    ),
  );
  if (!config.backend) return { boards: 0 };
  const account = await accounts.current();
  if (!account)
    throw new Error('Select a creator with soyli account create or connect before backend sync.');
  if (config.creator?.pubkey !== account.pubkey || config.creator.network !== network) {
    config.creator = { pubkey: account.pubkey, network };
    await saveBackendConfiguration(directory, config);
    await backendProject(directory, account.pubkey);
  }
  const provider = await resolveBackendProvider(directory, network);
  if (!config.backend.provider) {
    if (!prepare)
      throw new Error('Pin the backend before publishing: soyli backend sync, then soyli build.');
    config.backend.provider = provider;
    await saveBackendConfiguration(directory, config);
    await backendProject(directory, account.pubkey);
  }
  const expected = encodeAddress({
    kind: 35129,
    pubkey: account.pubkey,
    identifier: projectIdentity(config),
  });
  const context = JSON.parse(
    new TextDecoder().decode(
      await regularFile(directory, '.napplet-space/soy-backend.json', 16384),
    ),
  );
  if (
    context.napplet !== expected ||
    JSON.stringify(context.provider) !== JSON.stringify(config.backend.provider)
  )
    throw new Error('Backend configuration changed. Run soyli build before publishing.');
  const prepared = await backendProject(directory, account.pubkey);
  if (!prepared) return { boards: 0 };
  const transportSigner = new PrivateKeySigner(),
    actor = await transportSigner.getPublicKey();
  const connection = new CvmConnection(provider, transportSigner);
  let signer: CreatorSigner | undefined;
  try {
    const definitions = prepared.project.backend!.boards;
    if (definitions.some((board) => board.dataSchema)) {
      const session = await connection.tool('soy_session');
      if (!Array.isArray(session.families) || !session.families.includes('soy.boards.v2'))
        throw new DiagnosticError(
          'BACKEND_VERSION',
          'The selected CVM provider does not support score attachments (soy.boards.v2).',
          {
            operation: 'register scoreboard data schema',
            target: provider.pubkey,
            recovery:
              'Update the backend service or configure a provider supporting soy.boards.v2, then retry soyli backend sync. Do not discard the dataSchema or score data.',
          },
        );
    }
    if (definitions.length) signer = await accounts.signer({ ...signerOptions, kinds: [1] });
    for (const board of definitions) {
      const definition = { ...board, napplet: prepared.napplet };
      await connection.tool('soy_board_register', {
        definition,
        authorization: await signer!.signEvent(
          boardAuthorization(provider.pubkey, actor, definition),
        ),
      });
    }
    return { provider, napplet: prepared.napplet, boards: definitions.length };
  } finally {
    await signer?.close();
    await connection.close();
  }
}
export async function initBackend(
  directory: string,
  network: Network,
  accounts: Pick<Accounts, 'current'>,
) {
  const config = await effectiveProject(
    directory,
    projectSchema.parse(
      JSON.parse(new TextDecoder().decode(await regularFile(directory, 'napplet.json', 16384))),
    ),
  );
  const account = await accounts.current();
  if (account) config.creator = { pubkey: account.pubkey, network };
  config.backend ??= { boards: [] };
  await saveBackendConfiguration(directory, config);
  let warning: string | undefined;
  if (!config.backend.provider) {
    try {
      config.backend.provider = await resolveBackendProvider(directory, network);
      await saveBackendConfiguration(directory, config);
    } catch (cause) {
      warning =
        'Default provider unavailable. Local preview works; run backend sync and rebuild when the provider is available. ' +
        formatDiagnostic(diagnose(cause, 'discover backend provider'));
    }
  }
  const result = await backendProject(directory);
  return {
    napplet: result!.napplet,
    provider: config.backend.provider,
    config: 'napplet.json',
    identityBinding: '.napplet-space/project.json',
    context: '.napplet-space/soy-backend.json',
    contextGenerated: true,
    preview: 'isolated local CVM',
    warning,
  };
}
export async function backendStatus(directory: string, network: Network) {
  const provider = await resolveBackendProvider(directory, network);
  const connection = new CvmConnection(provider, new PrivateKeySigner());
  try {
    return { provider, session: await connection.tool('soy_session') };
  } finally {
    await connection.close();
  }
}
export async function localBackend(
  directory: string,
  connectivity: { turnUrls?: string[]; turnSecret?: string; relayOnly?: boolean } = {},
) {
  const prepared = await backendProject(directory);
  if (!prepared) return undefined;
  const root = join(directory, '.napplet-space/backend');
  await mkdir(root, { recursive: true, mode: 0o700 });
  const relay = startLocalBackendRelay();
  try {
    const localModules = await Promise.all(
      (prepared.project.backend!.modules ?? []).map(async (path) => {
        const input = await localModule(directory, path),
          manifest = manifestSchema.parse(JSON.parse(input.files[path]));
        return { module: { napplet: prepared.napplet, name: manifest.name }, input };
      }),
    );
    const service = await startBackend({
      relays: [relay.url],
      keyPath: join(root, 'identity'),
      dataPath: join(root, 'boards.sqlite'),
      ...connectivity,
      localModules,
      localBoards: prepared.project.backend!.boards.map((board) => ({
        ...board,
        napplet: prepared.napplet,
      })),
    });
    return {
      provider: service.provider,
      close: async () => {
        await service.close();
        relay.close();
      },
    };
  } catch (error) {
    relay.close();
    throw error;
  }
}
