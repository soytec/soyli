import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { DynamicBackends } from './service';
import {
  BackendError,
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
} from './contracts';
import { jsonBytes } from './schema';
import { diagnose, redactDiagnostic } from '../../diagnostics/src';

export function registerDynamicTools(server: McpServer, service: DynamicBackends) {
  let windowStart = Date.now(),
    windowCalls = 0;
  const rates = new Map<string, { expires: number; calls: number }>();
  function tool(
    name: string,
    description: string,
    inputSchema: z.ZodObject,
    action: (actor: string, input: unknown) => unknown,
  ) {
    server.registerTool(
      `soy_backend_${name}`,
      { description, inputSchema },
      async (args, extra) => {
        try {
          const actor = extra._meta?.clientPubkey;
          if (typeof actor !== 'string' || !/^[a-f0-9]{64}$/.test(actor))
            throw new BackendError('FORBIDDEN', 'Authenticated CVM transport identity required.');
          const now = Date.now();
          if (now - windowStart >= 60000) {
            windowStart = now;
            windowCalls = 0;
          }
          if (++windowCalls > 3000)
            throw new BackendError(
              'QUOTA_EXCEEDED',
              'Provider request capacity reached. Retry in a minute.',
            );
          for (const [key, rate] of rates) if (rate.expires < now) rates.delete(key);
          if (!rates.has(actor)) {
            if (rates.size >= 4096)
              throw new BackendError('QUOTA_EXCEEDED', 'Provider connection capacity reached.');
            rates.set(actor, { expires: now + 60000, calls: 0 });
          }
          if (++rates.get(actor)!.calls > 600)
            throw new BackendError(
              'QUOTA_EXCEEDED',
              'Backend request rate exceeded. Retry in a minute.',
            );
          jsonBytes(args);
          const value = (await action(actor, args)) as Record<string, unknown>;
          const json = jsonBytes(value, 100000);
          return { structuredContent: value, content: [{ type: 'text' as const, text: json }] };
        } catch (error) {
          const value = {
            ok: false,
            error: {
              code: error instanceof BackendError ? error.code : 'BAD_INPUT',
              message:
                error instanceof BackendError
                  ? redactDiagnostic(error.message)
                  : error instanceof z.ZodError
                    ? 'Input does not match this tool schema.'
                    : diagnose(error, `dynamic backend ${name}`).message,
              retryable:
                error instanceof BackendError &&
                ['QUOTA_EXCEEDED', 'DEADLINE_EXCEEDED'].includes(error.code),
            },
          };
          return {
            isError: true,
            structuredContent: value,
            content: [{ type: 'text' as const, text: JSON.stringify(value) }],
          };
        }
      },
    );
  }
  tool(
    'build',
    'Build pinned public Git source in the provider compiler. Requires the module author signature. Returns a job ID; never uploads caller-built executables.',
    buildSchema,
    service.build.bind(service),
  );
  tool(
    'build_status',
    'Read your build job and safe compiler diagnostics using the submitting connection. Poll at most once per second.',
    z.object({ build: z.string().uuid() }).strict(),
    service.buildStatus.bind(service),
  );
  tool(
    'describe',
    'Inspect immutable operation/state schemas, source-build receipt and execution limits. Default activation affects new worlds only.',
    describeSchema,
    service.describe.bind(service),
  );
  tool(
    'activate',
    'Set the default release for new worlds using author proof and expected current release. Existing worlds stay pinned.',
    activateSchema,
    service.activate.bind(service),
  );
  tool(
    'disable',
    'Author-authorized enable/disable switch with optimistic revision check. Disabling retains worlds.',
    disableSchema,
    service.disable.bind(service),
  );
  tool(
    'delete_release',
    'Remove unused code; refuses active and world-referenced releases. Public source and build receipts remain.',
    deleteReleaseSchema,
    service.deleteRelease.bind(service),
  );
  tool(
    'session_challenge',
    'Request a scoped proof to bind a Nostr account to this transport, provider and module. Approval belongs to the selected signer.',
    challengeSchema,
    service.sessionChallenge.bind(service),
  );
  tool(
    'session_bind',
    'Verify the signed challenge. Returned session is bound to the caller transport, expires after one hour and is not a bearer token.',
    bindSchema,
    service.sessionBind.bind(service),
  );
  tool(
    'session_revoke',
    'Revoke your scoped account session and its challenge.',
    z.object({ session: z.string().uuid() }).strict(),
    service.revokeSession.bind(service),
  );
  tool(
    'invoke',
    'Execute a release-pinned operation with bounded state access. Preserve requestId, expiry and payload when retrying an uncertain response. Commands commit all writes or none.',
    invokeSchema,
    service.invoke.bind(service),
  );
  tool(
    'changes',
    'Read durable revision invalidations; refetch through authorized queries. Contains no private record payloads. Expired cursors require a snapshot.',
    changesSchema,
    service.changes.bind(service),
  );
  tool(
    'purge_plan',
    'World owner only: preview exact live-data deletion and retained artifacts. This does not delete anything.',
    purgePlanSchema,
    service.purgePlan.bind(service),
  );
  tool(
    'purge_confirm',
    'World owner only: confirm an unexpired reviewed purge plan by its digest. Refuses a changed world.',
    purgeSchema,
    service.purgeConfirm.bind(service),
  );
}
