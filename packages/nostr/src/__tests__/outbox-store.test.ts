import { expect, test } from 'bun:test';
import { finalizeEvent, generateSecretKey } from 'nostr-tools';
import { Observable, Subject } from 'rxjs';
import { OutboxEventStore } from '../outbox-store';
import type { PlaybackReadPool, ReadMessage } from '../playback';

const relay = 'wss://relay.example.com/';
const event = finalizeEvent(
  { kind: 1, content: 'loader test', tags: [], created_at: Math.floor(Date.now() / 1000) },
  generateSecretKey(),
);

function fixture() {
  const wire = new Subject<ReadMessage>();
  let requests = 0, active = 0;
  let started!: () => void;
  const ready = new Promise<void>((resolve) => { started = resolve; });
  const pool: PlaybackReadPool = {
    req: () => new Observable((observer) => {
      requests++;
      active++;
      const sub = wire.subscribe(observer);
      started();
      return () => { active--; sub.unsubscribe(); };
    }),
    close() {},
  };
  const store = new OutboxEventStore(pool, [relay]);
  return { store, wire, ready, requests: () => requests, active: () => active };
}

test('identical concurrent reads share transport and keep independent result arrays', async () => {
  const f = fixture();
  try {
    const a = f.store.loadEventWithCoverage(event.id, [relay], 1000);
    const b = f.store.loadEventWithCoverage(event.id, [relay, relay], 1000);
    await f.ready;
    expect(f.requests()).toBe(1);
    f.wire.next({ type: 'EVENT', from: relay, event });
    f.wire.next({ type: 'EOSE', from: relay });
    const [first, second] = await Promise.all([a, b]);
    expect(first.incomplete).toBe(false);
    expect(second.incomplete).toBe(false);
    expect(first.events.map((e) => e.id)).toEqual([event.id]);
    first.events.pop();
    expect(second.events).toHaveLength(1);
    expect(f.active()).toBe(0);
  } finally { f.store.close(); }
});

test('cancelling one caller does not cancel another caller', async () => {
  const f = fixture();
  try {
    const controller = new AbortController();
    const a = f.store.loadEventWithCoverage(event.id, [relay], 1000, controller.signal);
    const b = f.store.loadEventWithCoverage(event.id, [relay], 1000);
    await f.ready;
    controller.abort();
    expect((await a).incomplete).toBe(true);
    expect(f.active()).toBe(1);
    f.wire.next({ type: 'EOSE', from: relay });
    expect((await b).incomplete).toBe(false);
    expect(f.active()).toBe(0);
  } finally { f.store.close(); }
});

test('last caller cancellation tears down transport and permits a fresh request', async () => {
  const f = fixture();
  try {
    const controller = new AbortController();
    const pending = f.store.loadEventWithCoverage(event.id, [relay], 1000, controller.signal);
    await f.ready;
    controller.abort();
    await pending;
    expect(f.active()).toBe(0);
    const again = f.store.loadEventWithCoverage(event.id, [relay], 1000);
    f.store.close();
    expect((await again).incomplete).toBe(true);
    expect(f.active()).toBe(0);
  } finally { f.store.close(); }
});

test('cached events never turn failed relay coverage into a complete read', async () => {
  const f = fixture();
  try {
    f.store.ingest(event);
    const pending = f.store.loadEventWithCoverage(event.id, [relay], 1000);
    await f.ready;
    f.wire.next({ type: 'CLOSED', from: relay, reason: 'refused' });
    const result = await pending;
    expect(result.incomplete).toBe(true);
    expect(result.events.map((e) => e.id)).toEqual([event.id]);
    expect(result.error).toBeTruthy();
  } finally { f.store.close(); }
});

test('closing a store stops shared in-flight reads for every caller', async () => {
  const f = fixture();
  try {
    const a = f.store.loadEventWithCoverage(event.id, [relay], 1000);
    const b = f.store.loadEventWithCoverage(event.id, [relay], 1000);
    await f.ready;
    f.store.close();
    for (const result of await Promise.all([a, b])) expect(result.incomplete).toBe(true);
    expect(f.active()).toBe(0);
  } finally { f.store.close(); }
});

test('silent relay deadlines release shared transport without claiming coverage', async () => {
  const f = fixture();
  try {
    const a = f.store.loadEventWithCoverage(event.id, [relay], 30);
    const b = f.store.loadEventWithCoverage(event.id, [relay], 30);
    await f.ready;
    for (const result of await Promise.all([a, b])) {
      expect(result.incomplete).toBe(true);
      expect(result.error).toBeTruthy();
    }
    expect(f.requests()).toBe(1);
    expect(f.active()).toBe(0);
  } finally { f.store.close(); }
});
