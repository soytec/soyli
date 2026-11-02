import { EventStore } from 'applesauce-core';
import { markFromCache } from 'applesauce-core/helpers';
import { matchFilters, type Filter } from 'nostr-tools';
import {
  EMPTY,
  Observable,
  Subject,
  catchError,
  fromEvent,
  ignoreElements,
  lastValueFrom,
  shareReplay,
  take,
  takeUntil,
  takeWhile,
  tap,
  timer,
} from 'rxjs';
import { verifiedEvent, verifySignature, type SignedEvent } from '../../protocol/src';
import { readRelayUrl } from '../../nostr/src/relay-policy';
import { redactDiagnostic } from '../../diagnostics/src';
import { relayConnection } from './relay-pool';
export { relayPool, disconnectRelays } from './relay-pool';

/** One verified, signer-free cache per application runtime. */
export const eventStore = new EventStore({ verifyEvent: verifySignature });
const retained = new Map<string, number>();
let retainedBytes = 0;
// EventStore consumes kind 5; reducers still need the signed author and timestamp.
const deletions = new Map<string, SignedEvent>();
const deletionUpdates = new Subject<SignedEvent>();
export const deletionEvents = deletionUpdates.asObservable();

export type NostrOptions = {
  relays: string[];
  hints?: string[];
  signal?: AbortSignal;
};
export type QueryOptions = NostrOptions & {
  requireComplete?: boolean;
  onEvent?: (event: SignedEvent) => void;
  onRelayComplete?: () => void;
};

function relayUrls({ relays, hints = [] }: NostrOptions, hintsFirst = true) {
  const candidates = hintsFirst ? [...hints, ...relays] : [...relays, ...hints];
  const valid = candidates.flatMap((value) => {
    try {
      return [readRelayUrl(value, relays, true)];
    } catch {
      return [];
    }
  });
  return [...new Set(valid)].slice(0, 8);
}

function remember(event: SignedEvent) {
  eventStore.add(event);
  const newDeletion = event.kind === 5 && !deletions.has(event.id);
  if (event.kind === 5) deletions.set(event.id, event);
  if (!retained.has(event.id)) {
    const bytes = JSON.stringify(event).length * 2;
    retained.set(event.id, bytes);
    retainedBytes += bytes;
  }
  while (retained.size > 8000 || retainedBytes > 16 * 1024 ** 2) {
    const id = retained.keys().next().value!;
    retainedBytes -= retained.get(id)!;
    eventStore.remove(id);
    deletions.delete(id);
    retained.delete(id);
  }
  if (newDeletion) deletionUpdates.next(event);
}

/** Verify before ingestion, including kind 5 which bypasses the store's verifier. */
export function seedEvents(inputs: SignedEvent[], fromCache = false) {
  for (const input of inputs)
    try {
      const event = verifiedEvent(input);
      if (fromCache) markFromCache(event);
      remember(event);
    } catch {}
}

export function cachedEvents(filters: Filter[]) {
  return [
    ...eventStore.getByFilters(filters),
    ...[...deletions.values()].filter((event) => matchFilters(filters, event)),
  ];
}

/** A fresh relay read. Cached state never establishes completeness for a mutation. */
export async function queryEvents(filters: Filter[], options: QueryOptions) {
  const signal = options.signal ?? AbortSignal.timeout(10000);
  signal.throwIfAborted();
  const relays = relayUrls(options);
  const found = new Map<string, SignedEvent>();
  let completed = 0;
  let truncated = false;
  await Promise.all(relays.map(async (url) => {
    const connection = relayConnection(url);
    try {
      signal.throwIfAborted();
      // Raw lifecycle messages are intentional: request() permits partial success.
      await lastValueFrom(connection.relay.req(filters).pipe(
        takeWhile((message) => message.type !== 'EOSE' && message.type !== 'CLOSED', true),
        take(1200),
        takeUntil(timer(3500)),
        takeUntil(fromEvent(signal, 'abort')),
        tap((message) => {
          if (message.type === 'EOSE') {
            completed++;
            options.onRelayComplete?.();
          }
          if (message.type !== 'EVENT') return;
          try {
            if (JSON.stringify(message.event).length > 70000) return;
            const event = verifiedEvent(message.event);
            if (event.created_at > Date.now() / 1000 + 60 || !matchFilters(filters, event)) return;
            if (found.size >= 1000 && !found.has(event.id)) {
              truncated = true;
              return;
            }
            const fresh = !found.has(event.id);
            found.set(event.id, event);
            remember(event);
            if (fresh) options.onEvent?.(event);
          } catch {}
        }),
        catchError(() => EMPTY),
        ignoreElements(),
      ), { defaultValue: undefined });
    } finally {
      connection.release();
    }
  }));
  signal.throwIfAborted();
  if (options.requireComplete && (!relays.length || completed !== relays.length || truncated))
    throw new Error('list-unavailable');
  if (!completed && !found.size)
    throw new Error('No relay completed the query. Check your relay settings or retry.');
  return [...found.values()];
}

/** Partial UI read; other relays keep populating the shared store until cancelled. */
export function queryAvailable(filters: Filter[], options: NostrOptions) {
  return new Promise<SignedEvent[]>((resolve, reject) => {
    const found = new Map<string, SignedEvent>();
    const finish = () => resolve([...found.values()]);
    void queryEvents(filters, {
      ...options,
      onEvent: (event) => found.set(event.id, event),
      onRelayComplete: finish,
    }).then(finish, reject);
  });
}

/** Empty EOSEs must not beat a later matching event from another relay. */
export function queryEvent(id: string, kinds: number[], options: NostrOptions) {
  options.signal?.throwIfAborted();
  if (!/^[a-f0-9]{64}$/.test(id)) throw new Error('Expected an exact event id.');
  const cached = eventStore.getEvent(id);
  if (cached && kinds.includes(cached.kind) && cached.created_at <= Date.now() / 1000 + 60)
    return Promise.resolve(cached);
  return new Promise<SignedEvent | undefined>((resolve, reject) => {
    const controller = new AbortController();
    const finish = (event?: SignedEvent) => {
      resolve(event);
      controller.abort();
    };
    void queryEvents([{ ids: [id], kinds, limit: 1 }], {
      ...options,
      signal: options.signal
        ? AbortSignal.any([options.signal, controller.signal])
        : controller.signal,
      onEvent: finish,
    }).then(() => finish(), reject);
  });
}

/** Cache-first projection during a bounded relay refresh, not a live subscription. */
export function observeQuery(filters: Filter[], options: NostrOptions) {
  return new Observable<SignedEvent[]>((observer) => {
    const controller = new AbortController();
    const signal = options.signal
      ? AbortSignal.any([options.signal, controller.signal])
      : controller.signal;
    const emit = () => observer.next(cachedEvents(filters));
    const updates = eventStore.timeline(filters).subscribe({ next: emit });
    const deletionSubscription = deletionUpdates.subscribe((event) => {
      if (matchFilters(filters, event)) emit();
    });
    void queryEvents(filters, { ...options, signal }).then(
      () => observer.complete(),
      (error) => {
        if (!controller.signal.aborted) observer.error(error);
      },
    );
    return () => {
      controller.abort();
      updates.unsubscribe();
      deletionSubscription.unsubscribe();
    };
  }).pipe(shareReplay({ bufferSize: 1, refCount: true }));
}

export async function publishEvent(
  input: SignedEvent,
  options: NostrOptions & { allowed?: (event: SignedEvent) => boolean },
) {
  options.signal?.throwIfAborted();
  const event = verifiedEvent(input);
  if (options.allowed && !options.allowed(event)) throw new Error('This action is unavailable here.');
  const failures: { from: string; message: string }[] = [];
  // First acceptance finishes the action; remaining bounded attempts keep running.
  const attempts = relayUrls(options, false).map(async (url) => {
    let connection: ReturnType<typeof relayConnection> | undefined;
    try {
      options.signal?.throwIfAborted();
      connection = relayConnection(url);
      const result = await connection.relay.publish(event, { timeout: 6000, retries: false });
      if (result.ok) return [result.from];
      throw new Error(result.message || 'rejected or timed out');
    } catch (error) {
      failures.push({
        from: url,
        message: redactDiagnostic(error instanceof Error ? error.message : 'Transport failed', 200),
      });
      throw error;
    } finally {
      connection?.release();
    }
  });
  try {
    const accepted = await Promise.any(attempts);
    options.signal?.throwIfAborted();
    seedEvents([event]);
    return accepted;
  } catch {
    options.signal?.throwIfAborted();
    throw new Error(
      `No relay acknowledged the event. Retry sends the same signed event. ${failures.map((r) => `${redactDiagnostic(r.from, 200)}: ${r.message}`).join('; ')}`,
    );
  }
}
