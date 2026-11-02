import { afterEach, expect, test } from 'bun:test';
import type { ServerWebSocket } from 'bun';
import { finalizeEvent, generateSecretKey } from 'nostr-tools';
import { ProtocolClient } from '../nostr';

const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup();
});

function relay(handle: (socket: ServerWebSocket<undefined>, message: any[]) => void) {
  let connections = 0;
  const disconnected = Promise.withResolvers<void>();
  const server = Bun.serve<undefined>({
    hostname: '127.0.0.1',
    port: 0,
    fetch(request, server) {
      if (server.upgrade(request)) return;
      return new Response(null, { status: 400 });
    },
    websocket: {
      open() { connections++; },
      close() { disconnected.resolve(); },
      message(socket, message) { handle(socket, JSON.parse(String(message))); },
    },
  });
  cleanups.push(() => { server.stop(true); });
  return {
    url: `ws://127.0.0.1:${server.port}/`,
    connections: () => connections,
    disconnected: disconnected.promise,
  };
}

function client(urls: string[]) {
  const instance = new ProtocolClient(() => urls);
  cleanups.push(() => instance.close());
  return instance;
}

function note(kind = 1, tags: string[][] = []) {
  return finalizeEvent(
    { kind, content: '', tags, created_at: Math.floor(Date.now() / 1000) },
    generateSecretKey(),
  );
}

test('closing a client disposes its store and completes deletion observers once', async () => {
  const client = new ProtocolClient(() => []);
  let storeCompleted = 0, deletionsCompleted = 0;
  client.store.insert$.subscribe({ complete: () => storeCompleted++ });
  client.deletionEvents.subscribe({ complete: () => deletionsCompleted++ });
  client.close();
  client.close();
  expect(storeCompleted).toBe(1);
  expect(deletionsCompleted).toBe(1);
  await expect(client.query([{ kinds: [1] }])).rejects.toThrow();
  const event = finalizeEvent(
    { kind: 1, content: '', tags: [], created_at: 1 }, generateSecretKey(),
  );
  client.seed([event]);
  expect(client.cached([{ ids: [event.id] }])).toEqual([]);
  await expect(client.publish(event)).rejects.toThrow();
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
  const instance = client([remote.url, remote.url.slice(0, -1)]);
  expect(await instance.query([{ kinds: [1] }], [], undefined, undefined, true)).toEqual([event]);
  expect(await instance.query([{ kinds: [1] }])).toEqual([event]);
  expect(await instance.publish(event)).toEqual([remote.url]);
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
  const instance = client([complete.url, closed.url]);
  expect(await instance.query([{ kinds: [1] }])).toEqual([]);
  await expect(instance.query([{ kinds: [1] }], [], undefined, undefined, true))
    .rejects.toThrow('list-unavailable');
});

test('concurrent clients share transport and only the last close shuts it down', async () => {
  const event = note();
  const pending = Promise.withResolvers<() => void>();
  const remote = relay((socket, message) => {
    if (message[0] === 'EVENT')
      socket.send(JSON.stringify(['OK', message[1].id, true, '']));
    if (message[0] !== 'REQ') return;
    if (message[2].kinds.includes(7)) {
      pending.resolve(() => socket.send(JSON.stringify(['EOSE', message[1]])));
    } else {
      socket.send(JSON.stringify(['EVENT', message[1], event]));
      socket.send(JSON.stringify(['EOSE', message[1]]));
    }
  });
  const first = client([remote.url]);
  const second = client([remote.url]);
  expect(await Promise.all([
    first.query([{ kinds: [1] }]),
    second.query([{ kinds: [1] }]),
  ])).toEqual([[event], [event]]);
  expect(remote.connections()).toBe(1);

  const reading = second.query([{ kinds: [7] }]);
  const finish = await pending.promise;
  first.close();
  first.close();
  finish();
  expect(await reading).toEqual([]);
  expect(await second.publish(event)).toEqual([remote.url]);
  expect(remote.connections()).toBe(1);

  second.close();
  await remote.disconnected;
  const next = client([remote.url]);
  expect(await next.query([{ kinds: [1] }])).toEqual([event]);
  expect(remote.connections()).toBe(2);
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
  const instance = client([remote.url]);
  const deletions: string[] = [];
  instance.deletionEvents.subscribe((event) => deletions.push(event.id));
  expect(await instance.query([{ kinds: [1, 5] }])).toEqual([valid, deletion]);
  expect(instance.cached([{ kinds: [5] }])).toEqual([deletion]);
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
  const instance = client([empty.url, slow.url]);
  expect(await instance.queryAvailable([{ kinds: [1] }])).toEqual([]);
  const loaded = Promise.withResolvers<void>();
  instance.store.insert$.subscribe((inserted) => {
    if (inserted.id === event.id) loaded.resolve();
  });
  (await ready.promise)();
  await loaded.promise;
  expect(instance.store.getEvent(event.id)).toEqual(event);
});

test('exact-ID reads wait past an empty EOSE and closing cancels active reads', async () => {
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
  const instance = client([empty.url, slow.url]);
  const pending = instance.queryEvent(event.id, [1]);
  (await ready.promise)();
  expect(await pending).toEqual(event);
  const reading = instance.query([{ kinds: [1] }]);
  instance.close();
  await expect(reading).rejects.toThrow();
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
  const instance = client([accepted.url, slow.url]);
  expect(await instance.publish(event)).toEqual([accepted.url]);
  expect(instance.store.getEvent(event.id)).toEqual(event);
  (await ready.promise)();
});

test('aborting a read unsubscribes the relay request', async () => {
  const requested = Promise.withResolvers<void>();
  const closed = Promise.withResolvers<void>();
  const remote = relay((_socket, message) => {
    if (message[0] === 'REQ') requested.resolve();
    if (message[0] === 'CLOSE') closed.resolve();
  });
  const instance = client([remote.url]);
  const controller = new AbortController();
  const reading = instance.query([{ kinds: [1] }], [], controller.signal);
  await requested.promise;
  controller.abort(new Error('cancelled'));
  await expect(reading).rejects.toThrow('cancelled');
  await closed.promise;
});

test('publish failures do not seed the event', async () => {
  const event = note();
  const remote = relay((socket, message) => {
    if (message[0] === 'EVENT')
      socket.send(JSON.stringify(['OK', message[1].id, false, 'blocked']));
  });
  const instance = client([remote.url]);
  await expect(instance.publish(event)).rejects.toThrow('No relay acknowledged');
  expect(instance.store.getEvent(event.id)).toBeUndefined();
});
