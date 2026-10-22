import { DiagnosticError } from '../../diagnostics/src';
import { AuthRequiredError, RelayPool } from 'applesauce-relay';
import { matchFilter, type Filter } from 'nostr-tools';
import { NEVER, firstValueFrom, fromEvent, takeUntil, timeout, type Subscription } from 'rxjs';
import { verifiedEvent, type SignedEvent } from '../../protocol/src';
import { PublishError } from './config';

export const newer = (a: SignedEvent, b: SignedEvent) =>
  a.created_at > b.created_at || (a.created_at === b.created_at && a.id < b.id);
export class PublicationRelays {
  private pool = new RelayPool();
  constructor(private signal?: AbortSignal) {}
  async read(url: string, filter: Filter, timeoutMs = 8000): Promise<SignedEvent[]> {
    if (this.signal?.aborted)
      throw new PublishError('PUBLISH_CANCELLED', 'Publication cancelled.', 'check', true);
    return new Promise((resolve, reject) => {
      const events: SignedEvent[] = [];
      let subscription: Subscription | undefined,
        done = false;
      const finish = (error?: unknown) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        this.signal?.removeEventListener('abort', aborted);
        subscription?.unsubscribe();
        error
          ? reject(
              error instanceof PublishError
                ? error
                : new DiagnosticError('RELAY_READ', 'Publication relay query failed.', {
                    operation: 'read publication relay',
                    target: url,
                    cause: error,
                  }),
            )
          : resolve(events);
      };
      const aborted = () =>
        finish(new PublishError('PUBLISH_CANCELLED', 'Publication cancelled.', 'check', true));
      const timer = setTimeout(
        () =>
          finish(
            new PublishError(
              'RELAY_TIMEOUT',
              'Relay did not complete the query. Retry when it is reachable.',
              'check',
              true,
            ),
          ),
        Math.max(250, Math.min(8000, timeoutMs)),
      );
      this.signal?.addEventListener('abort', aborted, { once: true });
      subscription = this.pool
        .relay(url)
        .req(filter)
        .subscribe({
          next: (message) => {
            if (message.type === 'EOSE') finish();
            else if (message.type === 'CLOSED')
              finish(new Error(`Relay closed query: ${message.reason}`));
            else if (message.type === 'EVENT') {
              try {
                const event = verifiedEvent(message.event);
                if (matchFilter(filter, event) && !events.some((e) => e.id === event.id))
                  events.push(event);
                if (events.length > 256) finish(new Error('Relay query exceeded limit'));
              } catch {
                /* Ignore invalid signatures; never use them as concurrency evidence. */
              }
            }
          },
          error: finish,
          complete: () => {
            if (!done) finish(new Error('Relay did not send EOSE'));
          },
        });
      if (done) subscription.unsubscribe();
    });
  }
  async latest(url: string, pubkey: string, identifier: string, kind: number) {
    const events = await this.read(url, { kinds: [kind], authors: [pubkey], '#d': [identifier] });
    return events.reduce<SignedEvent | null>(
      (best, e) => (!best || newer(e, best) ? e : best),
      null,
    );
  }
  async ensure(url: string, event: SignedEvent) {
    if ((await this.read(url, { ids: [event.id] })).some((e) => e.id === event.id)) return;
    this.signal?.throwIfAborted();
    // Subscribe directly so cancellation tears down queued sends and acknowledgement waits.
    const result = await firstValueFrom(
      this.pool
        .relay(url)
        .event(event)
        .pipe(timeout(8000), takeUntil(this.signal ? fromEvent(this.signal, 'abort') : NEVER)),
    ).catch((cause) => {
      if (this.signal?.aborted)
        throw new PublishError('PUBLISH_CANCELLED', 'Publication cancelled.', 'relay', true, cause);
      // Applesauce v7 raises auth-required refusals; keep reporting them as relay refusals.
      if (cause instanceof AuthRequiredError) return { ok: false, from: url, message: cause.reason };
      throw cause;
    });
    this.signal?.throwIfAborted();
    if (!result.ok)
      throw new PublishError(
        'RELAY_REFUSED',
        'The selected relay refused the publication. Check its event policy and retry.',
        'relay',
        true,
        new DiagnosticError('RELAY_RESPONSE', 'Relay rejected the event.', {
          target: url,
          detail: result.message,
        }),
      );
    if (!(await this.read(url, { ids: [event.id] })).some((e) => e.id === event.id))
      throw new PublishError(
        'RELAY_UNCONFIRMED',
        'The relay acknowledged the event but did not return it. Retry the saved publication.',
        'relay',
        true,
      );
  }
  close() {
    this.pool.close();
  }
}
