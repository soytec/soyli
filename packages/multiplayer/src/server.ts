import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import {
  Matchmaking,
  joinSchema,
  protocolJoinSchema,
  ticketSchema,
  matchSchema,
} from './matchmaking';
import { Boards, boardRegister, boardSubmit, boardRead, boardEntry } from './boards';
import { Rooms, roomCreate, roomKey, roomNamespace } from './rooms';
import { registerDynamicTools } from '../../dynamic-backends/src/server';
import type { DynamicBackends } from '../../dynamic-backends/src/service';

export function createMatchmakingServer(
  service = new Matchmaking(),
  options: {
    boards?: Boards;
    rooms?: Rooms;
    ice?: (actor: string) => Record<string, unknown>;
    dynamic?: DynamicBackends;
  } = {},
) {
  const server = new McpServer({ name: 'napplet-soy-backend', version: '1.1.0' });
  const boards = options.boards ?? new Boards();
  const rooms = options.rooms ?? new Rooms();
  const limits = new Map<string, { start: number; calls: number }>();
  const result = (operation: () => Record<string, unknown>) => {
    try {
      const value = operation();
      return {
        structuredContent: value,
        content: [{ type: 'text' as const, text: JSON.stringify(value) }],
      };
    } catch (error) {
      return {
        isError: true,
        content: [
          {
            type: 'text' as const,
            text: error instanceof Error ? error.message : 'Matchmaking failed',
          },
        ],
      };
    }
  };
  const actor = (meta: Record<string, unknown> | undefined) => {
    const pubkey = meta?.clientPubkey;
    if (typeof pubkey !== 'string' || !/^[a-f0-9]{64}$/.test(pubkey))
      throw new Error('Authenticated ContextVM client required');
    const now = Date.now();
    for (const [key, value] of limits) if (value.start + 60_000 <= now) limits.delete(key);
    const previous = limits.get(pubkey);
    if (previous && ++previous.calls > 120) throw new Error('Rate limited; retry in a minute');
    if (!previous) {
      if (limits.size >= 2000) throw new Error('Provider busy');
      limits.set(pubkey, { start: now, calls: 1 });
    }
    return pubkey;
  };
  server.registerTool(
    'space_match_join',
    {
      description:
        'Join a queue for an exact napplet address and aggregate hash. Repeat joins are idempotent. Waiting tickets expire after 60 seconds without a status check.',
      inputSchema: joinSchema,
      outputSchema: matchSchema,
    },
    (args, extra) => result(() => service.join(actor(extra._meta), args)),
  );
  server.registerTool(
    'space_match_status',
    {
      description:
        'Check your own ticket and renew its waiting lease. A match lists peer transport pubkeys and a shared room ID. Poll at most once every two seconds.',
      inputSchema: ticketSchema,
      outputSchema: matchSchema,
    },
    (args, extra) => result(() => service.status(actor(extra._meta), args)),
  );
  server.registerTool(
    'space_match_leave',
    {
      description:
        'Leave your queue or match. Leaving a match closes it for the remaining peers. Idempotent.',
      inputSchema: ticketSchema,
      outputSchema: z.object({ left: z.boolean() }),
    },
    (args, extra) => result(() => service.leave(actor(extra._meta), args)),
  );
  const tool = (
    name: string,
    description: string,
    inputSchema: z.ZodObject,
    action: (actor: string, args: unknown) => Record<string, unknown>,
  ) =>
    server.registerTool(name, { description, inputSchema }, (args, extra) =>
      result(() => action(actor(extra._meta), args)),
    );
  tool(
    'soy_match_join',
    'Join an idempotent queue by author-qualified napplet, application protocol version, queue and desired capacity. No build hash is needed. Waiting lease: 60 seconds; matched ticket: 10 minutes.',
    protocolJoinSchema,
    (actor, args) => service.joinProtocol(actor, args),
  );
  tool(
    'soy_match_status',
    'Read your ticket and renew its waiting lease. Poll at most once every two seconds. Matched peers and room are a rendezvous, not game authority.',
    ticketSchema,
    (actor, args) => service.status(actor, args),
  );
  tool(
    'soy_match_leave',
    'Leave your ticket, closing a fixed match for remaining peers. Use named rooms for independent membership.',
    ticketSchema,
    (actor, args) => service.leave(actor, args),
  );
  tool(
    'soy_session',
    'Your scoped transport identity and service contract version. This is not your Nostr profile.',
    z.object({}).strict(),
    (actor) => ({
      version: 1,
      actor,
      ...(options.dynamic ? { dynamic: options.dynamic.health() } : {}),
      families: [
        'soy.matchmaking.v1',
        'soy.rooms.v1',
        'soy.boards.v1',
        'soy.boards.v2',
        ...(options.dynamic ? ['soy.backends.v1'] : []),
      ],
      payments: 'free',
      updates: 'poll',
      minimumPollMs: 2000,
    }),
  );
  tool(
    'soy_board_register',
    'Register immutable board rules and optional dataSchema using the napplet author signature. Retrying the same definition is safe. Changed rules or dataSchema need a new board ID.',
    boardRegister,
    (actor, args) => boards.register(actor, args),
  );
  tool(
    'soy_board_submit',
    'Submit a casual, client-reported personal best with data when required by its dataSchema. Score and data update together only for a strictly better result; ties/retries preserve the first run. Transport keys are not Sybil resistant.',
    boardSubmit,
    (actor, args) => boards.submit(actor, args),
  );
  tool(
    'soy_board_read',
    'Read current scores and your personal best, including hasData and revision. Fetch attachments with soy_board_entry. Poll no more often than every two seconds; notifications are not durable state.',
    boardRead,
    (actor, args) => boards.read(actor, args),
  );
  tool(
    'soy_board_entry',
    'Read one public personal-best entry and its JSON data (up to 8 KiB). Supply actor and revision from soy_board_read to avoid mixing different runs. If stale is true, refresh the leaderboard; old runs are not retained.',
    boardEntry,
    (_, args) => boards.entry(args),
  );
  tool(
    'soy_room_create',
    'Create a named room with configurable capacity. Membership expires after 60 seconds without status calls.',
    roomCreate,
    (actor, args) => rooms.create(actor, args),
  );
  tool(
    'soy_room_list',
    'List up to 100 listed rooms for an author-qualified napplet and application protocol. Room IDs are rendezvous, not authorization secrets.',
    roomNamespace.strict(),
    (_, args) => rooms.list(args),
  );
  tool(
    'soy_room_join',
    'Join a room. Returns authenticated transport peer keys for NAP-WEBRTC.',
    roomKey,
    (actor, args) => rooms.access(actor, args, true),
  );
  tool(
    'soy_room_status',
    'Renew your room membership and read current peers. Poll every 2–20 seconds while active.',
    roomKey,
    (actor, args) => rooms.access(actor, args, false),
  );
  tool(
    'soy_room_leave',
    'Leave a room without closing it for the other members.',
    roomKey,
    (actor, args) => rooms.leave(actor, args),
  );
  if (options.ice)
    tool(
      'soy_ice',
      'Host connectivity credentials. Short-lived TURN credentials never belong in a published napplet.',
      z.object({}).strict(),
      (actor) => options.ice!(actor),
    );
  if (options.dynamic) registerDynamicTools(server, options.dynamic);
  const close = server.close.bind(server);
  server.close = async () => {
    await close();
    boards.close();
    await options.dynamic?.close();
  };
  return server;
}
