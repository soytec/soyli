import { DiagnosticError, type Diagnostic } from '../../diagnostics/src';
import { publicNodeWorker } from '../../backend/src/public-node-worker';
import { matchFilters, type Filter } from 'nostr-tools';
import { fromEvent, take, takeUntil, takeWhile } from 'rxjs';
import { openPlaybackRelay } from '../../backend/src/relay-tunnel';
import { AccountError } from '../../identity/src/signer';
import { verifiedEvent, type SignedEvent } from '../../protocol/src';

/** Finite, signer-free discovery using the same DNS-pinned Bun transport as playback. */
export async function discoverRemix(filter: Filter, relays: string[], signal: AbortSignal) {
  if (typeof Bun !== 'undefined' && process.env.SPACE_PUBLIC_NETWORK_NODE === '1') {
    const bytes = await publicNodeWorker(
      'packages/remix/src/discovery-worker.ts',
      { filter, relays },
      signal,
      128 * 1024,
      'discover remix',
      10000,
    );
    const result = JSON.parse(new TextDecoder().decode(bytes)) as {
      event?: SignedEvent;
      error?: Diagnostic;
    };
    if (result.error)
      throw new DiagnosticError(result.error.code, result.error.message, {
        operation: result.error.operation,
        recovery: result.error.recovery,
        detail: result.error.details?.join('\n'),
      });
    const event = verifiedEvent(result.event);
    if (!matchFilters([filter], event) || event.created_at > Date.now() / 1000 + 60)
      throw new Error('The remix worker returned an unrelated release.');
    return event;
  }
  const events = new Map<string, SignedEvent>();
  // A full event hash identifies one immutable revision. Once verified, waiting
  // for fallback relays cannot improve it. Named/latest lookups still gather all
  // responses within their deadline before choosing the newest signed event.
  const exact = filter.ids?.length === 1 && /^[a-f0-9]{64}$/.test(filter.ids[0]);
  const resolved = new AbortController();
  let completed = 0;
  const failures: Error[] = [];
  const cancelled = () =>
    new AccountError(
      'REMIX_CANCELLED',
      'Remix lookup was cancelled or timed out. Retry the command.',
    );
  if (signal.aborted) throw cancelled();
  await Promise.all(
    relays.map(async (value) => {
      const lifetime = new AbortController();
      const deadline = setTimeout(() => lifetime.abort(), 5000);
      const combined = AbortSignal.any([signal, lifetime.signal, resolved.signal]);
      let finished = false,
        failure: unknown;
      let pool: Awaited<ReturnType<typeof openPlaybackRelay>> | undefined;
      try {
        // Canonical URL must also match the transport's pinned destination.
        const relay = new URL(value).href;
        pool = await openPlaybackRelay(relay, combined);
        if (combined.aborted) return;
        await new Promise<void>((done) => {
          pool!
            .req([relay], [filter])
            .pipe(
              takeWhile((m) => m.type !== 'EOSE' && m.type !== 'CLOSED', true),
              take(12),
              takeUntil(fromEvent(combined, 'abort')),
            )
            .subscribe({
              next: (message) => {
                if (message.type === 'EOSE') {
                  completed++;
                  finished = true;
                }
                if (message.type === 'CLOSED')
                  failure = new Error(`Relay closed query: ${message.reason}`);
                if (message.type !== 'EVENT') return;
                try {
                  const event = verifiedEvent(message.event);
                  if (matchFilters([filter], event) && event.created_at <= Date.now() / 1000 + 60) {
                    events.set(event.id, event);
                    if (exact) {
                      finished = true;
                      resolved.abort();
                    }
                  }
                } catch {
                  /* Untrusted relay events must pass signature and size checks. */
                }
              },
              error: (cause) => {
                failure = cause;
                done();
              },
              complete: done,
            });
        });
      } catch (cause) {
        failure = cause;
      } finally {
        if (!finished && !resolved.signal.aborted)
          failures.push(
            new DiagnosticError('RELAY_READ', 'Relay lookup did not complete.', {
              target: value,
              cause:
                failure ??
                new Error(
                  combined.aborted
                    ? 'Lookup deadline reached or cancelled.'
                    : 'Relay ended without EOSE.',
                ),
            }),
          );
        clearTimeout(deadline);
        lifetime.abort();
        pool?.close();
      }
    }),
  );
  if (signal.aborted) throw cancelled();
  const manifest = [...events.values()].sort(
    (a, b) => b.created_at - a.created_at || a.id.localeCompare(b.id),
  )[0];
  if (manifest) return manifest;
  if (!completed)
    throw new DiagnosticError(
      'REMIX_RELAYS_UNAVAILABLE',
      'No relay completed the napplet lookup. Check your connection and retry; the release may still be available.',
      {
        operation: 'discover remix',
        cause: new AggregateError(failures, 'Relay attempts failed.'),
      },
    );
  throw new AccountError(
    'REMIX_NOT_FOUND',
    'The responding relays did not return this release. Try a portable naddr link for the latest version, or an nevent with a relay that retains this exact event.',
  );
}
