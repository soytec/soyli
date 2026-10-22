import { publicationDestinations } from '../packages/nostr/src/publication-copies';
import { join, resolve } from 'node:path';
import { Journal, readJson, atomicJson } from '../packages/publish/src/journal';
import { Accounts, captureAccount } from '../packages/identity/src/accounts';
import type { Network, CreatorSigner } from '../packages/identity/src/signer';
import { sha256 } from '../packages/protocol/src';
import { DiagnosticError } from '../packages/diagnostics/src';
import { LifecycleTransport } from '../packages/lifecycle/src/transport';
import {
  parseReceipt,
  planLifecycle,
  createLifecycleReceipt,
  executeLifecycle,
  lifecycleFinished,
  type LifecycleReceipt,
  type Operation,
} from '../packages/lifecycle/src';
import { ask } from './input';

export async function lifecycleCommand(options: {
  directory: string;
  network: Network;
  operation: Operation | 'lifecycle';
  dryRun?: boolean;
  resume?: boolean;
  confirm?: string;
  json?: boolean;
  signal?: AbortSignal;
  accounts: Accounts;
  onAuth?: (url: string) => Promise<void>;
}) {
  const accounts = await captureAccount(options.accounts);
  const account = await accounts.current();
  const journal = new Journal(resolve(options.directory), options.network, account?.pubkey);
  const transport = new LifecycleTransport(options.signal);
  let signer: CreatorSigner | undefined;
  try {
    return await journal.lock(async () => {
      const index = await journal.index();
      const creator =
        account?.pubkey ??
        (index.latest ? (await journal.load(index.latest)).plan.pubkey : undefined);
      const path = join(journal.root, creator ? `lifecycle-${creator}.json` : 'lifecycle.json');
      const readReceipt = (file: string) =>
        readJson(file).catch((e) => {
          if (e.code === 'ENOENT') return null;
          throw e;
        }) as Promise<LifecycleReceipt | null>;
      let saved = await readReceipt(path);
      if (!saved && creator) {
        const legacy = await readReceipt(join(journal.root, 'lifecycle.json'));
        if (legacy?.plan.author === creator) saved = legacy;
      }
      if (options.operation === 'lifecycle') {
        if (!saved)
          throw new DiagnosticError(
            'LIFECYCLE_MISSING',
            'No saved unpublish or deletion operation in this project.',
          );
        report(saved, options.json);
        return saved;
      }
      if (!account)
        throw new DiagnosticError(
          'ACCOUNT_REQUIRED',
          'Select the publishing account before managing this napplet.',
        );
      let receipt: LifecycleReceipt;
      if (options.resume || options.confirm) {
        if (!saved || saved.operation !== options.operation)
          throw new DiagnosticError(
            'LIFECYCLE_MISSING',
            `Preview ${options.operation} --dry-run first, or start a new operation.`,
          );
        receipt = parseReceipt(saved);
      } else {
        if (index.active)
          throw new DiagnosticError(
            'PUBLISH_PENDING',
            'Finish the pending publication before changing its lifecycle.',
          );
        if (!index.latest)
          throw new DiagnosticError(
            'LIFECYCLE_MISSING',
            'No publication journal in this project. Use the napplet page with its author identity instead.',
          );
        const last = await journal.load(index.latest);
        if (!last.current || account.pubkey !== last.plan.pubkey)
          throw new DiagnosticError(
            'CREATOR_MISMATCH',
            'Select the identity that published this project.',
          );
        const jobs = [last];
        let previous = last;
        while (previous.parent && jobs.length < 128) {
          previous = await journal.load(previous.parent);
          jobs.push(previous);
        }
        const manifests = jobs.flatMap((j) => [j.current, j.snapshot].filter((e) => !!e));
        const extraBlobs = jobs.flatMap((j) =>
          Object.keys(j.receipts.assets ?? {}).map((hash) => ({
            origin: j.plan.targets.blossom,
            hash,
            label: 'Managed runtime asset',
          })),
        );
        const plan = await planLifecycle({
          operation: options.operation,
          manifest: last.current,
          saved: manifests,
          snapshotPairs: jobs.flatMap((job) =>
            job.current && job.snapshot ? [{ current: job.current, snapshot: job.snapshot }] : [],
          ),
          metadata: jobs.flatMap((j) => (j.preview?.descriptor ? [j.preview.descriptor] : [])),
          extraBlobs,
          retainedRepositories: jobs.flatMap((job) =>
            job.repository ? [job.repository.address] : [],
          ),
          relays: publicationDestinations(jobs),
          local: options.network === 'local',
          io: transport,
        });
        receipt = createLifecycleReceipt(plan, options.operation);
        await atomicJson(path, receipt);
      }
      if (receipt.plan.author !== account.pubkey)
        throw new DiagnosticError(
          'CREATOR_MISMATCH',
          'This lifecycle operation belongs to a different author. Select that account.',
        );
      const token = await sha256(
        JSON.stringify({ operation: receipt.operation, plan: parseReceipt(receipt).plan }),
      );
      if (options.dryRun) {
        report(receipt, options.json, token);
        return receipt;
      }
      if (!options.confirm) {
        if (!options.json) report(receipt, false, token);
        if (options.json || !process.stdin.isTTY)
          throw new DiagnosticError(
            'CONFIRMATION_REQUIRED',
            'No changes made. Review the saved inventory, then pass --confirm with its confirmation token.',
            {
              recovery: `Run soyli ${options.operation} --dry-run --json to obtain the confirmation token, then pass it with --confirm.`,
            },
          );
        const word =
          options.operation === 'delete'
            ? 'DELETE'
            : options.operation === 'unpublish'
              ? 'UNPUBLISH'
              : 'REPUBLISH';
        const answer = await ask(`Type ${word} to confirm this exact inventory: `, options.signal);
        if (answer !== word)
          throw new DiagnosticError(
            'CANCELLED',
            'Cancelled. No publication or hosted files were changed.',
          );
      } else if (options.confirm !== token)
        throw new DiagnosticError(
          'CONFIRMATION_CHANGED',
          'Confirmation token does not match the saved inventory. Review a new --dry-run.',
        );
      signer = await accounts.signer({
        signal: options.signal,
        onAuth: options.onAuth,
        kinds: [5, 24242, 35129, 15129, 5129],
      });
      if ((await signer.getPublicKey()) !== account.pubkey)
        throw new Error('Signer identity changed.');
      await executeLifecycle(receipt, {
        signer,
        io: transport,
        local: options.network === 'local',
        save: async (r) => {
          await atomicJson(path, r);
          if (!options.json)
            for (const step of r.steps) {
              const key = `${step.state}:${step.message ?? ''}`;
              if (lastStates.get(step.id) !== key) {
                lastStates.set(step.id, key);
                process.stderr.write(
                  `[${step.state}] ${step.label} — ${step.target}${step.message ? `\n  ${step.message}` : ''}\n`,
                );
              }
            }
        },
      });
      report(receipt, options.json);
      if (!lifecycleFinished(receipt)) process.exitCode = 1;
      return receipt;
    });
  } finally {
    await signer?.close();
    transport.close();
  }
}
const lastStates = new Map<string, string>();
function report(receipt: LifecycleReceipt, json?: boolean, confirmation?: string) {
  if (json) {
    console.log(JSON.stringify({ receipt, ...(confirmation ? { confirmation } : {}) }));
    return;
  }
  console.log(`\n${receipt.operation.toUpperCase()}: ${receipt.plan.title}\n${receipt.plan.key}`);
  console.log(
    receipt.operation === 'delete'
      ? 'Delete the listed hosted uploads and request Git repository removal. Local files and keys stay. Shared files are retained. GRASP recovery archives may remain for 90 days. Copies, forks and other people’s social events cannot be recalled.'
      : receipt.operation === 'unpublish'
        ? 'Remove listings and known pinned releases. Files and Git stay available; a fresh listing can be published later under the same identity.'
        : 'Publish a fresh signed listing at the same address. Existing pinned links are not restored. Hosted files must still be available.',
  );
  for (const s of receipt.steps)
    console.log(
      `  ${s.state.padEnd(9)} ${s.label}\n            ${s.target}${s.message ? `\n            ${s.message}` : ''}`,
    );
  for (const w of receipt.plan.warnings) console.log(`  Note: ${w}`);
  if (confirmation)
    console.log(
      `\nConfirmation token: ${confirmation}\nUse soyli ${receipt.operation} --confirm ${confirmation} after reviewing this inventory.`,
    );
}
