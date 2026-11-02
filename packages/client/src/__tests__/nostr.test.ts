import { afterEach, expect, test } from 'bun:test';
import type { ServerWebSocket } from 'bun';
import { finalizeEvent, generateSecretKey } from 'nostr-tools';
import {
  cachedEvents, deletionEvents, disconnectRelays, eventStore, observeQuery,
  publishEvent, queryAvailable, queryEvent, queryEvents, seedEvents,
} from '../nostr';

const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup();
  disconnectRelays();
});

function relay(handle: (socket: ServerWebSocket<undefined>, message: any[]) => void) {
  let connections = 0;
  const server = Bun.serve<undefined>({
    hostname: '127.0.0.1',
    port: 0,
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

function request(relays: string[]) {
  const controller = new AbortController();
  cleanups.push(() => controller.abort());
  return { relays, signal: controller.signal };
}

function note(kind = 1, tags: string[][] = []) {
  return finalizeEvent(
    { kind, content: '', tags, created_at: Math.floor(Date.now() / 1000) },
    generateSecretKey(),
  );
}

test('seeded events share the exported store and cached exact-ID reads need no relay', async () => {
  const event = note();
  seedEvents([{ ...event, sig: '0'.repeat(128) }]);
  expect(eventStore.getEvent(event.id)).toBeUndefined();
  seedEvents([event], true);
  expect(await queryEvent(event.id, [1], { relays: [] })).toEqual(event);
  expect(cachedEvents([{ ids: [event.id] }])).toEqual([event]);
  const controller = new AbortController();
  controller.abort();
  expect(() => queryEvent(event.id, [1], { relays: [], signal: controller.signal })).toThrow();
});

test('queries normalize relay URLs and reuse one connection across reads and publishes', async () => {
  const event = note();
  let requests = 0;
  const remote = relay((socket, message) => {
    if (message[0] === 'REQ') {
      requests++;
      socket.send(JSON.stringify(['EVENT', message[1], event]));
      socket.send(JSON.stringify(['EOSE', message[1]]));
    } else if (message[0] === 'EVENT') {
      socket.send(JSON.stringify(['OK', message[1].id, true, '']));
    }
  });
  const options = request([remote.url, remote.url.slice(0, -1)]);
  expect(await queryEvents([{ kinds: [1] }], { ...options, requireComplete: true })).toEqual([event]);
  expect(await queryEvents([{ kinds: [1] }], options)).toEqual([event]);
  expect(await publishEvent(event, options)).toEqual([remote.url]);
  expect(requests).toBe(2);
  expect(remote.connections()).toBe(1);
});

test('strict reads reject a CLOSED relay even when another relay reaches EOSE', async () => {
  const complete = relay((socket, message) => {
    if (message[0] === 'REQ') socket.send(JSON.stringify(['EOSE', message[1]]));
  });
  const closed = relay((socket, message) => {
    if (message[0] === 'REQ') socket.send(JSON.stringify(['CLOSED', message[1], 'blocked']));
  });
  const options = request([complete.url, closed.url]);
  expect(await queryEvents([{ kinds: [1] }], options)).toEqual([]);
  await expect(queryEvents([{ kinds: [1] }], { ...options, requireComplete: true }))
    .rejects.toThrow('list-unavailable');
});

test('fresh strict reads do not substitute shared cache contents for relay results', async () => {
  const event = note();
  seedEvents([event]);
  const remote = relay((socket, message) => {
    if (message[0] === 'REQ') socket.send(JSON.stringify(['EOSE', message[1]]));
  });
  expect(await queryEvents([{ ids: [event.id] }], {
    ...request([remote.url]), requireComplete: true,
  })).toEqual([]);
  expect(eventStore.getEvent(event.id)).toEqual(event);
});

test('strict reads reject truncated results even if the relay sends EOSE', async () => {
  const key = generateSecretKey();
  const events = Array.from({ length: 1001 }, (_, index) => finalizeEvent({
    kind: 1, content: String(index), tags: [], created_at: Math.floor(Date.now() / 1000),
  }, key));
  const remote = relay((socket, message) => {
    if (message[0] !== 'REQ') return;
    for (const event of events) socket.send(JSON.stringify(['EVENT', message[1], event]));
    socket.send(JSON.stringify(['EOSE', message[1]]));
  });
  await expect(queryEvents([{ kinds: [1] }], {
    ...request([remote.url]), requireComplete: true,
  })).rejects.toThrow('list-unavailable');
}, 20000);

test('unconfigured loopback hints cannot inherit permission from the shared pool', async () => {
  const remote = relay((socket, message) => {
    if (message[0] === 'REQ') socket.send(JSON.stringify(['EOSE', message[1]]));
  });
  await queryEvents([{ kinds: [1] }], request([remote.url]));
  await expect(queryEvents([{ kinds: [1] }], {
    relays: [], hints: [remote.url],
  })).rejects.toThrow('No relay completed');
  expect(remote.connections()).toBe(1);
});

test('cancelling one consumer leaves concurrent reads, shared cache and transport intact', async () => {
  const event = note();
  const firstReady = Promise.withResolvers<void>();
  const secondReady = Promise.withResolvers<() => void>();
  const remote = relay((socket, message) => {
    if (message[0] === 'EVENT')
      socket.send(JSON.stringify(['OK', message[1].id, true, '']));
    if (message[0] !== 'REQ') return;
    if (message[2].kinds.includes(7)) {
      secondReady.resolve(() => socket.send(JSON.stringify(['EOSE', message[1]])));
    } else {
      socket.send(JSON.stringify(['EVENT', message[1], event]));
      firstReady.resolve();
    }
  });
  const controller = new AbortController();
  const first = queryEvents([{ kinds: [1] }], { relays: [remote.url], signal: controller.signal });
  const second = queryEvents([{ kinds: [7] }], request([remote.url]));
  await firstReady.promise;
  const finish = await secondReady.promise;
  controller.abort(new Error('consumer closed'));
  await expect(first).rejects.toThrow('consumer closed');
  finish();
  expect(await second).toEqual([]);
  expect(await publishEvent(event, request([remote.url]))).toEqual([remote.url]);
  expect(eventStore.getEvent(event.id)).toEqual(event);
  expect(remote.connections()).toBe(1);
});

test('network ingestion rejects invalid, future and nonmatching events but retains signed deletions', async () => {
  const valid = note();
  const deletion = note(5, [['e', valid.id]]);
  const future = finalizeEvent(
    { kind: 1, content: '', tags: [], created_at: Math.floor(Date.now() / 1000) + 120 },
    generateSecretKey(),
  );
  const remote = relay((socket, message) => {
    if (message[0] !== 'REQ') return;
    for (const event of [valid, valid, { ...valid, sig: '0'.repeat(128) }, future, note(7), deletion])
      socket.send(JSON.stringify(['EVENT', message[1], event]));
    socket.send(JSON.stringify(['EOSE', message[1]]));
  });
  const deletions: string[] = [];
  const subscription = deletionEvents.subscribe((event) => deletions.push(event.id));
  cleanups.push(() => subscription.unsubscribe());
  expect(await queryEvents([{ kinds: [1, 5] }], request([remote.url]))).toEqual([valid, deletion]);
  expect(cachedEvents([{ ids: [deletion.id], kinds: [5] }])).toEqual([deletion]);
  expect(deletions).toEqual([deletion.id]);
});

test('partial reads return on first EOSE while slower relays still populate the store', async () => {
  const event = note();
  const ready = Promise.withResolvers<() => void>();
  const empty = relay((socket, message) => {
    if (message[0] === 'REQ') socket.send(JSON.stringify(['EOSE', message[1]]));
  });
  const slow = relay((socket, message) => {
    if (message[0] !== 'REQ') return;
    ready.resolve(() => {
      socket.send(JSON.stringify(['EVENT', message[1], event]));
      socket.send(JSON.stringify(['EOSE', message[1]]));
    });
  });
  expect(await queryAvailable([{ kinds: [1] }], request([empty.url, slow.url]))).toEqual([]);
  const loaded = Promise.withResolvers<void>();
  const subscription = eventStore.insert$.subscribe((inserted) => {
    if (inserted.id === event.id) loaded.resolve();
  });
  cleanups.push(() => subscription.unsubscribe());
  (await ready.promise)();
  await loaded.promise;
  expect(eventStore.getEvent(event.id)).toEqual(event);
});

test('exact-ID reads wait past an empty EOSE', async () => {
  const event = note();
  const empty = relay((socket, message) => {
    if (message[0] === 'REQ') socket.send(JSON.stringify(['EOSE', message[1]]));
  });
  const ready = Promise.withResolvers<() => void>();
  const slow = relay((socket, message) => {
    if (message[0] === 'REQ') ready.resolve(() => {
      socket.send(JSON.stringify(['EVENT', message[1], event]));
    });
  });
  const pending = queryEvent(event.id, [1], request([empty.url, slow.url]));
  (await ready.promise)();
  expect(await pending).toEqual(event);
});

test('publishing returns on first acceptance without cancelling remaining attempts', async () => {
  const event = note();
  const ready = Promise.withResolvers<() => void>();
  const accepted = relay((socket, message) => {
    if (message[0] === 'EVENT') socket.send(JSON.stringify(['OK', message[1].id, true, '']));
  });
  const slow = relay((socket, message) => {
    if (message[0] === 'EVENT') ready.resolve(() => {
      socket.send(JSON.stringify(['OK', message[1].id, false, 'rejected']));
    });
  });
  expect(await publishEvent(event, request([accepted.url, slow.url]))).toEqual([accepted.url]);
  expect(eventStore.getEvent(event.id)).toEqual(event);
  (await ready.promise)();
});

test('aborting a read unsubscribes the relay request', async () => {
  const requested = Promise.withResolvers<void>();
  const closed = Promise.withResolvers<void>();
  const remote = relay((_socket, message) => {
    if (message[0] === 'REQ') requested.resolve();
    if (message[0] === 'CLOSE') closed.resolve();
  });
  const controller = new AbortController();
  const reading = queryEvents([{ kinds: [1] }], { relays: [remote.url], signal: controller.signal });
  await requested.promise;
  controller.abort(new Error('cancelled'));
  await expect(reading).rejects.toThrow('cancelled');
  await closed.promise;
});

test('unsubscribing a projection cancels only its request and keeps the shared store usable', async () => {
  const event = note();
  seedEvents([event]);
  const requested = Promise.withResolvers<void>();
  const closed = Promise.withResolvers<void>();
  const remote = relay((_socket, message) => {
    if (message[0] === 'REQ') requested.resolve();
    if (message[0] === 'CLOSE') closed.resolve();
  });
  const values: string[][] = [];
  const subscription = observeQuery([{ ids: [event.id] }], request([remote.url]))
    .subscribe((events) => values.push(events.map((event) => event.id)));
  cleanups.push(() => subscription.unsubscribe());
  await requested.promise;
  subscription.unsubscribe();
  await closed.promise;
  expect(values[0]).toEqual([event.id]);
  expect(await queryEvent(event.id, [1], { relays: [] })).toEqual(event);
});

test('publish failures and denied permissions do not seed the event', async () => {
  const event = note();
  const remote = relay((socket, message) => {
    if (message[0] === 'EVENT')
      socket.send(JSON.stringify(['OK', message[1].id, false, 'blocked']));
  });
  await expect(publishEvent(event, { relays: [remote.url], allowed: () => false }))
    .rejects.toThrow('This action is unavailable');
  expect(remote.connections()).toBe(0);
  await expect(publishEvent(event, request([remote.url]))).rejects.toThrow('No relay acknowledged');
  expect(eventStore.getEvent(event.id)).toBeUndefined();
});
