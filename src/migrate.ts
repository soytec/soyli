import { join } from 'node:path';
import { mkdir } from 'node:fs/promises';
import {
  captureAccount,
  outsideRepository,
  type Accounts,
} from '../packages/identity/src/accounts';
import type { CreatorSigner, Network } from '../packages/identity/src/signer';
import { defaultTargets } from '../packages/publish/src/config';
import { Journal, atomicJson, readJson } from '../packages/publish/src/journal';
import { discoveryTarget } from '../packages/protocol/src/discovery';
import { identityAddress, sha256 } from '../packages/protocol/src';
import { validateManifest } from '../packages/protocol/src/manifest';
import { LifecycleTransport } from '../packages/lifecycle/src/transport';
import { lifecycleEndpoint } from '../packages/lifecycle/src';
import {
  executeMigration,
  copyMigratedManifest,
  migrationReceiptSchema,
  migrationTemplate,
  migrationToken,
  planMigration,
  type MigrationReceipt,
} from '../packages/migration/src';
import { DiagnosticError, formatDiagnostic } from '../packages/diagnostics/src';
import { ask } from './input';
import { PublicationRelays } from '../packages/publish/src/relay';
import { outboxReport } from '../packages/publish/src/outbox-report';

export async function migrateCommand(options: {
  reference: string;
  network: Network;
  accounts: Accounts;
  primary?: string;
  mirrors?: string[];
  dryRun?: boolean;
  confirm?: string;
  resume?: boolean;
  json?: boolean;
  signal?: AbortSignal;
  onAuth?: (url: string) => Promise<void>;
}) {
  const selected = await captureAccount(options.accounts),
    account = await selected.current();
  const directory = await outsideRepository(options.accounts.directory);
  const target = discoveryTarget(options.reference),
    path = join(
      new Journal(directory, options.network).root,
      `migration-${await sha256(target.key)}.json`,
    );
  const journal = new Journal(directory, options.network),
    io = new LifecycleTransport(options.signal);
  let signer: CreatorSigner | undefined;
  try {
    // A read-only preview does not require a creator account to have been set up.
    // Its private journal still needs an existing parent for guarded child creation.
    await mkdir(directory, { recursive: true, mode: 0o700 });
    return await journal.lock(async () => {
      let receipt: MigrationReceipt;
      if (options.resume || options.confirm) {
        try {
          receipt = migrationReceiptSchema.parse(await readJson(path));
        } catch (cause) {
          throw new DiagnosticError(
            'MIGRATION_RECEIPT',
            'No valid saved migration plan for this link.',
            { cause, recovery: 'Run migrate <link> --dry-run --json first.' },
          );
        }
        if (
          receipt.plan.network !== options.network ||
          (options.primary &&
            receipt.plan.primary !==
              lifecycleEndpoint(options.primary, 'relay', options.network === 'local')) ||
          (options.mirrors &&
            JSON.stringify(receipt.plan.mirrors) !==
              JSON.stringify(
                [
                  ...new Set(
                    options.mirrors.map((r) =>
                      lifecycleEndpoint(r, 'relay', options.network === 'local'),
                    ),
                  ),
                ].filter((r) => r !== receipt.plan.primary),
              ))
        )
          throw new DiagnosticError(
            'MIGRATION_RECEIPT',
            'Saved migration destinations differ from this request. Review a new dry run.',
          );
      } else {
        const defaults = defaultTargets(options.network);
        const plan = await planMigration(options.reference, {
          primary: options.primary ?? defaults.relay,
          mirrors: options.mirrors ?? defaults.mirrors,
          network: options.network,
          io,
        });
        receipt = { plan, accepted: [] };
        // Do not discard a signature after an interrupted publication.
        let saved: MigrationReceipt | undefined;
        try {
          saved = migrationReceiptSchema.parse(await readJson(path));
        } catch (e) {
          if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
        }
        if (saved?.signed && !saved.accepted.includes(saved.plan.primary))
          throw new DiagnosticError(
            'MIGRATION_PENDING',
            'A signed migration is pending. Resume it before preparing another.',
            { recovery: 'Use the same link with --resume and its saved confirmation token.' },
          );
        await atomicJson(path, receipt);
      }
      const parsed = await validateManifest(receipt.plan.from),
        template = await migrationTemplate(receipt.plan.from);
      const confirmation = await migrationToken(receipt.plan);
      const preview = {
        status: parsed.format === 'standalone' ? 'current' : 'dry_run',
        confirmation,
        address: identityAddress(parsed.identity!),
        author: receipt.plan.from.pubkey,
        fromId: receipt.plan.from.id,
        artifactHash: receipt.plan.artifactHash,
        artifactBytes: receipt.plan.artifactBytes,
        primary: receipt.plan.primary,
        mirrors: receipt.plan.mirrors,
        description: template.content,
        tags: template.tags,
        identity:
          'Same named/root address, unchanged HTML bytes. Saved data and social thread stay attached. Old signed links remain valid.',
      };
      const report = () =>
        options.json
          ? console.log(JSON.stringify(preview))
          : console.log(
              `${preview.status === 'current' ? 'Already uses the new manifest' : 'Manifest migration preview'}\nAddress: ${preview.address}\nHTML: ${preview.artifactBytes} bytes · ${preview.artifactHash}\nPrimary: ${preview.primary}\n${preview.identity}\nDescription: ${preview.description}\nConfirmation: ${confirmation}\nNo rebuild, upload, Git rewrite or deletion.`,
            );
      if (options.dryRun || parsed.format === 'standalone') {
        report();
        return preview;
      }
      if (!account || account.pubkey !== receipt.plan.from.pubkey)
        throw new DiagnosticError(
          'CREATOR_MISMATCH',
          'Select the original author’s account before migrating.',
          {
            recovery:
              'Use soyli account list and account use. Dry runs do not need signing access.',
          },
        );
      if (!options.confirm) {
        report();
        if (options.json || !process.stdin.isTTY)
          throw new DiagnosticError(
            'CONFIRMATION_REQUIRED',
            'Review the migration plan, then pass --confirm with its token. No manifest was signed or posted.',
          );
        if (
          (await ask(
            'Type MIGRATE to publish this exact manifest conversion: ',
            options.signal,
          )) !== 'MIGRATE'
        )
          throw new DiagnosticError('CANCELLED', 'Migration cancelled.');
      } else if (options.confirm !== confirmation)
        throw new DiagnosticError(
          'CONFIRMATION_CHANGED',
          'The token does not match this migration plan. Review a new dry run.',
        );
      signer = await selected.signer({
        kinds: [35129, 15129],
        signal: options.signal,
        onAuth: options.onAuth,
      });
      if ((await signer.getPublicKey()) !== account.pubkey)
        throw new DiagnosticError(
          'CREATOR_MISMATCH',
          'Signer identity differs from the selected author.',
        );
      const result = await executeMigration(receipt, {
        author: account.pubkey,
        signer,
        io,
        save: (value) => atomicJson(path, value),
      });
      await copyMigratedManifest(receipt, {
        io: (signal) => new PublicationRelays(signal),
        signal: options.signal,
        save: (value) => atomicJson(path, value),
      });
      const output = {
        ...preview,
        status: result.status,
        eventId: receipt.signed?.id,
        mirrorErrors: result.mirrorErrors,
        outbox: receipt.outbox ?? null,
      };
      if (options.json) console.log(JSON.stringify(output));
      else {
        console.log(
          `Migrated: ${preview.address}\nExact signed revision: ${receipt.signed?.id}\n${preview.identity}`,
        );
        for (const line of outboxReport(receipt.outbox ?? null)) console.log(line);
        for (const error of result.mirrorErrors)
          console.error(`Optional mirror failed:\n${formatDiagnostic(error)}`);
      }
      return output;
    });
  } finally {
    await signer?.close();
    io.close();
  }
}
