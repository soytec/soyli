import { expect, test } from 'bun:test';
import { finalizeEvent, generateSecretKey } from 'nostr-tools';
import { NappletActions } from '../action-session';

test('closing an action session cancels its pending I/O before signing', async () => {
  const event = finalizeEvent({
    kind: 1, content: '', tags: [], created_at: Math.floor(Date.now() / 1000),
  }, generateSecretKey());
  const started = Promise.withResolvers<AbortSignal>();
  let signatures = 0;
  const actions = new NappletActions({
    pubkey: event.pubkey,
    relays: [],
    signal: new AbortController().signal,
    consent: async () => true,
    sign: async () => { signatures++; return event; },
    io: {
      query: (_filters, signal) => new Promise((_resolve, reject) => {
        signal.addEventListener('abort', () => reject(signal.reason), { once: true });
        started.resolve(signal);
      }),
      publish: async () => { throw new Error('Must not publish after close.'); },
    },
  });
  const pending = actions.handle({ type: 'common.react', targetEventId: event.id, reaction: '+' });
  const signal = await started.promise;
  actions.close();
  expect(signal.aborted).toBe(true);
  expect(await pending).toEqual({ ok: false, error: 'request-cancelled' });
  expect(signatures).toBe(0);
});
