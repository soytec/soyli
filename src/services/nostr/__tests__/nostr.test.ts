import { afterEach, expect, test } from 'bun:test';
import type { ServerWebSocket } from 'bun';
import { finalizeEvent, generateSecretKey } from 'nostr-tools';
import { publishFirst, readComplete, readEvents } from '../nostr.ts';
import { relayPool } from '../relay-pool.ts';
import { readRelays } from '../relay-policy.ts';
import { readRepository } from '#src/services/collaboration/protocol.ts';

const cleanups: (() => void)[] = [];
afterEach(() => {
  relayPool.close();
  for (const cleanup of cleanups.splice(0).reverse()) cleanup();
});

function relay(handle: (socket: ServerWebSocket<undefined>, message: any[]) => void) {
  let connections = 0;
  const server = Bun.serve<undefined>({
    hostname: '127.0.0.1', port: 0,
    fetch(request, server) {
      if (server.upgrade(request)) return;
      return new Response(null, { status: 400 });
    },
    websocket: {
      open() { connections++; },
      message(socket, message) { handle(socket, JSON.parse(String(message))); },
    },
  });
  cleanups.push(() => { server.stop(true); });
  return { url: `ws://127.0.0.1:${server.port}/`, connections: () => connections };
}

function note(kind = 1, tags: string[][] = [], key = generateSecretKey()) {
  return finalizeEvent({ kind, content: '', tags, created_at: Math.floor(Date.now() / 1000) }, key);
}

test('native reads and first-ack publishing reuse one normalized connection', async () => {
  const event = note();
  let requests = 0;
  const remote = relay((socket, message) => {
    if (message[0] === 'REQ') {
      requests++;
      socket.send(JSON.stringify(['EVENT', message[1], event]));
      socket.send(JSON.stringify(['EOSE', message[1]]));
    } else if (message[0] === 'EVENT') socket.send(JSON.stringify(['OK', message[1].id, true, '']));
  });
  const relays = readRelays([remote.url, remote.url.slice(0, -1)]);
  const filters = [{ kinds: [1] }];
  expect(await readComplete(relays, filters)).toEqual([event]);
  expect(await readEvents(relays, filters)).toEqual([event]);
  expect(await publishFirst(relays, event)).toEqual([remote.url]);
  expect(requests).toBe(2);
  expect(remote.connections()).toBe(1);
});

test('strict reads reject partial success, no relays and silent relays', async () => {
  const complete = relay((socket, message) => {
    if (message[0] === 'REQ') socket.send(JSON.stringify(['EOSE', message[1]]));
  });
  const closed = relay((socket, message) => {
    if (message[0] === 'REQ') socket.send(JSON.stringify(['CLOSED', message[1], 'blocked']));
  });
  expect(await readEvents([complete.url, closed.url], [{ kinds: [1] }])).toEqual([]);
  await expect(readComplete([complete.url, closed.url], [{ kinds: [1] }])).rejects.toThrow('list-unavailable');
  await expect(readComplete([], [{ kinds: [1] }])).rejects.toThrow('list-unavailable');
  const silent = relay(() => {});
  await expect(readComplete([complete.url, silent.url], [{ kinds: [1] }])).rejects.toThrow('list-unavailable');
});

test('strict reads return fresh results and do not remember prior reads or publishes', async () => {
  const event = note();
  let reads = 0;
  const remote = relay((socket, message) => {
    if (message[0] === 'EVENT') socket.send(JSON.stringify(['OK', message[1].id, true, '']));
    if (message[0] !== 'REQ') return;
    if (++reads === 1) socket.send(JSON.stringify(['EVENT', message[1], event]));
    socket.send(JSON.stringify(['EOSE', message[1]]));
  });
  const filters = [{ ids: [event.id] }];
  expect(await readComplete([remote.url], filters)).toEqual([event]);
  await publishFirst([remote.url], event);
  expect(await readComplete([remote.url], filters)).toEqual([]);
});

test('strict reads fail rather than accepting truncated results', async () => {
  const key = generateSecretKey();
  const events = Array.from({ length: 1001 }, (_, i) => note(1, [['i', String(i)]], key));
  const remote = relay((socket, message) => {
    if (message[0] !== 'REQ') return;
    for (const event of events) socket.send(JSON.stringify(['EVENT', message[1], event]));
    socket.send(JSON.stringify(['EOSE', message[1]]));
  });
  await expect(readComplete([remote.url], [{ kinds: [1] }])).rejects.toThrow('list-unavailable');
  const split = [events.slice(0, 500), events.slice(500)].map((events) => relay((socket, message) => {
    if (message[0] !== 'REQ') return;
    for (const event of events) socket.send(JSON.stringify(['EVENT', message[1], event]));
    socket.send(JSON.stringify(['EOSE', message[1]]));
  }));
  await expect(readComplete(split.map((r) => r.url), [{ kinds: [1] }])).rejects.toThrow('list-unavailable');
}, 20000);

test('validation precedes deduplication and preserves signed deletion evidence in results', async () => {
  const valid = note(), deletion = note(5, [['e', valid.id]]);
  const future = finalizeEvent({ kind: 1, content: '', tags: [],
    created_at: Math.floor(Date.now() / 1000) + 120 }, generateSecretKey());
  const remote = relay((socket, message) => {
    if (message[0] !== 'REQ') return;
    for (const event of [{ ...valid, sig: '0'.repeat(128) }, valid, valid, future, note(7), deletion])
      socket.send(JSON.stringify(['EVENT', message[1], event]));
    socket.send(JSON.stringify(['EOSE', message[1]]));
  });
  const filters = [{ kinds: [1, 5] }];
  expect(await readComplete([remote.url], filters)).toEqual([valid, deletion]);
  expect(await readEvents([remote.url], filters)).toEqual([valid, deletion]);
});

test('repository reader uses native requests and validates announcements', async () => {
  const event = note(30617, [['d', 'repo']]);
  const remote = relay((socket, message) => {
    if (message[0] !== 'REQ') return;
    for (const e of [{ ...event, sig: '0'.repeat(128) }, event])
      socket.send(JSON.stringify(['EVENT', message[1], e]));
    socket.send(JSON.stringify(['EOSE', message[1]]));
  });
  const repo = await readRepository({ relays: [remote.url] }, `30617:${event.pubkey}:repo`);
  expect(repo.event).toEqual(event);
});

test('untrusted loopback hints do not inherit permission from the shared pool', () => {
  const remote = relay(() => {});
  relayPool.relay(remote.url);
  expect(readRelays([], [remote.url])).toEqual([]);
  expect(readRelays([remote.url])).toEqual([remote.url]);
});

test('aborting a native read sends CLOSE without disrupting another consumer', async () => {
  const requested = Promise.withResolvers<void>(), closed = Promise.withResolvers<void>();
  const other = Promise.withResolvers<() => void>();
  const remote = relay((socket, message) => {
    if (message[0] === 'CLOSE') closed.resolve();
    if (message[0] !== 'REQ') return;
    if (message[2].kinds.includes(7)) other.resolve(() => socket.send(JSON.stringify(['EOSE', message[1]])));
    else requested.resolve();
  });
  const controller = new AbortController();
  const filters = [{ kinds: [1] }];
  const reading = readEvents([remote.url], filters, controller.signal);
  const pending = readComplete([remote.url], [{ kinds: [7] }]);
  await requested.promise;
  const finish = await other.promise;
  controller.abort(new Error('cancelled'));
  await expect(reading).rejects.toThrow('cancelled');
  await closed.promise;
  finish();
  expect(await pending).toEqual([]);
  expect(remote.connections()).toBe(1);
  await expect(readComplete([remote.url], filters, controller.signal)).rejects.toThrow('cancelled');
});

test('publishing returns on first acceptance without cancelling remaining attempts', async () => {
  const event = note(), ready = Promise.withResolvers<() => void>();
  const accepted = relay((socket, message) => {
    if (message[0] === 'EVENT') socket.send(JSON.stringify(['OK', message[1].id, true, '']));
  });
  const slow = relay((socket, message) => {
    if (message[0] === 'EVENT') ready.resolve(() => socket.send(JSON.stringify(['OK', message[1].id, false, 'rejected'])));
  });
  expect(await publishFirst([accepted.url, slow.url], event)).toEqual([accepted.url]);
  (await ready.promise)();
});

test('invalid signatures and pre-aborted publication never open a connection; rejections fail', async () => {
  const event = note();
  const remote = relay((socket, message) => {
    if (message[0] === 'EVENT') socket.send(JSON.stringify(['OK', message[1].id, false, 'blocked']));
  });
  await expect(publishFirst([remote.url], { ...event, sig: '0'.repeat(128) })).rejects.toThrow();
  const controller = new AbortController();
  controller.abort(new Error('cancelled'));
  await expect(publishFirst([remote.url], event, controller.signal)).rejects.toThrow('cancelled');
  expect(remote.connections()).toBe(0);
  await expect(publishFirst([remote.url], event)).rejects.toThrow('No relay acknowledged');
});
