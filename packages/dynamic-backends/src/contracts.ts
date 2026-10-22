import { z } from 'zod';
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import { decodeAddress, identityAddress, encodeAddress } from '../../protocol/src';

export const PROFILE = 'soy-ts-quickjs-v1' as const;
export const ABI = 'soy-handler-v1' as const;
export const LIMITS = Object.freeze({
  sourceBytes: 262144,
  jsonBytes: 65536,
  recordBytes: 16384,
  memoryBytes: 16777216,
  stackBytes: 262144,
  executionMs: 500,
  lifetimeMs: 5000,
  interruptChecks: 10000,
  hostCalls: 128,
  recordsPerCall: 64,
  bytesPerCall: 262144,
  instanceBytes: 8388608,
  instancesPerModule: 64,
  releasesPerModule: 32,
  modules: 256,
  operations: 32,
  schemaBytes: 65536,
  retrySeconds: 300,
  changes: 1024,
  recordsPerInstance: 4096,
  pendingReceipts: 4096,
  sessions: 4096,
  providerBytes: 268435456,
});
export const hash = z.string().regex(/^[a-f0-9]{64}$/);
export const id = z.string().regex(/^[a-zA-Z0-9_-]{1,128}$/);
export const revision = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
export const moduleRef = z
  .object({ napplet: z.string().max(4096), name: z.string().regex(/^[a-z][a-z0-9-]{0,47}$/) })
  .strict();
export type ModuleRef = z.infer<typeof moduleRef>;
export function reference(input: ModuleRef) {
  const address = decodeAddress(input.napplet);
  if (address.kind !== 35129)
    throw new BackendError('BAD_INPUT', 'Use an author-qualified named napplet address.');
  return {
    owner: address.pubkey,
    key: `${identityAddress(address)}/${input.name}`,
    module: { ...input, napplet: encodeAddress(address) },
  };
}
export const pathSchema = z
  .string()
  .min(1)
  .max(240)
  .regex(/^[a-zA-Z0-9_.-]+(?:\/[a-zA-Z0-9_.-]+)*$/)
  .refine(
    (value) =>
      !value.split('/').some((part) => part === '.' || part === '..') && !/[\r\n]/.test(value),
    'Use a relative file path without dot segments.',
  );
export const manifestSchema = z
  .object({
    format: z.literal('soy.backend/1'),
    name: moduleRef.shape.name,
    buildProfile: z.literal(PROFILE),
    entry: pathSchema,
    schemas: pathSchema,
    stateVersion: z.number().int().min(1).max(65535),
    abi: z.literal(ABI),
  })
  .strict();
export const sourceSchema = z
  .object({
    repository: z.string().regex(/^30617:[a-f0-9]{64}:[a-zA-Z0-9_-]{1,128}$/),
    cloneUrl: z.string().url().max(2048),
    commit: z.string().regex(/^[a-f0-9]{40}$/),
    manifest: pathSchema,
  })
  .strict();
export type Source = z.infer<typeof sourceSchema>;
const signed = { authorization: z.unknown(), requestId: z.string().uuid() };
export const buildSchema = z
  .object({ module: moduleRef, source: sourceSchema, buildProfile: z.literal(PROFILE), ...signed })
  .strict();
export const activateSchema = z
  .object({ module: moduleRef, release: hash, expectedActiveRelease: hash.nullable(), ...signed })
  .strict();
export const describeSchema = z.object({ module: moduleRef, release: hash.optional() }).strict();
export const disableSchema = z
  .object({ module: moduleRef, expectedModuleRevision: revision, disabled: z.boolean(), ...signed })
  .strict();
export const deleteReleaseSchema = z
  .object({ module: moduleRef, release: hash, ...signed })
  .strict();
export const targetSchema = z
  .object({ module: moduleRef, release: hash, instance: id.optional() })
  .strict();
export const invokeSchema = z
  .object({
    target: targetSchema,
    operation: z.string().regex(/^[a-z][a-zA-Z0-9]{0,63}$/),
    requestId: z.string().uuid(),
    expiresAt: z.number().int().nonnegative(),
    session: id.optional(),
    input: z.record(z.string(), z.unknown()),
  })
  .strict();
export const changesSchema = z
  .object({
    target: targetSchema,
    after: revision,
    limit: z.number().int().min(1).max(64).default(32),
    session: id.optional(),
  })
  .strict();
export const challengeSchema = z.object({ module: moduleRef, account: hash }).strict();
export const bindSchema = z.object({ challenge: id, authorization: z.unknown() }).strict();
export const purgePlanSchema = z.object({ target: targetSchema, session: id }).strict();
export const purgeSchema = z
  .object({ target: targetSchema, plan: id, planHash: hash, session: id })
  .strict();
export const accessSchema = z
  .object({
    visibility: z.enum(['public', 'members']),
    building: z.enum(['members', 'everyone']),
    guestsMayBuild: z.boolean(),
    members: z
      .record(z.string().regex(/^nostr:[a-f0-9]{64}$/), z.enum(['builder', 'viewer']))
      .refine((x) => Object.keys(x).length <= 128),
  })
  .strict();
export type Access = z.infer<typeof accessSchema>;
export const closedAccess: Access = {
  visibility: 'members',
  building: 'members',
  guestsMayBuild: false,
  members: {},
};
export type Code =
  | 'BAD_INPUT'
  | 'FORBIDDEN'
  | 'ACCOUNT_REQUIRED'
  | 'NOT_FOUND'
  | 'CONFLICT'
  | 'IDEMPOTENCY_CONFLICT'
  | 'RELEASE_MISMATCH'
  | 'DISABLED'
  | 'QUOTA_EXCEEDED'
  | 'DEADLINE_EXCEEDED'
  | 'RETRY_WINDOW_EXPIRED'
  | 'RESYNC_REQUIRED'
  | 'BUILD_FAILED'
  | 'RUNTIME_FAILED';
export class BackendError extends Error {
  constructor(
    readonly code: Code,
    message: string,
  ) {
    super(message);
    this.name = 'BackendError';
  }
}
export function digest(value: string | Uint8Array) {
  return bytesToHex(sha256(typeof value === 'string' ? new TextEncoder().encode(value) : value));
}
/** Canonical JSON after bounded validation; no executable properties or non-JSON values. */
export function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value !== null && typeof value === 'object')
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`)
      .join(',')}}`;
  return JSON.stringify(value);
}
export function authorizationTemplate(
  provider: string,
  actor: string,
  operation: string,
  input: unknown,
  now = Date.now(),
) {
  return {
    kind: 1,
    created_at: Math.floor(now / 1000),
    tags: [
      ['t', 'soy-backend-authorization-v1'],
      ['p', provider],
    ],
    content: canonical({ actor, operation, input }),
  };
}
