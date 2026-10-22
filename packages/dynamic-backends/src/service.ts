import { Database } from 'bun:sqlite';
import { type NostrEvent, type EventTemplate } from 'nostr-tools';
import { verifySignature } from '../../protocol/src/verify';
import { z } from 'zod';
import { diagnose, redactDiagnostic } from '../../diagnostics/src';
import {
  ABI,
  PROFILE,
  LIMITS,
  BackendError,
  accessSchema,
  closedAccess,
  reference,
  canonical,
  digest,
  authorizationTemplate,
  buildSchema,
  activateSchema,
  describeSchema,
  disableSchema,
  deleteReleaseSchema,
  invokeSchema,
  changesSchema,
  challengeSchema,
  bindSchema,
  purgePlanSchema,
  purgeSchema,
  type Access,
  type ModuleRef,
  type Source,
} from './contracts';
import { admitSchemas, jsonBytes, validateValue, type Schemas } from './schema';
import { buildArtifact, executionPolicy, type BuildInput, type BuiltArtifact } from './build';
import type { WorkerCommand } from './worker-process';
import { executeHandler, type RuntimeContext } from './runtime';

type ModuleRow = {
  key: string;
  owner: string;
  active: string | null;
  revision: number;
  disabled: number;
};
type ReleaseRow = {
  id: string;
  module: string;
  artifact: string;
  receipt: string;
  deleted: number;
};
type InstanceRow = {
  id: string;
  module: string;
  release: string;
  owner: string;
  revision: number;
  access: string;
};
type RecordRow = { collection: string; key: string; value: string };
type Job = { id: string; module: string; actor: string; status: string; result: string | null };
type Receipt = { hash: string; result: string; expires: number };
type Options = {
  path?: string;
  provider: string;
  sign: (event: EventTemplate) => Promise<NostrEvent>;
  source: (source: Source) => Promise<BuildInput>;
  now?: () => number;
  workerCommand?: WorkerCommand;
  admittedCreators?: string[] | (() => string[]);
  isolation?: Record<string, unknown>;
  maxInFlight?: number;
  maxBuilds?: number;
};
const object = (value: unknown) => {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new BackendError('BAD_INPUT', 'Expected a JSON object.');
  return value as Record<string, unknown>;
};
const recordRef = z
  .object({
    collection: z.string().regex(/^[a-z][a-zA-Z0-9]{0,31}$/),
    key: z
      .string()
      .min(1)
      .max(128)
      .regex(/^[a-zA-Z0-9_.,:@/-]+$/),
  })
  .strict();
const requireKey = (actor: string) => {
  if (!/^[a-f0-9]{64}$/.test(actor))
    throw new BackendError('FORBIDDEN', 'Authenticated CVM transport identity required.');
};

/** Versioned, opt-in service. SQL/state and keys remain outside creator code. */
export class DynamicBackends {
  private db: Database;
  private now: () => number;
  private jobs = new Set<Promise<unknown>>();
  private closing = false;
  private inFlight = 0;
  constructor(private options: Options) {
    if (!/^[a-f0-9]{64}$/.test(options.provider))
      throw new Error('Dynamic backend provider key is invalid.');
    this.now = options.now ?? Date.now;
    this.db = new Database(options.path ?? ':memory:', { create: true });
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS modules (key TEXT PRIMARY KEY, owner TEXT NOT NULL, active TEXT, revision INTEGER NOT NULL, disabled INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS releases (id TEXT PRIMARY KEY, module TEXT NOT NULL, artifact TEXT NOT NULL, receipt TEXT NOT NULL, deleted INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE IF NOT EXISTS instances (id TEXT PRIMARY KEY, module TEXT NOT NULL, release TEXT NOT NULL, owner TEXT NOT NULL, revision INTEGER NOT NULL, access TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS records (instance TEXT NOT NULL, collection TEXT NOT NULL, key TEXT NOT NULL, value TEXT NOT NULL, PRIMARY KEY(instance,collection,key));
      CREATE TABLE IF NOT EXISTS requests (key TEXT PRIMARY KEY, hash TEXT NOT NULL, result TEXT NOT NULL, expires INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS changes (instance TEXT NOT NULL, revision INTEGER NOT NULL, PRIMARY KEY(instance,revision));
      CREATE TABLE IF NOT EXISTS management (key TEXT PRIMARY KEY, hash TEXT NOT NULL, result TEXT NOT NULL, expires INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS builds (id TEXT PRIMARY KEY, module TEXT NOT NULL, actor TEXT NOT NULL, status TEXT NOT NULL, result TEXT, created INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS challenges (id TEXT PRIMARY KEY, module TEXT NOT NULL, actor TEXT NOT NULL, account TEXT NOT NULL, expires INTEGER NOT NULL, session TEXT);
      CREATE TABLE IF NOT EXISTS sessions (id TEXT PRIMARY KEY, module TEXT NOT NULL, actor TEXT NOT NULL, account TEXT NOT NULL, expires INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS purges (id TEXT PRIMARY KEY, actor TEXT NOT NULL, principal TEXT NOT NULL, plan TEXT NOT NULL, expires INTEGER NOT NULL, result TEXT);
      CREATE TABLE IF NOT EXISTS purged_instances (id TEXT PRIMARY KEY, expires INTEGER NOT NULL);
      CREATE INDEX IF NOT EXISTS records_instance ON records(instance);
      CREATE INDEX IF NOT EXISTS releases_module ON releases(module);
      CREATE INDEX IF NOT EXISTS instances_module ON instances(module);`);
    this.db.query("UPDATE builds SET status='failed', result=? WHERE status='building'").run(
      JSON.stringify({
        code: 'BUILD_FAILED',
        message:
          'Provider restarted before this build completed. Submit the same source with a new request ID.',
      }),
    );
  }
  private cleanup() {
    const now = this.now();
    for (const table of [
      'requests',
      'management',
      'challenges',
      'sessions',
      'purges',
      'purged_instances',
    ])
      this.db.query(`DELETE FROM ${table} WHERE expires < ?`).run(now);
    this.db
      .query("DELETE FROM builds WHERE status != 'building' AND created < ?")
      .run(now - 86400000);
  }
  private module(input: ModuleRef) {
    const ref = reference(input),
      row = this.db.query<ModuleRow, [string]>('SELECT * FROM modules WHERE key=?').get(ref.key);
    if (!row) throw new BackendError('NOT_FOUND', 'Backend module is not registered.');
    return row;
  }
  private release(module: string, id: string): BuiltArtifact & { receipt: NostrEvent } {
    const row = this.db
      .query<ReleaseRow, [string, string]>(
        'SELECT * FROM releases WHERE id=? AND module=? AND deleted=0',
      )
      .get(id, module);
    if (!row) throw new BackendError('NOT_FOUND', 'Backend release is unavailable.');
    const artifact = JSON.parse(row.artifact) as BuiltArtifact;
    const receipt = JSON.parse(row.receipt) as NostrEvent;
    const { release, ...payload } = JSON.parse(receipt.content);
    if (
      !verifySignature(receipt) ||
      receipt.pubkey !== this.options.provider ||
      release !== id ||
      digest(canonical(payload)) !== id ||
      digest(artifact.code) !== payload.artifact.sha256 ||
      digest(canonical(artifact.schemas)) !== payload.schemaHash ||
      canonical(artifact.materials) !== canonical(payload.materials) ||
      canonical(artifact.manifest) !== canonical(payload.manifest) ||
      artifact.policyHash !== payload.policyHash ||
      payload.policyHash !== digest(canonical(executionPolicy))
    )
      throw new BackendError(
        'RELEASE_MISMATCH',
        'Stored code, schema, provenance or execution policy does not match this release.',
      );
    return { ...artifact, receipt };
  }
  private proof(actor: string, operation: string, input: unknown, raw: unknown, account?: string) {
    requireKey(actor);
    jsonBytes(input);
    const proof = JSON.parse(jsonBytes(raw, 32768)) as NostrEvent;
    const expected = authorizationTemplate(
      this.options.provider,
      actor,
      operation,
      input,
      this.now(),
    );
    try {
      if (
        !verifySignature(proof) ||
        (account && proof.pubkey !== account) ||
        proof.kind !== expected.kind ||
        Math.abs(proof.created_at - expected.created_at) > 300 ||
        proof.content !== expected.content ||
        canonical(proof.tags) !== canonical(expected.tags)
      )
        throw new Error();
    } catch {
      throw new BackendError(
        'FORBIDDEN',
        'A fresh account signature for this provider, transport, operation and exact arguments is required.',
      );
    }
    return proof.pubkey;
  }
  private management<
    T extends Record<string, unknown> & {
      module: ModuleRef;
      requestId: string;
      authorization: unknown;
    },
  >(actor: string, operation: string, args: T, action: () => Record<string, unknown>) {
    const { authorization, ...unsigned } = args,
      ref = reference(args.module);
    this.proof(actor, operation, unsigned, authorization, ref.owner);
    this.cleanup();
    const key = `${ref.key}/${ref.owner}/${args.requestId}`,
      hash = digest(canonical({ operation, ...unsigned }));
    return this.db
      .transaction(() => {
        const old = this.db
          .query<Receipt, [string]>('SELECT * FROM management WHERE key=?')
          .get(key);
        if (old) {
          if (old.hash !== hash)
            throw new BackendError(
              'IDEMPOTENCY_CONFLICT',
              'Request ID already belongs to another management action.',
            );
          return JSON.parse(old.result);
        }
        if (
          this.db.query<{ count: number }, []>('SELECT count(*) count FROM management').get()!
            .count >= 4096
        )
          throw new BackendError('QUOTA_EXCEEDED', 'Management request capacity reached.');
        const result = action();
        jsonBytes(result);
        this.db
          .query('INSERT INTO management VALUES (?,?,?,?)')
          .run(key, hash, JSON.stringify(result), this.now() + 600000);
        return result;
      })
      .immediate();
  }
  async build(actor: string, raw: unknown) {
    jsonBytes(raw);
    const args = buildSchema.parse(raw),
      ref = reference(args.module);
    if (args.source.repository.split(':')[1] !== ref.owner)
      throw new BackendError(
        'BAD_INPUT',
        'Build from a repository announced by the module author. Fork the source first.',
      );
    const receipt = this.management(actor, 'build', args, () => {
      this.requireAdmission(ref.owner);
      if (
        this.db
          .query<{ count: number }, [string]>('SELECT count(*) count FROM modules WHERE owner=?')
          .get(ref.owner)!.count >= 8 &&
        !this.db.query('SELECT 1 FROM modules WHERE key=?').get(ref.key)
      )
        throw new BackendError('QUOTA_EXCEEDED', 'Creator module allowance (8) reached.');
      if (
        this.closing ||
        this.jobs.size >= (this.options.maxBuilds ?? 2) ||
        this.db
          .query<{ count: number }, [string]>('SELECT count(*) count FROM builds WHERE module=?')
          .get(ref.key)!.count >= 32
      )
        throw new BackendError(
          'QUOTA_EXCEEDED',
          'Build queue or daily module build allowance reached.',
        );
      const existing = this.db
        .query<ModuleRow, [string]>('SELECT * FROM modules WHERE key=?')
        .get(ref.key);
      if (!existing) {
        if (
          this.db.query<{ count: number }, []>('SELECT count(*) count FROM modules').get()!.count >=
          LIMITS.modules
        )
          throw new BackendError('QUOTA_EXCEEDED', 'Provider module capacity reached.');
        this.db.query('INSERT INTO modules VALUES (?,?,NULL,0,0)').run(ref.key, ref.owner);
      }
      if (
        this.db
          .query<{ count: number }, [string]>(
            'SELECT count(*) count FROM releases WHERE module=? AND deleted=0',
          )
          .get(ref.key)!.count >= LIMITS.releasesPerModule
      )
        throw new BackendError(
          'QUOTA_EXCEEDED',
          'Module release allowance reached. Remove an unused release first.',
        );
      const build = crypto.randomUUID();
      this.db
        .query("INSERT INTO builds VALUES (?,?,?,'building',NULL,?)")
        .run(build, ref.key, actor, this.now());
      return { build, status: 'building' };
    });
    const job = this.db.query<Job, [string]>('SELECT * FROM builds WHERE id=?').get(receipt.build);
    if (job?.status === 'building' && !this.runningBuilds.has(job.id)) {
      this.runningBuilds.add(job.id);
      const promise = this.runBuild(job, args).finally(() => {
        this.jobs.delete(promise);
        this.runningBuilds.delete(job.id);
      });
      this.jobs.add(promise);
    }
    return receipt;
  }
  private runningBuilds = new Set<string>();
  private async storeArtifact(module: ModuleRef, artifact: BuiltArtifact) {
    const payload = {
      version: 'soy-build-receipt/1',
      provider: this.options.provider,
      module: reference(module).module,
      materials: artifact.materials,
      manifest: artifact.manifest,
      artifact: {
        sha256: artifact.artifactHash,
        mediaType: 'application/javascript',
        bytes: Buffer.byteLength(artifact.code),
      },
      schemaHash: artifact.schemaHash,
      policyHash: artifact.policyHash,
      abi: ABI,
      isolation: this.options.isolation ?? { profile: 'local-process' },
    };
    const release = digest(canonical(payload));
    const receipt = await this.options.sign({
      kind: 1,
      created_at: Math.floor(this.now() / 1000),
      tags: [
        ['t', 'soy-backend-build-v1'],
        ['x', release],
      ],
      content: canonical({ ...payload, release }),
    });
    if (
      !verifySignature(JSON.parse(JSON.stringify(receipt))) ||
      receipt.pubkey !== this.options.provider ||
      receipt.content !== canonical({ ...payload, release })
    )
      throw new BackendError('BUILD_FAILED', 'Provider did not sign the exact build receipt.');
    const key = reference(module).key;
    const encodedArtifact = JSON.stringify(artifact);
    const previousBytes =
      this.db
        .query<{ bytes: number }, [string]>(
          'SELECT length(CAST(artifact AS BLOB)) bytes FROM releases WHERE id=?',
        )
        .get(release)?.bytes ?? 0;
    const storedBytes = this.db
      .query<{ bytes: number }, []>(
        'SELECT coalesce(sum(length(CAST(artifact AS BLOB))),0) bytes FROM releases',
      )
      .get()!.bytes;
    if (storedBytes - previousBytes + Buffer.byteLength(encodedArtifact) > 128 * 1024 * 1024)
      throw new BackendError(
        'QUOTA_EXCEEDED',
        'Provider backend artifact storage allowance reached. Remove an unused release or contact the operator.',
      );
    if (
      !this.db.query('SELECT 1 FROM releases WHERE id=? AND deleted=0').get(release) &&
      this.db
        .query<{ count: number }, [string]>(
          'SELECT count(*) count FROM releases WHERE module=? AND deleted=0',
        )
        .get(key)!.count >= LIMITS.releasesPerModule
    )
      throw new BackendError('QUOTA_EXCEEDED', 'Module release allowance reached.');
    this.db
      .query(
        'INSERT INTO releases (id,module,artifact,receipt,deleted) VALUES (?,?,?,?,0) ON CONFLICT(id) DO UPDATE SET artifact=excluded.artifact, deleted=0',
      )
      .run(release, key, encodedArtifact, JSON.stringify(receipt));
    return { release, receipt };
  }
  /** Operator-only local bootstrap, deliberately not registered as a CVM tool. */
  async provisionPreview(module: ModuleRef, input: BuildInput) {
    if (!('mode' in input.source) || input.source.mode !== 'local-preview')
      throw new BackendError('BAD_INPUT', 'Local preview material must be explicitly marked.');
    const ref = reference(module),
      artifact = await buildArtifact(input, this.options.workerCommand);
    if (artifact.manifest.name !== module.name)
      throw new BackendError('BAD_INPUT', 'Backend manifest name mismatch.');
    this.db.query('INSERT OR IGNORE INTO modules VALUES (?,?,NULL,0,0)').run(ref.key, ref.owner);
    const result = await this.storeArtifact(module, artifact);
    this.db
      .query('UPDATE modules SET active=?, revision=revision+1 WHERE key=?')
      .run(result.release, ref.key);
    return result;
  }
  private requireAdmission(owner: string) {
    const policy = this.options.admittedCreators;
    const creators = typeof policy === 'function' ? policy() : policy;
    if (creators && !creators.includes(owner))
      throw new BackendError(
        'FORBIDDEN',
        'This creator is not admitted for dynamic deployment by this provider. Request admission or choose another compatible provider; do not change identities to bypass it.',
      );
  }
  private async runBuild(job: Job, args: z.infer<typeof buildSchema>) {
    try {
      const source = await this.options.source(args.source);
      if (canonical(source.source) !== canonical(args.source))
        throw new BackendError('BUILD_FAILED', 'Fetched source locator changed during build.');
      this.requireAdmission(reference(args.module).owner);
      const artifact = await buildArtifact(source, this.options.workerCommand);
      if (artifact.manifest.name !== args.module.name)
        throw new BackendError(
          'BAD_INPUT',
          'Manifest backend name does not match the requested module.',
        );
      this.requireAdmission(reference(args.module).owner);
      const result = await this.storeArtifact(args.module, artifact);
      this.db
        .query("UPDATE builds SET status='ready', result=? WHERE id=?")
        .run(JSON.stringify(result), job.id);
    } catch (error) {
      const diagnostic = diagnose(error, 'build dynamic backend');
      const failure = {
        code: error instanceof BackendError ? error.code : 'BUILD_FAILED',
        message:
          error instanceof BackendError ? redactDiagnostic(error.message) : diagnostic.message,
        diagnostic,
      };
      this.db
        .query("UPDATE builds SET status='failed', result=? WHERE id=?")
        .run(JSON.stringify(failure), job.id);
    }
  }
  buildStatus(actor: string, raw: unknown) {
    requireKey(actor);
    const { build } = z.object({ build: z.string().uuid() }).strict().parse(raw);
    const row = this.db.query<Job, [string]>('SELECT * FROM builds WHERE id=?').get(build);
    if (!row)
      throw new BackendError('NOT_FOUND', 'Build is unavailable or its status retention expired.');
    // Diagnostics can contain paths; they are returned only to the submitting transport.
    if (row.actor !== actor)
      throw new BackendError(
        'FORBIDDEN',
        'Build status belongs to the submitting connection. Use describe for a public release.',
      );
    return { build, status: row.status, ...(row.result ? JSON.parse(row.result) : {}) };
  }
  health() {
    return {
      profile: PROFILE,
      isolation: this.options.isolation ?? { profile: 'local-process' },
      admission: this.options.admittedCreators ? 'allowlist' : 'local-preview',
      builds: this.jobs.size,
      executions: this.inFlight,
    };
  }
  describe(actor: string, raw: unknown) {
    requireKey(actor);
    const args = describeSchema.parse(raw),
      module = this.module(args.module);
    const release = args.release ?? module.active;
    if (!release)
      return {
        module: module.key,
        active: null,
        revision: module.revision,
        disabled: Boolean(module.disabled),
        profile: PROFILE,
        limits: LIMITS,
      };
    const artifact = this.release(module.key, release);
    return {
      module: module.key,
      active: module.active,
      release,
      revision: module.revision,
      disabled: Boolean(module.disabled),
      schemas: artifact.schemas,
      receipt: artifact.receipt,
      profile: PROFILE,
      limits: LIMITS,
    };
  }
  activate(actor: string, raw: unknown) {
    const args = activateSchema.parse(raw);
    return this.management(actor, 'activate', args, () => {
      this.requireAdmission(reference(args.module).owner);
      const module = this.module(args.module);
      this.release(module.key, args.release);
      if (module.active !== args.expectedActiveRelease)
        throw new BackendError(
          'CONFLICT',
          'Active release changed. Refresh describe before activation.',
        );
      this.db
        .query('UPDATE modules SET active=?, revision=revision+1 WHERE key=?')
        .run(args.release, module.key);
      return { active: args.release, revision: module.revision + 1 };
    });
  }
  disable(actor: string, raw: unknown) {
    const args = disableSchema.parse(raw);
    return this.management(actor, 'disable', args, () => {
      if (!args.disabled) this.requireAdmission(reference(args.module).owner);
      const module = this.module(args.module);
      if (module.revision !== args.expectedModuleRevision)
        throw new BackendError(
          'CONFLICT',
          'Module changed. Refresh describe before disabling or enabling.',
        );
      this.db
        .query('UPDATE modules SET disabled=?, revision=revision+1 WHERE key=?')
        .run(Number(args.disabled), module.key);
      return { disabled: args.disabled, revision: module.revision + 1 };
    });
  }
  deleteRelease(actor: string, raw: unknown) {
    const args = deleteReleaseSchema.parse(raw);
    return this.management(actor, 'deleteRelease', args, () => {
      const module = this.module(args.module);
      if (
        module.active === args.release ||
        this.db
          .query('SELECT 1 FROM instances WHERE module=? AND release=? LIMIT 1')
          .get(module.key, args.release)
      )
        throw new BackendError(
          'CONFLICT',
          'An active or world-referenced release cannot be deleted.',
        );
      this.release(module.key, args.release);
      this.db
        .query("UPDATE releases SET artifact='', deleted=1 WHERE id=? AND module=?")
        .run(args.release, module.key);
      return {
        deleted: true,
        release: args.release,
        retained: [
          'signed build receipt',
          'public Git history',
          'independent artifact copies',
          'backups according to operator retention',
        ],
      };
    });
  }
  sessionChallenge(actor: string, raw: unknown) {
    requireKey(actor);
    const args = challengeSchema.parse(raw),
      module = this.module(args.module);
    this.cleanup();
    if (
      this.db.query<{ count: number }, []>('SELECT count(*) count FROM challenges').get()!.count >=
      4096
    )
      throw new BackendError('QUOTA_EXCEEDED', 'Session challenge capacity reached.');
    const challenge = crypto.randomUUID(),
      expires = this.now() + 300000;
    this.db
      .query('INSERT INTO challenges VALUES (?,?,?,?,?,NULL)')
      .run(challenge, module.key, actor, args.account, expires);
    const input = {
      challenge,
      module: module.key,
      account: args.account,
      expiresAt: Math.floor(expires / 1000),
      scope: 'instance-actions',
    };
    return {
      challenge,
      expiresAt: Math.floor(expires / 1000),
      proof: authorizationTemplate(this.options.provider, actor, 'sessionBind', input, this.now()),
      scope: 'instance-actions',
      module: module.key,
    };
  }
  sessionBind(actor: string, raw: unknown) {
    const args = bindSchema.parse(raw);
    const row = this.db
      .query<
        { module: string; actor: string; account: string; expires: number; session: string | null },
        [string]
      >('SELECT * FROM challenges WHERE id=?')
      .get(args.challenge);
    if (!row || row.actor !== actor || row.expires < this.now())
      throw new BackendError(
        'FORBIDDEN',
        'Session challenge expired or belongs to another transport.',
      );
    this.proof(
      actor,
      'sessionBind',
      {
        challenge: args.challenge,
        module: row.module,
        account: row.account,
        expiresAt: Math.floor(row.expires / 1000),
        scope: 'instance-actions',
      },
      args.authorization,
      row.account,
    );
    if (row.session)
      return {
        session: row.session,
        account: row.account,
        expiresAt: Math.floor(
          this.db
            .query<{ expires: number }, [string]>('SELECT expires FROM sessions WHERE id=?')
            .get(row.session)!.expires / 1000,
        ),
      };
    const session = crypto.randomUUID(),
      expires = this.now() + 3600000;
    this.cleanup();
    if (
      this.db.query<{ count: number }, []>('SELECT count(*) count FROM sessions').get()!.count >=
      LIMITS.sessions
    )
      throw new BackendError('QUOTA_EXCEEDED', 'Account session capacity reached.');
    this.db
      .transaction(() => {
        this.db
          .query('INSERT INTO sessions VALUES (?,?,?,?,?)')
          .run(session, row.module, actor, row.account, expires);
        this.db.query('UPDATE challenges SET session=? WHERE id=?').run(session, args.challenge);
      })
      .immediate();
    return { session, account: row.account, expiresAt: Math.floor(expires / 1000) };
  }
  revokeSession(actor: string, raw: unknown) {
    requireKey(actor);
    const { session } = z.object({ session: z.string().uuid() }).strict().parse(raw);
    this.db.query('DELETE FROM sessions WHERE id=? AND actor=?').run(session, actor);
    this.db.query('DELETE FROM challenges WHERE session=? AND actor=?').run(session, actor);
    return { revoked: true };
  }
  private identity(actor: string, module: string, session?: string) {
    requireKey(actor);
    if (!session) return { account: null, principal: `guest:${actor}` };
    const row = this.db
      .query<{ account: string }, [string, string, string, number]>(
        'SELECT account FROM sessions WHERE id=? AND module=? AND actor=? AND expires>?',
      )
      .get(session, module, actor, this.now());
    if (!row)
      throw new BackendError(
        'ACCOUNT_REQUIRED',
        'Account session is missing, revoked or expired. Reconnect the selected account.',
      );
    return { account: row.account, principal: `nostr:${row.account}` };
  }
  private instance(module: string, release: string, id?: string) {
    if (!id) throw new BackendError('BAD_INPUT', 'This operation needs an instance ID.');
    const row = this.db
      .query<InstanceRow, [string, string]>('SELECT * FROM instances WHERE id=? AND module=?')
      .get(id, module);
    if (!row) throw new BackendError('NOT_FOUND', 'World is unavailable.');
    if (row.release !== release)
      throw new BackendError(
        'RELEASE_MISMATCH',
        'World uses a different pinned release. Refresh its metadata.',
      );
    return row;
  }
  private canAccess(
    instance: InstanceRow,
    principal: string,
    level: 'reader' | 'writer' | 'owner',
  ) {
    if (principal === instance.owner) return;
    const access = accessSchema.parse(JSON.parse(instance.access)),
      member = access.members[principal];
    if (level === 'owner' || (access.visibility === 'members' && !member))
      throw new BackendError('FORBIDDEN', 'This world does not grant the requested access.');
    if (level === 'reader') return;
    if (
      member === 'viewer' ||
      (member !== 'builder' && access.building !== 'everyone') ||
      (principal.startsWith('guest:') && !access.guestsMayBuild)
    )
      throw new BackendError('FORBIDDEN', 'Building permission is required for this world.');
  }
  async invoke(actor: string, raw: unknown): Promise<Record<string, unknown>> {
    if (this.closing || this.inFlight >= (this.options.maxInFlight ?? 8))
      throw new BackendError(
        'QUOTA_EXCEEDED',
        'Backend execution capacity reached. Retry shortly.',
      );
    this.inFlight++;
    try {
      return await this.invokeInner(actor, raw);
    } finally {
      this.inFlight--;
    }
  }
  private async invokeInner(actor: string, raw: unknown) {
    jsonBytes(raw);
    const args = invokeSchema.parse(raw),
      module = this.module(args.target.module);
    if (module.disabled)
      throw new BackendError(
        'DISABLED',
        'Backend execution is disabled; saved worlds are retained.',
      );
    const now = this.now(),
      expiry = args.expiresAt * 1000;
    if (expiry < now || expiry > now + LIMITS.retrySeconds * 1000)
      throw new BackendError(
        'RETRY_WINDOW_EXPIRED',
        'Request expiry is past or exceeds the five-minute retry window. Inspect world state before sending a new intent.',
      );
    const identity = this.identity(actor, module.key, args.session),
      artifact = this.release(module.key, args.target.release);
    const op = artifact.schemas.operations[args.operation];
    if (!Object.hasOwn(artifact.schemas.operations, args.operation))
      throw new BackendError('BAD_INPUT', 'Operation is not declared by this release.');
    if ((op.account || op.effect === 'create') && !identity.account)
      throw new BackendError('ACCOUNT_REQUIRED', 'Connect a Nostr account for this operation.');
    validateValue(op.input, args.input);
    let instance: InstanceRow;
    if (op.effect === 'create') {
      if (args.target.instance)
        throw new BackendError('BAD_INPUT', 'Creation targets a module, not an existing world.');
      instance = {
        id: digest(`${module.key}/${identity.principal}/${args.requestId}`).slice(0, 32),
        module: module.key,
        release: args.target.release,
        owner: identity.principal,
        revision: 0,
        access: JSON.stringify(closedAccess),
      };
    } else {
      instance = this.instance(module.key, args.target.release, args.target.instance);
      this.canAccess(instance, identity.principal, op.access);
    }
    const requestKey = `${module.key}/${args.target.instance ?? 'create'}/${identity.principal}/${args.requestId}`;
    const payloadHash = digest(
      canonical({
        target: { ...args.target, module: module.key },
        operation: args.operation,
        requestId: args.requestId,
        expiresAt: args.expiresAt,
        input: args.input,
      }),
    );
    this.cleanup();
    const previous = this.db
      .query<Receipt, [string]>('SELECT * FROM requests WHERE key=?')
      .get(requestKey);
    if (previous) {
      if (previous.hash !== payloadHash)
        throw new BackendError(
          'IDEMPOTENCY_CONFLICT',
          'This request ID belongs to different input.',
        );
      return JSON.parse(previous.result);
    }
    if (op.effect === 'create' && module.active !== args.target.release)
      throw new BackendError(
        'RELEASE_MISMATCH',
        'Create new worlds on the active release. Existing worlds keep their own release.',
      );
    const writes = new Map<string, { collection: string; key: string; value: string | null }>(),
      reads = new Set<string>();
    let access = JSON.parse(instance.access) as Access,
      accessChanged = false;
    const host = (method: string, input: Record<string, unknown>): unknown => {
      if (method === 'access') return access;
      if (method === 'setAccess' || method === 'setMember') {
        if (op.effect === 'query' || instance.owner !== identity.principal)
          throw new BackendError(
            'FORBIDDEN',
            'Only the world owner can change membership or access.',
          );
        if (method === 'setAccess')
          access = accessSchema.parse(
            z.object({ value: accessSchema }).strict().parse(input).value,
          );
        else {
          const { principal, role } = z
            .object({
              principal: z.string().regex(/^nostr:[a-f0-9]{64}$/),
              role: z.enum(['viewer', 'builder']).nullable(),
            })
            .strict()
            .parse(input);
          if (principal === instance.owner)
            throw new BackendError('BAD_INPUT', 'World ownership is not a membership role.');
          if (role === null) delete access.members[principal];
          else access.members[principal] = role;
          accessSchema.parse(access);
        }
        accessChanged = true;
        return null;
      }
      if (!['get', 'set', 'remove'].includes(method))
        throw new BackendError('FORBIDDEN', 'Unknown state capability.');
      const parsed =
        method === 'set'
          ? recordRef.extend({ value: z.unknown() }).strict().parse(input)
          : recordRef.parse(input);
      if (!Object.hasOwn(artifact.schemas.records, parsed.collection))
        throw new BackendError('BAD_INPUT', 'State collection is not declared by this release.');
      const key = `${parsed.collection}/${parsed.key}`;
      reads.add(key);
      if (reads.size > LIMITS.recordsPerCall)
        throw new BackendError('QUOTA_EXCEEDED', 'Operation touches too many records.');
      if (method === 'get') {
        if (writes.has(key)) {
          const value = writes.get(key)!.value;
          return value === null ? null : JSON.parse(value);
        }
        const row = this.db
          .query<{ value: string }, [string, string, string]>(
            'SELECT value FROM records WHERE instance=? AND collection=? AND key=?',
          )
          .get(instance.id, parsed.collection, parsed.key);
        return row ? JSON.parse(row.value) : null;
      }
      if (op.effect === 'query')
        throw new BackendError('FORBIDDEN', 'Queries cannot modify state.');
      const value =
        method === 'remove'
          ? null
          : jsonBytes((parsed as { value?: unknown }).value, LIMITS.recordBytes);
      if (value !== null)
        validateValue(artifact.schemas.records[parsed.collection], JSON.parse(value));
      writes.set(key, { collection: parsed.collection, key: parsed.key, value });
      return null;
    };
    const context: RuntimeContext = {
      actor,
      ...identity,
      owner: instance.owner,
      instance: instance.id,
      release: args.target.release,
      operation: args.operation,
      requestId: args.requestId,
      now: Math.floor(now / 1000),
    };
    let result: unknown;
    try {
      result = await executeHandler(artifact.code, context, args.input, host, {
        command: this.options.workerCommand,
      });
    } catch (error) {
      if (error instanceof BackendError && error.code === 'RUNTIME_FAILED') {
        const declared = /^(BAD_INPUT|FORBIDDEN|CONFLICT|ACCOUNT_REQUIRED): (.{1,400})$/.exec(
          error.message,
        );
        if (declared)
          throw new BackendError(
            declared[1] as 'BAD_INPUT' | 'FORBIDDEN' | 'CONFLICT' | 'ACCOUNT_REQUIRED',
            declared[2],
          );
      }
      throw error;
    }
    object(result);
    jsonBytes(result);
    validateValue(op.output, result);
    return this.db
      .transaction(() => {
        const duplicate = this.db
          .query<Receipt, [string]>('SELECT * FROM requests WHERE key=?')
          .get(requestKey);
        if (duplicate) {
          if (duplicate.hash !== payloadHash)
            throw new BackendError(
              'IDEMPOTENCY_CONFLICT',
              'Request ID was committed with different input.',
            );
          return JSON.parse(duplicate.result);
        }
        if (expiry < this.now())
          throw new BackendError(
            'RETRY_WINDOW_EXPIRED',
            'Request expired before commit. No changes were saved.',
          );
        this.identity(actor, module.key, args.session);
        const currentModule = this.module(args.target.module);
        if (currentModule.disabled)
          throw new BackendError(
            'DISABLED',
            'Backend was disabled during execution. No changes were saved.',
          );
        if (op.effect === 'create') {
          if (
            this.db
              .query('SELECT 1 FROM purged_instances WHERE id=? AND expires>=?')
              .get(instance.id, this.now())
          )
            throw new BackendError(
              'RETRY_WINDOW_EXPIRED',
              'This creation request belongs to a purged world. Use a new request ID for a new world.',
            );
          if (currentModule.active !== args.target.release)
            throw new BackendError(
              'RELEASE_MISMATCH',
              'Active release changed during creation. No world was saved.',
            );
          if (
            this.db
              .query<{ count: number }, [string]>(
                'SELECT count(*) count FROM instances WHERE module=?',
              )
              .get(module.key)!.count >= LIMITS.instancesPerModule
          )
            throw new BackendError('QUOTA_EXCEEDED', 'Module world allowance reached.');
          this.db
            .query('INSERT INTO instances VALUES (?,?,?,?,?,?)')
            .run(
              instance.id,
              instance.module,
              instance.release,
              instance.owner,
              0,
              instance.access,
            );
        } else {
          const current = this.instance(module.key, args.target.release, instance.id);
          this.canAccess(current, identity.principal, op.access);
          if (current.revision !== instance.revision)
            throw new BackendError(
              'CONFLICT',
              'World changed during this operation. Refresh state before sending a new intent.',
            );
        }
        const changed = op.effect === 'create' || writes.size > 0 || accessChanged;
        const nextRevision = instance.revision + Number(changed);
        for (const write of writes.values()) {
          if (write.value === null)
            this.db
              .query('DELETE FROM records WHERE instance=? AND collection=? AND key=?')
              .run(instance.id, write.collection, write.key);
          else
            this.db
              .query(
                'INSERT INTO records VALUES (?,?,?,?) ON CONFLICT(instance,collection,key) DO UPDATE SET value=excluded.value',
              )
              .run(instance.id, write.collection, write.key, write.value);
        }
        const usage = this.db
          .query<{ bytes: number; count: number }, [string]>(
            'SELECT count(*) count, coalesce(sum(length(CAST(value AS BLOB))),0) bytes FROM records WHERE instance=?',
          )
          .get(instance.id)!;
        if (usage.bytes > LIMITS.instanceBytes || usage.count > LIMITS.recordsPerInstance)
          throw new BackendError(
            'QUOTA_EXCEEDED',
            'World storage allowance exceeded. No changes were saved.',
          );
        if (
          writes.size &&
          this.db
            .query<{ bytes: number }, []>(
              'SELECT coalesce(sum(length(CAST(value AS BLOB))),0) bytes FROM records',
            )
            .get()!.bytes > LIMITS.providerBytes
        )
          throw new BackendError(
            'QUOTA_EXCEEDED',
            'Provider storage capacity reached. No changes were saved.',
          );
        if (changed) {
          this.db
            .query('UPDATE instances SET revision=?, access=? WHERE id=?')
            .run(nextRevision, JSON.stringify(access), instance.id);
          this.db.query('INSERT INTO changes VALUES (?,?)').run(instance.id, nextRevision);
          this.db
            .query('DELETE FROM changes WHERE instance=? AND revision <= ?')
            .run(instance.id, nextRevision - LIMITS.changes);
        }
        const response = {
          ok: true,
          release: args.target.release,
          requestId: args.requestId,
          instance: instance.id,
          revision: nextRevision,
          result,
        };
        if (
          this.db.query<{ count: number }, []>('SELECT count(*) count FROM requests').get()!
            .count >= LIMITS.pendingReceipts
        )
          throw new BackendError(
            'QUOTA_EXCEEDED',
            'Retry receipt capacity reached. No changes were saved; retry later.',
          );
        this.db
          .query('INSERT INTO requests VALUES (?,?,?,?)')
          .run(requestKey, payloadHash, JSON.stringify(response), expiry + 1000);
        return response;
      })
      .immediate();
  }
  changes(actor: string, raw: unknown) {
    const args = changesSchema.parse(raw),
      module = this.module(args.target.module),
      identity = this.identity(actor, module.key, args.session);
    const instance = this.instance(module.key, args.target.release, args.target.instance);
    this.canAccess(instance, identity.principal, 'reader');
    if (
      args.after > instance.revision ||
      args.after < Math.max(0, instance.revision - LIMITS.changes)
    )
      throw new BackendError(
        'RESYNC_REQUIRED',
        'Cursor is outside retained revisions. Read a fresh snapshot.',
      );
    const changes = this.db
      .query<{ revision: number }, [string, number, number]>(
        'SELECT revision FROM changes WHERE instance=? AND revision>? ORDER BY revision LIMIT ?',
      )
      .all(instance.id, args.after, args.limit);
    return {
      release: instance.release,
      revision: instance.revision,
      after: changes.at(-1)?.revision ?? args.after,
      changes,
      hasMore: (changes.at(-1)?.revision ?? args.after) < instance.revision,
      mode: 'invalidate-and-query',
    };
  }
  purgePlan(actor: string, raw: unknown) {
    const args = purgePlanSchema.parse(raw),
      module = this.module(args.target.module),
      identity = this.identity(actor, module.key, args.session);
    const instance = this.instance(module.key, args.target.release, args.target.instance);
    this.canAccess(instance, identity.principal, 'owner');
    this.cleanup();
    if (
      this.db.query<{ count: number }, []>('SELECT count(*) count FROM purges').get()!.count >= 1024
    )
      throw new BackendError('QUOTA_EXCEEDED', 'Purge plan capacity reached.');
    const records = this.db
      .query<{ count: number; bytes: number }, [string]>(
        'SELECT count(*) count, coalesce(sum(length(CAST(value AS BLOB))),0) bytes FROM records WHERE instance=?',
      )
      .get(instance.id)!;
    const plan = {
      instance: instance.id,
      module: module.key,
      release: instance.release,
      revision: instance.revision,
      records: records.count,
      bytes: records.bytes,
      removes: ['live world', 'live records', 'revision log', 'stored invocation results'],
      retains: [
        'five-minute deletion/deduplication receipt',
        'code releases',
        'public Git history',
        'independent copies',
        'backups according to operator retention',
      ],
    };
    const id = crypto.randomUUID(),
      planHash = digest(canonical(plan));
    this.db
      .query('INSERT INTO purges VALUES (?,?,?,?,?,NULL)')
      .run(id, actor, identity.principal, JSON.stringify(plan), this.now() + 300000);
    return {
      plan: id,
      planHash,
      expiresAt: Math.floor(this.now() / 1000) + 300,
      details: plan,
      confirmationRequired: true,
    };
  }
  purgeConfirm(actor: string, raw: unknown) {
    const args = purgeSchema.parse(raw);
    return this.db
      .transaction(() => {
        const saved = this.db
          .query<
            {
              actor: string;
              principal: string;
              plan: string;
              expires: number;
              result: string | null;
            },
            [string]
          >('SELECT * FROM purges WHERE id=?')
          .get(args.plan);
        if (!saved || saved.actor !== actor || saved.expires < this.now())
          throw new BackendError(
            'FORBIDDEN',
            'Purge plan expired or belongs to another connection.',
          );
        const plan = JSON.parse(saved.plan),
          identity = this.identity(actor, plan.module, args.session);
        if (
          identity.principal !== saved.principal ||
          digest(canonical(plan)) !== args.planHash ||
          reference(args.target.module).key !== plan.module ||
          args.target.instance !== plan.instance ||
          args.target.release !== plan.release
        )
          throw new BackendError(
            'FORBIDDEN',
            'Purge confirmation does not match the reviewed plan.',
          );
        if (saved.result) return JSON.parse(saved.result);
        const instance = this.instance(plan.module, plan.release, plan.instance);
        this.canAccess(instance, identity.principal, 'owner');
        if (instance.revision !== plan.revision)
          throw new BackendError(
            'CONFLICT',
            'World changed since the purge preview. Request and review a fresh plan.',
          );
        this.db.query('DELETE FROM records WHERE instance=?').run(instance.id);
        this.db.query('DELETE FROM changes WHERE instance=?').run(instance.id);
        this.db.query('DELETE FROM instances WHERE id=?').run(instance.id);
        this.db
          .query('INSERT OR REPLACE INTO purged_instances VALUES (?,?)')
          .run(instance.id, this.now() + LIMITS.retrySeconds * 1000 + 1000);
        // Requests also contain create results. Inspect bounded JSON rather than substring-matching keys.
        this.db
          .query("DELETE FROM requests WHERE json_extract(result, '$.instance')=?")
          .run(instance.id);
        const result = {
          deleted: true,
          instance: instance.id,
          removed: plan.removes,
          retained: plan.retains,
        };
        this.db
          .query('UPDATE purges SET result=? WHERE id=?')
          .run(JSON.stringify(result), args.plan);
        return result;
      })
      .immediate();
  }
  async close() {
    this.closing = true;
    await Promise.allSettled([...this.jobs]);
    while (this.inFlight) await new Promise((resolve) => setTimeout(resolve, 10));
    this.db.close();
  }
}
