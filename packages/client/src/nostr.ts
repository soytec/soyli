import { matchFilters, type Filter } from 'nostr-tools';
import { Observable, distinct, lastValueFrom, map, merge, mergeMap, pipe, takeUntil, toArray } from 'rxjs';
import { verifiedEvent, type SignedEvent } from '#protocol';
import { redactDiagnostic } from '#diagnostics';
import { relayPool } from './relay-pool';

/** Application input policy, composed with native Applesauce requests. No cache or transport adapter. */
function receiveEvents(filters: Filter[], signal?: AbortSignal) {
  return pipe(
    mergeMap((input: SignedEvent, index) => {
      if (index >= 8 * 1200) throw new Error('Relay response exceeds the event budget.');
      try {
        if (JSON.stringify(input).length > 70000) return [];
        const event = verifiedEvent(input);
        return event.created_at <= Date.now() / 1000 + 60 && matchFilters(filters, event) ? [event] : [];
      } catch {
        return [];
      }
    }),
    distinct((event) => event.id),
    map((event, index) => {
      if (index >= 1000) throw new Error('Relay response exceeds the event budget.');
      return event;
    }),
    takeUntil(new Observable<never>((subscriber) => {
      if (!signal) return;
      const abort = () => subscriber.error(signal.reason);
      if (signal.aborted) abort();
      else signal.addEventListener('abort', abort, { once: true });
      return () => signal.removeEventListener('abort', abort);
    })),
  );
}

/** Small Promise composition for native group requests; partial relay success is allowed. */
export function readEvents(relays: string[], filters: Filter[], signal?: AbortSignal) {
  // Deduplicate only after validation, so forged duplicates cannot hide valid events.
  return lastValueFrom(
    relayPool.request(relays, filters, { timeout: 3500, eventStore: null })
      .pipe(receiveEvents(filters, signal), toArray()),
  );
}

/** Mutation reads require EOSE from every relay, not group request's partial success. */
export async function readComplete(relays: string[], filters: Filter[], signal?: AbortSignal) {
  signal?.throwIfAborted();
  if (!relays.length) throw new Error('list-unavailable');
  try {
    return await lastValueFrom(
      merge(...relays.map((url) =>
        relayPool.relay(url).request(filters, { timeout: 3500, reconnect: false, resubscribe: false }),
      )).pipe(receiveEvents(filters, signal), toArray()),
    );
  } catch {
    signal?.throwIfAborted();
    throw new Error('list-unavailable');
  }
}

/** First acceptance wins; remaining native publish attempts continue with bounded timeouts. */
export async function publishFirst(relays: string[], input: SignedEvent, signal?: AbortSignal) {
  signal?.throwIfAborted();
  const event = verifiedEvent(input);
  try {
    const accepted = await Promise.any(relays.map(async (url) => {
      const result = await relayPool.relay(url).publish(event, { timeout: 6000, retries: false });
      if (!result.ok) throw new Error(result.message || 'rejected or timed out');
      return [result.from];
    }));
    signal?.throwIfAborted();
    return accepted;
  } catch (cause) {
    signal?.throwIfAborted();
    const failures = cause instanceof AggregateError ? cause.errors : [cause];
    throw new Error(
      `No relay acknowledged the event. Retry sends the same signed event. ${failures.map((error) => redactDiagnostic(String(error), 200)).join('; ')}`,
    );
  }
}
