import { matchFilters, type NostrEvent, type Filter } from 'nostr-tools';
import { verifySignature } from '../../protocol/src/verify';
import { z } from 'zod';

/** Bounded loopback-only preview relay. Production and full-stack dev use Khatru. */
export function startLocalBackendRelay() {
  type Socket = Bun.ServerWebSocket<{
    subscriptions: Map<string, Filter[]>;
    count: number;
    since: number;
  }>;
  const sockets = new Set<Socket>(),
    events = new Map<string, NostrEvent>();
  const filters = z
    .array(
      z
        .object({
          kinds: z.array(z.number().int()).max(16).optional(),
          authors: z
            .array(z.string().regex(/^[a-f0-9]{64}$/))
            .max(16)
            .optional(),
          since: z.number().optional(),
          until: z.number().optional(),
          limit: z.number().min(1).max(100).optional(),
          ids: z.array(z.string()).max(16).optional(),
        })
        .catchall(z.array(z.string().max(256)).max(16)),
    )
    .min(1)
    .max(4);
  const relay = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch(request, server) {
      const origin = request.headers.get('Origin');
      if (
        sockets.size >= 64 ||
        (origin && !['127.0.0.1', 'localhost', '[::1]'].includes(new URL(origin).hostname))
      )
        return new Response('Forbidden', { status: 403 });
      if (
        server.upgrade(request, { data: { subscriptions: new Map(), count: 0, since: Date.now() } })
      )
        return;
      return new Response('Local napplet backend relay');
    },
    websocket: {
      maxPayloadLength: 128000,
      open(ws: Socket) {
        sockets.add(ws);
      },
      close(ws: Socket) {
        sockets.delete(ws);
      },
      message(ws: Socket, raw) {
        if (Date.now() - ws.data.since >= 60000) {
          ws.data.since = Date.now();
          ws.data.count = 0;
        }
        if (++ws.data.count > 2000) {
          ws.close(1008, 'Rate limited');
          return;
        }
        try {
          const message = JSON.parse(String(raw));
          if (message[0] === 'REQ') {
            const id = z.string().max(128).parse(message[1]),
              parsed = filters.parse(message.slice(2)) as Filter[];
            if (ws.data.subscriptions.size >= 32 && !ws.data.subscriptions.has(id)) return;
            ws.data.subscriptions.set(id, parsed);
            for (const event of events.values())
              if (matchFilters(parsed, event)) ws.send(JSON.stringify(['EVENT', id, event]));
            ws.send(JSON.stringify(['EOSE', id]));
          } else if (message[0] === 'CLOSE') ws.data.subscriptions.delete(message[1]);
          else if (message[0] === 'EVENT') {
            const event = message[1] as NostrEvent;
            if (
              ![1059, 21059, 25910, 25050, 11316, 11317, 11318, 11319, 10002].includes(
                event.kind,
              ) ||
              !verifySignature(event)
            )
              return;
            if (event.kind < 20000 || event.kind >= 30000) {
              for (const [key, old] of events)
                if (old.created_at < Date.now() / 1000 - 300) events.delete(key);
              if (events.size >= 1000) events.delete(events.keys().next().value!);
              events.set(event.id, event);
            }
            ws.send(JSON.stringify(['OK', event.id, true, '']));
            for (const peer of sockets)
              for (const [id, f] of peer.data.subscriptions)
                if (matchFilters(f, event)) peer.send(JSON.stringify(['EVENT', id, event]));
          }
        } catch {
          ws.send(JSON.stringify(['NOTICE', 'Invalid local relay request']));
        }
      },
    },
  });
  return { url: `ws://127.0.0.1:${relay.port}`, close: () => relay.stop(true) };
}
