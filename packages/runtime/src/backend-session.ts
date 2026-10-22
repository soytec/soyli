import { z } from 'zod';
import { PrivateKeySigner } from '@contextvm/sdk/signer';
import { ApplesauceRelayPool } from '@contextvm/sdk/relay';
import { computeCommonSchemaHash } from '@contextvm/sdk/core/utils/common-schema';
import { generateSecretKey } from 'nostr-tools';
import { verifySignature } from '../../protocol/src/verify';
import {
  CvmConnection,
  validateProvider,
  type BackendProvider,
} from '../../multiplayer/src/client';
import { readRelayUrl } from '../../nostr/src/relay-policy';
import type { Tool } from '@modelcontextprotocol/sdk/types.js';
import { BackendAccount, type BackendAccountOptions } from './backend-account';

const families: Record<string, string[]> = {
  'soy.backends.v1': [
    'soy_session',
    ...[
      'build',
      'build_status',
      'describe',
      'activate',
      'disable',
      'delete_release',
      'session_challenge',
      'session_bind',
      'session_revoke',
      'invoke',
      'changes',
      'purge_plan',
      'purge_confirm',
    ].map((name) => `soy_backend_${name}`),
  ],
  'soy.matchmaking.v1': ['soy_session', 'soy_match_join', 'soy_match_status', 'soy_match_leave'],
  'soy.rooms.v1': [
    'soy_session',
    'soy_room_create',
    'soy_room_list',
    'soy_room_join',
    'soy_room_status',
    'soy_room_leave',
  ],
  'soy.boards.v1': ['soy_session', 'soy_board_read', 'soy_board_submit', 'soy_board_register'],
  'soy.boards.v2': [
    'soy_session',
    'soy_board_read',
    'soy_board_submit',
    'soy_board_register',
    'soy_board_entry',
  ],
};
const rpc = z
  .object({
    jsonrpc: z.literal('2.0'),
    id: z.union([z.string().max(128), z.number().finite()]),
    method: z.string().max(100),
    params: z.record(z.string(), z.unknown()).optional(),
  })
  .strict();
const optionsSchema = z.object({
  // The iframe deadline includes human consent/signing. Individual provider RPCs
  // still have CvmConnection's independent 25-second ceiling.
  timeoutMs: z.number().int().min(1).max(120000).optional(),
  initialize: z.boolean().optional(),
  payment: z.enum(['deny', 'prompt', 'allow']).optional(),
  cache: z.enum(['default', 'reload', 'no-store']).optional(),
  server: z.unknown().optional(),
  schemaHash: z.string().max(64).optional(),
});

export function transportSigner(storage: Pick<Storage, 'getItem' | 'setItem'>, scope: string) {
  // Host-owned, per-tab/per-napplet guest identity; never returned to the iframe.
  const key = `napplet:transport:v1:${scope}`;
  let secret = storage.getItem(key);
  if (!secret || !/^[a-f0-9]{64}$/.test(secret)) {
    secret = Array.from(generateSecretKey(), (b) => b.toString(16).padStart(2, '0')).join('');
    storage.setItem(key, secret);
  }
  return new PrivateKeySigner(secret);
}

export class NappletBackend {
  private account?: BackendAccount;
  private connections = new Map<string, CvmConnection>();
  private approved = new Set<string>();
  private discovery = new Set<ApplesauceRelayPool>();
  private alive = true;
  private entries = new Map<
    string,
    {
      until: number;
      entry: {
        family: string;
        selected: BackendProvider;
        providers: BackendProvider[];
        tools: Tool[];
      };
    }
  >();
  constructor(
    readonly signer: PrivateKeySigner,
    private relays: string[],
    readonly provider: BackendProvider | undefined,
    private send: (message: Record<string, unknown>) => void,
    private consent: (label: string) => Promise<boolean>,
    private aliases: BackendProvider[] = [],
    account?: BackendAccountOptions,
  ) {
    if (account) this.account = new BackendAccount(account, () => signer.getPublicKey());
  }
  private async request(
    connection: CvmConnection,
    method: string,
    params?: Record<string, unknown>,
    timeout?: number,
  ) {
    if (method === 'tools/call' && this.account)
      params = {
        ...params,
        arguments: await this.account.arguments(
          connection,
          connection.provider.pubkey,
          params?.name,
          z.record(z.string(), z.unknown()).parse(params?.arguments ?? {}),
        ),
      };
    return connection.request(method, params, timeout);
  }
  private ref(value: unknown) {
    const raw = z
      .object({ pubkey: z.string(), relays: z.array(z.string()).optional() })
      .parse(value);
    if (this.provider && this.aliases.some((alias) => alias.pubkey === raw.pubkey))
      return validateProvider(this.provider, this.relays);
    return validateProvider({ ...raw, relays: raw.relays ?? this.relays }, this.relays);
  }
  async connection(ref: BackendProvider) {
    ref = this.ref(ref);
    if (!this.alive) throw new Error('CVM session closed');
    const key = JSON.stringify(ref);
    if (!this.approved.has(key)) {
      if (this.approved.size >= 32)
        throw new Error('Backend permission limit reached; restart the napplet.');
      const trusted = this.provider && key === JSON.stringify(this.ref(this.provider));
      if (
        !trusted &&
        !(await this.consent(
          `Connect to backend ${ref.pubkey.slice(0, 12)} via ${ref.relays.join(', ')}?`,
        ))
      )
        throw new Error('Backend connection denied');
      if (!this.alive) throw new Error('CVM session closed');
      this.approved.add(key);
    }
    let connection = this.connections.get(key);
    if (connection?.closed) {
      this.connections.delete(key);
      connection = undefined;
    }
    if (!connection) {
      if (this.connections.size >= 4) throw new Error('CVM provider limit reached');
      connection = new CvmConnection(ref, this.signer, (message) =>
        this.send({ type: 'cvm.event', server: ref, message }),
      );
      this.connections.set(key, connection);
    }
    return connection;
  }
  private async entry(family: string, opts: ReturnType<typeof optionsSchema.parse>) {
    if (!families[family] || opts.schemaHash)
      throw new Error('Registry family or schema unavailable');
    const ref = this.ref(opts.server ?? this.provider);
    const key = JSON.stringify([family, ref]);
    const cached = this.entries.get(key);
    if (cached && cached.until > Date.now() && (!opts.cache || opts.cache === 'default'))
      return cached.entry;
    const connection = await this.connection(ref);
    const result = await connection.request('tools/list');
    const tools = z
      .array(
        z
          .object({
            name: z.string(),
            description: z.string().optional(),
            inputSchema: z.object({ type: z.literal('object') }).passthrough(),
            outputSchema: z
              .object({ type: z.literal('object') })
              .passthrough()
              .optional(),
          })
          .passthrough(),
      )
      .max(128)
      .parse(result.tools)
      .filter((t) => families[family].includes(t.name))
      .map((t) => {
        const schemaHash = computeCommonSchemaHash(t);
        const advertised = (t._meta as Record<string, { schemaHash?: string }> | undefined)?.[
          'io.contextvm/common-schema'
        ]?.schemaHash;
        if (advertised && advertised !== schemaHash)
          throw new Error('Provider schema hash mismatch');
        return { ...t, schemaHash };
      });
    if (tools.length !== families[family].length)
      throw new Error('Provider does not implement this family');
    // Configured provider selection, never automatic state migration or semantic equivalence by name.
    const entry = { family, selected: ref, providers: [ref], tools };
    if (opts.cache !== 'no-store') this.entries.set(key, { until: Date.now() + 30000, entry });
    return entry;
  }
  async handle(message: Record<string, unknown>): Promise<Record<string, unknown>> {
    const opts = optionsSchema.parse(message.options ?? {});
    // No wallet or payment middleware exists here; payment-required responses remain errors.
    if (message.type === 'cvm.request') {
      const request = rpc.parse(message.message),
        ref = this.ref(message.server);
      const connection = await this.connection(ref);
      try {
        const result = await this.request(
          connection,
          request.method,
          request.params,
          opts.timeoutMs,
        );
        return { message: { jsonrpc: '2.0', id: request.id, result } };
      } catch (error) {
        return {
          message: {
            jsonrpc: '2.0',
            id: request.id,
            error: {
              code: -32000,
              message: error instanceof Error ? error.message : 'CVM request failed',
            },
          },
        };
      }
    }
    if (message.type === 'cvm.close') {
      const key = JSON.stringify(this.ref(message.server)),
        connection = this.connections.get(key);
      this.connections.delete(key);
      await connection?.close();
      return {};
    }
    if (message.type === 'cvm.discover') {
      const query = z
        .object({
          search: z.string().max(100).optional(),
          kinds: z.array(z.number().int()).optional(),
          relays: z.array(z.string()).max(8).optional(),
          limit: z.number().int().min(1).max(50).default(20),
        })
        .parse(message.query ?? {});
      if (query.kinds && !query.kinds.includes(11316)) return { servers: [] };
      const urls = (query.relays ?? this.relays).map((r) => readRelayUrl(r, this.relays, true));
      const pool = new ApplesauceRelayPool(urls),
        found = new Map<string, Record<string, unknown>>();
      this.discovery.add(pool);
      try {
        await pool.connect();
        await new Promise<void>(async (resolve) => {
          const timer = setTimeout(resolve, 2000);
          try {
            await pool.subscribe(
              [{ kinds: [11316], limit: query.limit }],
              (event) => {
                if (
                  !verifySignature(event) ||
                  event.content.length > 8192 ||
                  found.size >= query.limit
                )
                  return;
                let metadata: Record<string, unknown> = {};
                try {
                  metadata = JSON.parse(event.content);
                } catch {}
                const name =
                  typeof metadata.name === 'string' ? metadata.name.slice(0, 100) : undefined;
                if (
                  query.search &&
                  !`${name ?? ''} ${event.pubkey}`
                    .toLowerCase()
                    .includes(query.search.toLowerCase())
                )
                  return;
                found.set(event.pubkey, {
                  pubkey: event.pubkey,
                  relays: urls,
                  ...(name ? { name } : {}),
                });
              },
              () => {
                clearTimeout(timer);
                resolve();
              },
            );
          } catch {
            clearTimeout(timer);
            resolve();
          }
        });
      } finally {
        this.discovery.delete(pool);
        await pool.disconnect();
      }
      return { servers: [...found.values()] };
    }
    if (message.type === 'cvm.registry.list') {
      const query = z
        .object({
          family: z.string().optional(),
          search: z.string().optional(),
          schemaHash: z.string().optional(),
          limit: z.number().int().min(1).max(50).optional(),
        })
        .parse(message.query ?? {});
      if (!this.provider || query.schemaHash) return { entries: [] };
      const names = Object.keys(families)
        .filter(
          (f) =>
            (!query.family || query.family === f) && (!query.search || f.includes(query.search)),
        )
        .slice(0, query.limit ?? 10);
      const resolved = await Promise.allSettled(names.map((f) => this.entry(f, {})));
      for (const result of resolved)
        if (
          result.status === 'rejected' &&
          !(
            result.reason instanceof Error &&
            result.reason.message === 'Provider does not implement this family'
          )
        )
          throw result.reason;
      return {
        entries: resolved.flatMap((result) =>
          result.status === 'fulfilled' ? [result.value] : [],
        ),
      };
    }
    const family = z.string().max(100).parse(message.family);
    if (message.type === 'cvm.registry.has') {
      try {
        await this.entry(family, opts);
        return { has: true };
      } catch {
        return { has: false };
      }
    }
    const entry = await this.entry(family, opts);
    if (message.type === 'cvm.registry.describe') return { entry };
    if (message.type === 'cvm.registry.call') {
      if (!entry.tools.some((t) => t.name === message.tool))
        throw new Error('Tool not in selected family');
      const connection = await this.connection(entry.selected);
      return {
        result: await this.request(
          connection,
          'tools/call',
          { name: message.tool, arguments: message.args ?? {} },
          opts.timeoutMs,
        ),
      };
    }
    throw new Error('Unsupported CVM operation');
  }
  close() {
    this.alive = false;
    for (const connection of this.connections.values()) void connection.close();
    for (const pool of this.discovery) void pool.disconnect();
    this.connections.clear();
    this.discovery.clear();
    this.entries.clear();
  }
}
