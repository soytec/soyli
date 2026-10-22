import { EventStore } from 'applesauce-core';
import { createEventLoader, createEventLoaderForStore } from 'applesauce-loaders/loaders';
import { matchFilters, type Filter } from 'nostr-tools';
import {
  EMPTY,
  catchError,
  throwError,
  Observable,
  Subject,
  Subscription,
  defer,
  firstValueFrom,
  map,
  takeUntil,
  toArray,
} from 'rxjs';
import {
  DiagnosticError,
  diagnose,
  formatDiagnostic,
  redactDiagnostic,
} from '../../diagnostics/src';
import { verifiedEvent, type SignedEvent } from '../../protocol/src';
import type { PlaybackReadPool } from './playback';
import { readRelayUrl } from './relay-policy';

type Pointer = Parameters<NonNullable<EventStore['eventLoader']>>[0];
export type OutboxStoreOptions = {
  maxEvents?: number;
  maxBytes?: number;
  ttlMs?: number;
  timeoutMs?: number;
  now?: () => number;
};

/** Account-scoped raw transport cache. Cache presence never proves relay coverage. */
export class OutboxEventStore {
  readonly store: EventStore;
  private readonly changes = new Subject<SignedEvent>();
  readonly changes$ = this.changes.asObservable();
  private readonly stopped = new Subject<void>();
  private readonly scope = new Subscription();
  private readonly entries = new Map<
    string,
    { event: SignedEvent; expires: number; bytes: number; relays: Set<string> }
  >();
  private request: (
    urls: string[],
    filters: Filter[],
    timeoutMs?: number,
    completed?: () => void,
    failure?: (error: unknown, targets: string[]) => void,
  ) => Observable<SignedEvent>;
  private bytes = 0;
  private closed = false;
  private readonly now: () => number;
  private readonly maxEvents: number;
  private readonly maxBytes: number;
  private readonly ttlMs: number;
  private readonly timeoutMs: number;

  constructor(
    pool: PlaybackReadPool,
    private readonly relays: string[],
    options: OutboxStoreOptions = {},
  ) {
    this.now = options.now ?? Date.now;
    this.maxEvents = options.maxEvents ?? 1024;
    this.maxBytes = options.maxBytes ?? 16 * 1024 * 1024;
    this.ttlMs = options.ttlMs ?? 60_000;
    this.timeoutMs = options.timeoutMs ?? 2000;
    if (
      [this.maxEvents, this.maxBytes, this.ttlMs, this.timeoutMs].some(
        (n) => !Number.isSafeInteger(n) || n < 1,
      )
    )
      throw new Error('Invalid OUTBOX cache bounds');
    this.store = new EventStore({
      keepDeleted: true,
      keepExpired: true,
      keepOldVersions: true,
      verifyEvent: (event) => {
        try {
          verifiedEvent(event);
          return true;
        } catch {
          return false;
        }
      },
      // OUTBOX exposes signed raw records, not a deletion-filtered projection.
      // Avoid the default deletion manager retaining unbounded tombstones.
      deleteManager: {
        deleted$: EMPTY,
        add: () => [],
        check: () => false,
        filter: (events) => events,
      },
    });
    this.request = (
      urls: string[],
      filters: Filter[],
      timeoutMs = this.timeoutMs,
      completed?: () => void,
      failure?: (error: unknown, targets: string[]) => void,
    ) =>
      new Observable<SignedEvent>((observer) => {
        if (this.closed) {
          observer.complete();
          return;
        }
        let allowed: string[];
        try {
          allowed = [...new Set(urls.map((url) => readRelayUrl(url, this.relays, true)))];
          if (allowed.length > 8) throw new Error('OUTBOX loader relay quota exceeded');
        } catch (error) {
          observer.error(error);
          return;
        }
        if (!allowed.length) {
          observer.complete();
          return;
        }
        const group = new Subscription();
        this.scope.add(group);
        const ended = new Set<string>();
        const reasons: Error[] = [];
        let failed = false,
          count = 0;
        const timer = setTimeout(
          () => observer.error(new Error('OUTBOX event load timed out')),
          timeoutMs,
        );
        group.add(() => clearTimeout(timer));
        group.add(
          pool.req(allowed, filters, { live: false, timeoutMs }).subscribe({
            next: (message) => {
              if (!allowed.includes(message.from)) return;
              if (
                message.type === 'EOSE' ||
                message.type === 'CLOSED' ||
                message.type === 'ERROR'
              ) {
                failed ||= message.type === 'CLOSED' || message.type === 'ERROR';
                if (message.type === 'ERROR' && reasons.length < 8)
                  reasons.push(
                    new DiagnosticError('OUTBOX_RELAY_FAILED', 'Relay request failed.', {
                      target: message.from,
                      cause: (message as { error?: unknown }).error,
                    }),
                  );
                if (message.type === 'CLOSED' && reasons.length < 8)
                  reasons.push(
                    new Error(
                      `Relay ${redactDiagnostic(message.from, 300)} closed: ${redactDiagnostic(message.reason ?? 'no relay reason supplied', 512)}`,
                    ),
                  );
                if ((message.type === 'ERROR' || message.type === 'CLOSED') && reasons.length)
                  failure?.(reasons[reasons.length - 1], [message.from]);
                ended.add(message.from);
                if (ended.size === allowed.length) {
                  if (failed)
                    observer.error(
                      new AggregateError(
                        reasons,
                        'OUTBOX event load relay closed before completion',
                      ),
                    );
                  else {
                    completed?.();
                    observer.complete();
                  }
                }
              } else if (message.type === 'EVENT') {
                try {
                  const event = verifiedEvent(message.event);
                  if (!matchFilters(filters, event)) return;
                  const stored = this.ingest(event, message.from);
                  if (stored) observer.next(stored);
                  if (++count >= 2000)
                    observer.error(new Error('OUTBOX event load quota exceeded'));
                } catch {
                  /* Untrusted relay events are discarded before store insertion. */
                }
              }
            },
            error: (error) => observer.error(error),
            complete: () => {
              if (ended.size !== allowed.length)
                observer.error(new Error('OUTBOX event load ended before relay EOSE'));
              else observer.complete();
            },
          }),
        );
        return () => {
          group.unsubscribe();
          this.scope.remove(group);
        };
      }).pipe(
        catchError((error) => {
          failure?.(error, urls);
          return throwError(() => error);
        }),
      );
    createEventLoaderForStore(this.store, this.request, {
      extraRelays: relays.map((url) => readRelayUrl(url, relays, true)),
      lookupRelays: [],
      cacheRequest: async (filters) => this.cached(filters).map((event) => verifiedEvent(event)),
      followRelayHints: false,
      bufferTime: 1,
      bufferSize: 64,
    });
  }

  ingest(input: unknown, fromRelay?: string): SignedEvent | undefined {
    if (this.closed) return;
    let event: SignedEvent;
    try {
      event = verifiedEvent(input);
      if (event.created_at > this.now() / 1000 + 600) return;
      if (fromRelay) fromRelay = readRelayUrl(fromRelay, this.relays, true);
    } catch {
      return;
    }
    this.prune();
    const bytes = new TextEncoder().encode(JSON.stringify(event)).length;
    if (bytes > this.maxBytes) return;
    const previous = this.entries.get(event.id);
    const observed = previous?.relays ?? new Set<string>();
    if (fromRelay && observed.size < 8) observed.add(fromRelay);
    if (previous) this.bytes -= previous.bytes;
    this.entries.delete(event.id);
    this.entries.set(event.id, {
      event,
      expires: this.now() + this.ttlMs,
      bytes,
      relays: observed,
    });
    this.bytes += bytes;
    this.store.add(
      verifiedEvent(event),
      fromRelay && observed.has(fromRelay) ? fromRelay : undefined,
    );
    this.prune();
    this.changes.next(event);
    return event;
  }

  /** Advisory raw records, including kind 5 and superseded replaceable versions. */
  cached(filters: Filter[]): SignedEvent[] {
    this.prune();
    return [...this.entries.values()]
      .map(({ event }) => event)
      .filter((event) => matchFilters(filters, event))
      .sort((a, b) => b.created_at - a.created_at || a.id.localeCompare(b.id));
  }

  /** Host-only observation metadata. Disclosure into sidecars requires separate policy. */
  observedRelays(id: string): string[] {
    this.prune();
    return [...(this.entries.get(id)?.relays ?? [])];
  }

  loadEvent(pointer: Pointer): Observable<SignedEvent> {
    return defer(() => {
      if (this.closed) return EMPTY;
      this.prune();
      // Public hints are deliberately disabled: only host configured relays are contacted.
      return this.store.eventLoader!(pointer) as Observable<SignedEvent>;
    }).pipe(
      map((event) => verifiedEvent(event)),
      takeUntil(this.stopped),
    );
  }

  /** Network ID loader with host-owned coverage, using the already resolved relay plan.
   * The SDK intentionally swallows upstream errors while trying alternatives; only
   * explicit EOSE from every selected relay makes this result complete.
   */
  async loadEventWithCoverage(
    id: string,
    trustedRelays: string[],
    timeoutMs: number,
    signal?: AbortSignal,
  ): Promise<{ events: SignedEvent[]; incomplete: boolean; error?: string }> {
    if (this.closed || signal?.aborted) return { events: [], incomplete: true };
    if (!/^[a-f0-9]{64}$/.test(id) || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1)
      throw new Error('Invalid OUTBOX event load');
    const urls = [...new Set(trustedRelays.map((url) => readRelayUrl(url, this.relays, true)))];
    if (urls.length > 8) throw new Error('OUTBOX loader relay quota exceeded');
    let incomplete = true;
    const failures: string[] = [];
    const recordFailure = (cause: unknown, targets: string[]) => {
      if (failures.length >= 4) return;
      failures.push(
        formatDiagnostic(
          diagnose(
            new DiagnosticError('OUTBOX_READ_FAILED', 'OUTBOX getEvent did not complete.', {
              operation: 'outbox.getEvent',
              target: targets.join(', '),
              cause,
              recovery: 'Check the selected relay availability or access policy and retry.',
            }),
          ),
        ),
      );
    };
    const loader = createEventLoader(
      (relays, filters) =>
        this.request(
          relays,
          filters,
          timeoutMs,
          () => {
            incomplete = false;
          },
          recordFailure,
        ),
      {
        eventStore: this.store,
        extraRelays: urls,
        followRelayHints: false,
        bufferTime: 1,
        bufferSize: 64,
      },
    );
    const abort = () => {
      recordFailure(new Error('Event load cancelled.'), urls);
      loader.stop();
    };
    signal?.addEventListener('abort', abort, { once: true });
    const timer = setTimeout(() => {
      recordFailure(
        new Error('Event load deadline exceeded before every relay reached EOSE.'),
        urls,
      );
      loader.stop();
    }, timeoutMs);
    try {
      const events = await firstValueFrom(
        loader({ id }).pipe(
          map((event) => verifiedEvent(event)),
          takeUntil(this.stopped),
          toArray(),
        ),
      );
      // A cached signed ID is useful after transport failure, but never repairs coverage.
      if (!events.length) events.push(...this.cached([{ ids: [id] }]));
      const partial = incomplete || this.closed || !!signal?.aborted;
      if (partial && !failures.length)
        recordFailure(
          new Error(
            this.closed
              ? 'Player closed during event load.'
              : 'Selected relays did not complete event load.',
          ),
          urls,
        );
      return {
        events,
        incomplete: partial,
        ...(partial ? { error: redactDiagnostic(failures.join('\n'), 4000) } : {}),
      };
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
      loader.stop();
    }
  }

  private remove(id: string) {
    const entry = this.entries.get(id);
    if (!entry) return;
    this.bytes -= entry.bytes;
    this.entries.delete(id);
    this.store.remove(id);
  }
  private prune() {
    for (const [id, entry] of this.entries) if (entry.expires <= this.now()) this.remove(id);
    while (this.entries.size > this.maxEvents || this.bytes > this.maxBytes)
      this.remove(this.entries.keys().next().value!);
  }
  close() {
    if (this.closed) return;
    this.closed = true;
    this.stopped.next();
    this.stopped.complete();
    this.scope.unsubscribe();
    for (const id of this.entries.keys()) this.remove(id);
    this.store.dispose();
    this.changes.complete();
  }
}
