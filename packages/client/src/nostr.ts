import { EventStore } from 'applesauce-core';
import { markFromCache } from 'applesauce-core/helpers';
import { RelayPool } from 'applesauce-relay';
import { matchFilters, type Filter } from 'nostr-tools';
import { Observable, Subject, shareReplay, take, takeUntil, takeWhile, timer } from 'rxjs';
import { verifiedEvent, verifySignature, type SignedEvent } from '../../protocol/src';
import { readRelayUrl } from '../../nostr/src/relay-policy';
import { redactDiagnostic } from '../../diagnostics/src';

/** A browser-owned, signer-free store; all wire events are verified before ingestion. */
export class ProtocolClient {
  readonly store = new EventStore({ verifyEvent: verifySignature });
  private retained = new Map<string, number>();
  // EventStore consumes kind 5 into its deletion manager instead of storing the event.
  // Our reducers need the signed request's timestamp/author, within the same byte budget.
  private deletions = new Map<string, SignedEvent>();
  private deletionUpdates = new Subject<SignedEvent>();
  /** Verified kind-5 events are consumed by EventStore, so cache them separately. */
  readonly deletionEvents = this.deletionUpdates.asObservable();
  private retainedBytes = 0;
  private connections = new Map<
    string,
    { pool: RelayPool; users: number; timer?: ReturnType<typeof setTimeout> }
  >();
  private connection(url: string) {
    let entry = this.connections.get(url);
    if (!entry) {
      if (this.connections.size >= 24) {
        const idle = [...this.connections].find(([, e]) => !e.users);
        if (!idle) throw new Error('Relay connections are busy. Retry shortly.');
        clearTimeout(idle[1].timer);
        idle[1].pool.close();
        this.connections.delete(idle[0]);
      }
      entry = { pool: new RelayPool(), users: 0 };
      this.connections.set(url, entry);
    }
    clearTimeout(entry.timer);
    entry.users++;
    const current = entry;
    return {
      pool: current.pool,
      release: () => {
        if (--current.users || this.connections.get(url) !== current) return;
        current.timer = setTimeout(() => {
          current.pool.close();
          this.connections.delete(url);
        }, 10000);
        (current.timer as any).unref?.();
      },
    };
  }
  close() {
    for (const entry of this.connections.values()) {
      clearTimeout(entry.timer);
      entry.pool.close();
    }
    this.connections.clear();
  }
  private remember(event: SignedEvent) {
    this.store.add(event);
    const newDeletion = event.kind === 5 && !this.deletions.has(event.id);
    if (event.kind === 5) this.deletions.set(event.id, event);
    if (!this.retained.has(event.id)) {
      const bytes = JSON.stringify(event).length * 2;
      this.retained.set(event.id, bytes);
      this.retainedBytes += bytes;
    }
    while (this.retained.size > 8000 || this.retainedBytes > 16 * 1024 ** 2) {
      const id = this.retained.keys().next().value!;
      this.retainedBytes -= this.retained.get(id)!;
      this.store.remove(id);
      this.deletions.delete(id);
      this.retained.delete(id);
    }
    if (newDeletion) this.deletionUpdates.next(event);
  }
  constructor(
    readonly relays: () => string[],
    readonly allowed: (event: SignedEvent) => boolean = () => true,
  ) {}
  seed(inputs: SignedEvent[], fromCache = false) {
    for (const input of inputs)
      try {
        const event = verifiedEvent(input);
        if (fromCache) markFromCache(event);
        this.remember(event);
      } catch {}
  }
  cached(filters: Filter[]) {
    return [
      ...this.store.getByFilters(filters),
      ...[...this.deletions.values()].filter((event) => matchFilters(filters, event)),
    ];
  }
  async query(
    filters: Filter[],
    hints: string[] = [],
    signal = AbortSignal.timeout(10000),
    onEvent?: (event: SignedEvent) => void,
    requireComplete = false,
    onRelayComplete?: () => void,
  ) {
    const relays = [...new Set([...hints, ...this.relays()])]
      .flatMap((value) => {
        try {
          return [readRelayUrl(value, this.relays(), true)];
        } catch {
          return [];
        }
      })
      .slice(0, 8);
    const found = new Map<string, SignedEvent>();
    let completed = 0;
    await Promise.all(
      relays.map(async (relay) => {
        let connection: ReturnType<ProtocolClient['connection']> | undefined;
        try {
          connection = this.connection(relay);
          const pool = connection.pool;
          await new Promise<void>((resolve) => {
            if (signal.aborted) {
              resolve();
              return;
            }
            const subscription = pool
              .req([relay], filters)
              .pipe(
                takeWhile((m) => m.type !== 'EOSE' && m.type !== 'CLOSED', true),
                take(1200),
                takeUntil(timer(3500)),
              )
              .subscribe({
                next: (m) => {
                  if (m.type === 'EOSE') {
                    completed++;
                    onRelayComplete?.();
                  }
                  if (m.type !== 'EVENT' || found.size >= 1000) return;
                  try {
                    if (JSON.stringify(m.event).length > 70000) return;
                    const event = verifiedEvent(m.event);
                    if (
                      event.created_at <= Date.now() / 1000 + 60 &&
                      matchFilters(filters, event)
                    ) {
                      const fresh = !found.has(event.id);
                      found.set(event.id, event);
                      this.remember(event);
                      if (fresh) onEvent?.(event);
                    }
                  } catch {}
                },
                error: () => resolve(),
                complete: resolve,
              });
            const abort = () => {
              subscription.unsubscribe();
              resolve();
            };
            signal.addEventListener('abort', abort, { once: true });
            subscription.add(() => signal.removeEventListener('abort', abort));
          });
        } finally {
          connection?.release();
        }
      }),
    );
    signal.throwIfAborted();
    if (requireComplete && (!relays.length || completed !== relays.length))
      throw new Error('list-unavailable');
    if (!completed && !found.size)
      throw new Error('No relay completed the query. Check your relay settings or retry.');
    return [...found.values()];
  }
  /** A partial read for interactive UI. Other relays still populate the verified store.
   * Never use this for mutations requiring a complete relay view. */
  queryAvailable(filters: Filter[], hints: string[] = [], signal?: AbortSignal) {
    return new Promise<SignedEvent[]>((resolve, reject) => {
      const found = new Map<string, SignedEvent>();
      const finish = () => resolve([...found.values()]);
      void this.query(
        filters,
        hints,
        signal,
        (event) => found.set(event.id, event),
        false,
        finish,
      ).then(finish, reject);
    });
  }
  /** A pinned ID has one signed value. Empty EOSEs must not beat a later matching event. */
  queryEvent(id: string, kinds: number[], hints: string[] = [], signal?: AbortSignal) {
    signal?.throwIfAborted();
    if (!/^[a-f0-9]{64}$/.test(id)) throw new Error('Expected an exact event id.');
    const cached = this.store.getEvent(id);
    if (cached && kinds.includes(cached.kind) && cached.created_at <= Date.now() / 1000 + 60)
      return Promise.resolve(cached);
    return new Promise<SignedEvent | undefined>((resolve, reject) => {
      const controller = new AbortController();
      const finish = (event?: SignedEvent) => {
        resolve(event);
        controller.abort();
      };
      void this.query(
        [{ ids: [id], kinds, limit: 1 }],
        hints,
        signal ? AbortSignal.any([signal, controller.signal]) : controller.signal,
        finish,
      ).then(() => finish(), reject);
    });
  }
  /** UI projection: cache first, reactive store updates, bounded relay refresh.
   * Unsubscribing cancels I/O. Authority-sensitive reads still use query(..., true). */
  observeQuery(filters: Filter[], hints: string[] = []) {
    return new Observable<SignedEvent[]>((observer) => {
      const controller = new AbortController();
      const emit = () => observer.next(this.cached(filters));
      const updates = this.store.timeline(filters).subscribe({ next: emit });
      const deletions = this.deletionUpdates.subscribe((event) => {
        if (matchFilters(filters, event)) emit();
      });
      void this.query(filters, hints, controller.signal).then(
        () => observer.complete(),
        (error) => {
          if (!controller.signal.aborted) observer.error(error);
        },
      );
      return () => {
        controller.abort();
        updates.unsubscribe();
        deletions.unsubscribe();
      };
    }).pipe(shareReplay({ bufferSize: 1, refCount: true }));
  }
  async publish(input: SignedEvent, hints: string[] = [], signal?: AbortSignal) {
    signal?.throwIfAborted();
    const event = verifiedEvent(input);
    if (!this.allowed(event)) throw new Error('This action is unavailable here.');
    const relays = [...new Set([...this.relays(), ...hints])]
      .flatMap((value) => {
        try {
          return [readRelayUrl(value, this.relays(), true)];
        } catch {
          return [];
        }
      })
      .slice(0, 8);
    const failures: { from: string; message: string }[] = [];
    // Fan out once, but acceptance by one relay is enough to finish the action.
    // The remaining bounded attempts keep running and retain their connections.
    const attempts = relays.map(async (relay) => {
      let connection: ReturnType<ProtocolClient['connection']> | undefined;
      try {
        signal?.throwIfAborted();
        connection = this.connection(relay);
        const results = await connection.pool.publish([relay], event, {
          timeout: 6000,
          retries: false,
        });
        const accepted = results.filter((r) => r.ok).map((r) => r.from);
        if (accepted.length) return accepted;
        throw new Error(results.map((r) => r.message || 'rejected or timed out').join('; '));
      } catch (error) {
        failures.push({
          from: relay,
          message: redactDiagnostic(
            error instanceof Error ? error.message : 'Transport failed',
            200,
          ),
        });
        throw error;
      } finally {
        connection?.release();
      }
    });
    try {
      // Promise.any also handles later rejections after the first acceptance.
      const accepted = await Promise.any(attempts);
      signal?.throwIfAborted();
      this.seed([event]);
      return accepted;
    } catch {
      signal?.throwIfAborted();
      throw new Error(
        `No relay acknowledged the event. Retry sends the same signed event. ${failures.map((r) => `${redactDiagnostic(r.from, 200)}: ${r.message}`).join('; ')}`,
      );
    }
  }
}
