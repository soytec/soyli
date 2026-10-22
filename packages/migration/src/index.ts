import type { EventTemplate, Filter } from 'nostr-tools';
import {
  decodeAddress,
  eventSchema,
  identityAddress,
  sha256,
  MAX_READ_ARTIFACT_BYTES,
  verifiedEvent,
  type SignedEvent,
} from '../../protocol/src';
import { discoveryTarget } from '../../protocol/src/discovery';
import { validateManifest } from '../../protocol/src/manifest';
import { readBytes } from '../../client/src/bytes';
import { lifecycleEndpoint } from '../../lifecycle/src';
import type { LifecycleIO, LifecycleSigner } from '../../lifecycle/src/transport';
import { DiagnosticError, diagnose, formatDiagnostic } from '../../diagnostics/src';
import { z } from 'zod';
import {
  outboxSchema,
  copyHistorySchema,
  copyPublication,
  type CopyIO,
} from '../../nostr/src/publication-copies';

/** Convert wire metadata only. Optional source/media tags keep their exact values.
 * Snapshot self-addresses cannot be converted into independent snapshot identity. */
export async function migrationTemplate(
  input: SignedEvent,
  created_at = input.created_at,
): Promise<EventTemplate> {
  const old = await validateManifest(input);
  if (!old.identity)
    throw new DiagnosticError(
      'MIGRATION_SNAPSHOT',
      'Migrate the named/root napplet, not its immutable snapshot.',
      {
        recovery:
          'Use its /n/<naddr> link. An independent snapshot migration would create a different app identity; existing snapshot links remain supported.',
      },
    );
  if (old.format !== 'legacy')
    return {
      kind: input.kind,
      content: input.content,
      tags: input.tags.map((t) => [...t]),
      created_at,
    };
  const description =
    old.description.trim() || old.title?.trim() || old.identity.identifier || 'A napplet.';
  const tags = input.tags
    .filter((t) => !['path', 'x', 'description', 'requires', 'a', 'A'].includes(t[0]))
    .map((t) => [...t]);
  tags.push(['x', old.artifactHash], ...old.domains.map((d) => ['R', d]));
  return { kind: input.kind, created_at, content: description, tags };
}
export async function isManifestMigration(from: SignedEvent, to: SignedEvent) {
  try {
    if (
      (await validateManifest(from)).format !== 'legacy' ||
      (await validateManifest(to)).format !== 'standalone' ||
      from.pubkey !== to.pubkey
    )
      return false;
    const expected = await migrationTemplate(from, to.created_at);
    const tags = (value: string[][]) => JSON.stringify(value.map((t) => JSON.stringify(t)).sort());
    return (
      expected.kind === to.kind &&
      expected.content === to.content &&
      tags(expected.tags) === tags(to.tags)
    );
  } catch {
    return false;
  }
}
const planSchema = z
  .object({
    version: z.literal(1),
    network: z.enum(['public', 'local']),
    from: eventSchema,
    primary: z.string().max(256),
    mirrors: z.array(z.string().max(256)).max(7),
    artifactHash: z.string().regex(/^[a-f0-9]{64}$/),
    artifactBytes: z.number().int().positive().max(MAX_READ_ARTIFACT_BYTES),
  })
  .strict();
export type MigrationPlan = z.infer<typeof planSchema>;
export type MigrationReceipt = z.infer<typeof migrationReceiptSchema>;
export const migrationReceiptSchema = z
  .object({
    plan: planSchema,
    signed: eventSchema.optional(),
    accepted: z.array(z.string().max(256)).max(8),
    outbox: outboxSchema.optional(),
    outboxHistory: copyHistorySchema.optional(),
  })
  .strict();
const fail = (code: string, message: string, context = {}) =>
  new DiagnosticError(code, message, { operation: 'migrate published manifest', ...context });
const latest = (events: SignedEvent[]) =>
  [...events].sort((a, b) => b.created_at - a.created_at || a.id.localeCompare(b.id))[0];
function currentFilter(event: SignedEvent): Filter {
  return {
    kinds: [event.kind],
    authors: [event.pubkey],
    ...(event.kind === 35129 ? { '#d': [event.tags.find((t) => t[0] === 'd')![1]] } : {}),
    limit: 20,
  };
}
async function assertLive(from: SignedEvent, primary: string, io: LifecycleIO) {
  const parsed = await validateManifest(from),
    address = identityAddress(parsed.identity!);
  const deletes = (
    await Promise.all([
      io.read(primary, { kinds: [5], authors: [from.pubkey], '#e': [from.id], limit: 50 }),
      io.read(primary, { kinds: [5], authors: [from.pubkey], '#a': [address], limit: 50 }),
    ])
  ).flat();
  if (
    deletes.some(
      (e) =>
        e.created_at >= from.created_at &&
        e.tags.some(
          (t) => (t[0] === 'e' && t[1] === from.id) || (t[0] === 'a' && t[1] === address),
        ),
    )
  )
    throw fail(
      'MIGRATION_DELETED',
      'This publication is unpublished or deleted. Republish it deliberately before migrating.',
    );
  const expiry = from.tags.find((t) => t[0] === 'expiration')?.[1];
  if (expiry && /^\d+$/.test(expiry) && Number(expiry) <= Date.now() / 1000)
    throw fail(
      'MIGRATION_EXPIRED',
      'This publication has expired. Publish a new release deliberately.',
    );
}
async function verifyArtifact(
  plan: Pick<MigrationPlan, 'from' | 'network' | 'artifactHash'>,
  io: LifecycleIO,
) {
  const parsed = await validateManifest(plan.from),
    failures = [];
  for (const server of [...new Set(parsed.servers)]) {
    let target: string | undefined;
    try {
      const origin = lifecycleEndpoint(server, 'http', plan.network === 'local');
      target = `${origin.replace(/\/$/, '')}/${plan.artifactHash}`;
      const response = await io.fetch(target);
      if (!response.ok)
        throw fail('MIGRATION_DOWNLOAD', 'Artifact download failed.', {
          status: response.status,
          target,
        });
      const bytes = await readBytes(response, MAX_READ_ARTIFACT_BYTES);
      if ((await sha256(bytes)) !== plan.artifactHash)
        throw fail('MIGRATION_HASH', 'Downloaded HTML does not match the signed artifact hash.', {
          target,
        });
      return bytes.length;
    } catch (cause) {
      failures.push(
        diagnose(
          new DiagnosticError('MIGRATION_DOWNLOAD', 'Declared artifact could not be verified.', {
            target,
            cause,
          }),
          'verify migration artifact',
        ),
      );
    }
  }
  throw fail(
    'MIGRATION_ARTIFACT',
    'No declared Blossom server supplied the exact published HTML.',
    {
      detail: failures.map((e) => formatDiagnostic(e)).join('\n'),
      recovery:
        'Restore the original hash-matching HTML on a declared server, then retry. Migration never rebuilds or substitutes bytes.',
    },
  );
}
export async function planMigration(
  reference: string,
  options: { primary: string; mirrors?: string[]; network: 'public' | 'local'; io: LifecycleIO },
): Promise<MigrationPlan> {
  const target = discoveryTarget(reference),
    local = options.network === 'local';
  const primary = lifecycleEndpoint(options.primary, 'relay', local);
  const mirrors = [
    ...new Set((options.mirrors ?? []).map((r) => lifecycleEndpoint(r, 'relay', local))),
  ].filter((r) => r !== primary);
  if (mirrors.length > 7)
    throw fail('MIGRATION_RELAYS', 'Choose at most seven additional publication relays.');
  let from: SignedEvent | undefined;
  if (target.type === 'address') {
    const identity = decodeAddress(target.naddr);
    from = latest(
      await options.io.read(primary, {
        kinds: [identity.kind],
        authors: [identity.pubkey],
        ...(identity.kind === 35129 ? { '#d': [identity.identifier] } : {}),
        limit: 20,
      }),
    );
  } else {
    from = (
      await options.io.read(primary, { ids: [target.id], kinds: [35129, 15129, 5129], limit: 20 })
    )[0];
    if (from) {
      await migrationTemplate(from);
      const current = latest(await options.io.read(primary, currentFilter(from)));
      if (current?.id !== from.id)
        throw fail(
          'MIGRATION_STALE',
          'The pinned revision is no longer current. Use the /n/ link to review the latest publication.',
        );
    }
  }
  if (!from)
    throw fail('MIGRATION_NOT_FOUND', 'The selected relay has no matching publication.', {
      target: primary,
      recovery:
        'Choose --relay with a relay retaining this napplet. A read-only dry run never uploads or signs.',
    });
  await migrationTemplate(from);
  await assertLive(from, primary, options.io);
  const parsed = await validateManifest(from);
  const artifactBytes = await verifyArtifact(
    { from, network: options.network, artifactHash: parsed.artifactHash },
    options.io,
  );
  return planSchema.parse({
    version: 1,
    network: options.network,
    from,
    primary,
    mirrors,
    artifactHash: parsed.artifactHash,
    artifactBytes,
  });
}
export async function migrationToken(plan: MigrationPlan) {
  return sha256(JSON.stringify(planSchema.parse(plan)));
}
export async function executeMigration(
  receipt: MigrationReceipt,
  options: {
    author: string;
    signer: LifecycleSigner;
    io: LifecycleIO;
    save: (value: MigrationReceipt) => Promise<void>;
  },
) {
  const plan = planSchema.parse(receipt.plan),
    from = verifiedEvent(plan.from);
  if (options.author !== from.pubkey)
    throw fail(
      'CREATOR_MISMATCH',
      'Select the original author’s account. No publication was changed.',
    );
  if ((await validateManifest(from)).format === 'standalone')
    return { status: 'current' as const, receipt, mirrorErrors: [] };
  if (receipt.signed) {
    verifiedEvent(receipt.signed);
    if (!(await isManifestMigration(from, receipt.signed)))
      throw fail(
        'MIGRATION_RECEIPT',
        'Saved migration does not match its original manifest. Nothing was published.',
      );
  }
  const remote = latest(await options.io.read(plan.primary, currentFilter(from)));
  if (remote?.id !== from.id && remote?.id !== receipt.signed?.id)
    throw fail(
      'REMOTE_CONFLICT',
      'The selected relay’s current publication changed after review.',
      {
        target: plan.primary,
        recovery: 'Run a new migrate --dry-run. Existing releases were not overwritten.',
      },
    );
  if (!remote) throw fail('REMOTE_CONFLICT', 'The current publication disappeared after review.');
  await assertLive(remote, plan.primary, options.io);
  if ((await verifyArtifact(plan, options.io)) !== plan.artifactBytes)
    throw fail('MIGRATION_HASH', 'Published HTML size changed. Nothing was signed.');
  if (!receipt.signed) {
    const template = await migrationTemplate(
      from,
      Math.max(Math.floor(Date.now() / 1000), from.created_at + 1),
    );
    const signed = verifiedEvent(await options.signer.signEvent(template));
    if (
      signed.pubkey !== options.author ||
      !(await isManifestMigration(from, signed)) ||
      signed.created_at !== template.created_at
    )
      throw fail(
        'SIGNATURE_INVALID',
        'Signer returned a different manifest. Nothing was published.',
      );
    receipt.signed = signed;
    await options.save(receipt); // Save before any network write: retries reuse this signature.
  }
  const mirrorErrors = [];
  for (const relay of [plan.primary, ...plan.mirrors]) {
    if (
      receipt.accepted.includes(relay) &&
      (relay !== plan.primary || remote.id === receipt.signed.id)
    )
      continue;
    try {
      await options.io.publish(relay, receipt.signed);
      receipt.accepted.push(relay);
      await options.save(receipt);
    } catch (cause) {
      if (relay === plan.primary)
        throw fail('MIGRATION_PUBLISH', 'The primary relay did not confirm the migration.', {
          target: relay,
          cause,
          recovery:
            'Run the same migrate command with --resume; the saved signed event will be reused.',
        });
      mirrorErrors.push(
        diagnose(
          new DiagnosticError('MIGRATION_MIRROR', 'Additional relay did not confirm migration.', {
            target: relay,
            cause,
          }),
          'mirror migrated manifest',
        ),
      );
    }
  }
  return { status: 'migrated' as const, receipt, mirrorErrors };
}

/** Manifest-only migrations distribute their existing signature without rebuilding or resigning. */
export async function copyMigratedManifest(
  receipt: MigrationReceipt,
  options: {
    io: (signal: AbortSignal) => CopyIO;
    save: (receipt: MigrationReceipt) => Promise<void>;
    signal?: AbortSignal;
  },
) {
  if (!receipt.signed) return;
  const state = { mirrors: {}, outbox: receipt.outbox, outboxHistory: receipt.outboxHistory };
  await copyPublication({
    pubkey: receipt.signed.pubkey,
    targets: { relay: receipt.plan.primary, mirrors: receipt.plan.mirrors },
    network: receipt.plan.network,
    events: [receipt.signed],
    state,
    copyMirrors: false,
    io: options.io,
    signal: options.signal,
    save: async () => {
      receipt.outbox = state.outbox;
      receipt.outboxHistory = state.outboxHistory;
      await options.save(migrationReceiptSchema.parse(receipt));
    },
  });
}
