import { RelayPool } from 'applesauce-relay';
import { matchFilter, type Filter, type EventTemplate } from 'nostr-tools';
import type { Subscription } from 'rxjs';
import { verifiedEvent, type SignedEvent } from '../../protocol/src';
import { DiagnosticError } from '../../diagnostics/src';

export type LifecycleSigner = { signEvent(event: EventTemplate): Promise<SignedEvent> };
export type LifecycleIO = {
  read(relay: string, filter: Filter): Promise<SignedEvent[]>;
  publish(relay: string, event: SignedEvent): Promise<void>;
  fetch(input: string, init?: RequestInit): Promise<Response>;
};
/** Exact per-service results: a successful mirror never conceals another service's failure. */
export class LifecycleTransport implements LifecycleIO {
  private pool = new RelayPool();
  fetch: LifecycleIO['fetch'] = (input, init) =>
    fetch(input, {
      ...init,
      credentials: 'omit',
      referrerPolicy: 'no-referrer',
      redirect: 'error',
      signal: AbortSignal.any([AbortSignal.timeout(12000), ...(this.signal ? [this.signal] : [])]),
    });
  constructor(private signal?: AbortSignal) {}
  async read(relay: string, filter: Filter, timeoutMs = 7000): Promise<SignedEvent[]> {
    this.signal?.throwIfAborted();
    return new Promise((resolve, reject) => {
      const events = new Map<string, SignedEvent>();
      let subscription: Subscription | undefined,
        done = false;
      const finish = (cause?: unknown) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        this.signal?.removeEventListener('abort', abort);
        subscription?.unsubscribe();
        if (cause)
          reject(
            new DiagnosticError('LIFECYCLE_RELAY_READ', 'Could not finish the relay inventory.', {
              operation: 'read publication lifecycle',
              target: relay,
              cause,
              recovery:
                'Retry when this relay is reachable. An incomplete inventory never confirms deletion.',
            }),
          );
        else resolve([...events.values()]);
      };
      const abort = () => finish(new Error('Operation cancelled.'));
      const timer = setTimeout(
        () => finish(new Error('Relay query timed out before EOSE.')),
        Math.max(250, Math.min(7000, timeoutMs)),
      );
      this.signal?.addEventListener('abort', abort, { once: true });
      subscription = this.pool
        .relay(relay)
        .req(filter)
        .subscribe({
          next: (m) => {
            if (m.type === 'EOSE') return finish();
            if (m.type === 'CLOSED') return finish(new Error(`Relay closed query: ${m.reason}`));
            if (m.type !== 'EVENT') return;
            try {
              if (JSON.stringify(m.event).length > 70000) return;
              const e = verifiedEvent(m.event);
              if (matchFilter(filter, e) && e.created_at <= Date.now() / 1000 + 60)
                events.set(e.id, e);
              if (events.size >= (filter.limit ?? 500))
                finish(
                  new Error(
                    'Inventory reached its query limit; narrow the selection before deleting.',
                  ),
                );
            } catch {
              /* Unverified events cannot authorize deletion. */
            }
          },
          error: finish,
          complete: () => {
            if (!done) finish(new Error('Relay disconnected before EOSE.'));
          },
        });
      if (done) subscription.unsubscribe();
    });
  }
  async publish(relay: string, event: SignedEvent) {
    this.signal?.throwIfAborted();
    const result = await this.pool
      .relay(relay)
      .publish(verifiedEvent(event), { timeout: 7000, retries: false, reconnect: false });
    if (!result.ok)
      throw new DiagnosticError('LIFECYCLE_RELAY_REFUSED', 'Relay refused the signed request.', {
        operation: 'publish lifecycle event',
        target: relay,
        detail: result.message,
        recovery: 'Retry this service; the same signed request will be reused.',
      });
  }
  close() {
    this.pool.close();
  }
}
