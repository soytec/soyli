import { join } from 'node:path';
import { committedSource, inspectHistory } from '../packages/publish/src/git-source';
import { publishProject, type PublishOptions } from '../packages/publish/src';
import { propose, type CollaborationOptions } from '../packages/collaboration/src/service';
import { buildProject } from './toolchain';
import { syncBackend } from './backend';
import { Accounts, captureAccount } from '../packages/identity/src/accounts';
import { readBinding, writeBinding } from '../packages/publish/src/binding';
import { backendProject } from './backend';
import type { Network } from '../packages/identity/src/signer';
import { checkPublication } from './publish-check';

/** Public build context follows the user's selection; this never selects credentials. */
export async function prepareSharingIdentity(directory: string, network: Network, pubkey: string) {
  const binding = (await readBinding(directory)) ?? { version: 1 as const, project: {} };
  if (binding.project.creator?.pubkey !== pubkey || binding.project.creator.network !== network) {
    binding.project.creator = { pubkey, network };
    await writeBinding(directory, binding);
  }
  await backendProject(directory, pubkey);
}

export async function buildForSharing(directory: string, signal?: AbortSignal) {
  await committedSource(directory);
  if ((await Bun.file(join(directory, 'napplet.json')).json()).entry === 'dist/index.html')
    await buildProject(directory, signal);
}
export async function publishFromProject(options: PublishOptions) {
  const accounts = await captureAccount(options.accounts ?? new Accounts(options.network));
  if (!options.dryRun && !options.resume) {
    await inspectHistory(options.directory, await committedSource(options.directory));
    const account = await accounts.current();
    if (account) await prepareSharingIdentity(options.directory, options.network, account.pubkey);
    await syncBackend(
      options.directory,
      options.network,
      accounts,
      { signal: options.signal, onAuth: options.onAuth },
      false,
    );
    await buildForSharing(options.directory, options.signal);
  }
  return publishProject({ ...options, accounts });
}
export async function proposeFromProject(
  options: CollaborationOptions & {
    description: string;
    resume?: boolean;
    check?: PublishOptions['check'];
  },
) {
  const accounts = await captureAccount(options.accounts ?? new Accounts(options.network));
  if (!options.resume) {
    await inspectHistory(options.directory, await committedSource(options.directory));
    const account = await accounts.current();
    if (account) await prepareSharingIdentity(options.directory, options.network, account.pubkey);
    await buildForSharing(options.directory, options.signal);
  }
  return propose({ ...options, accounts, check: options.check ?? checkPublication });
}
