import { expect, test } from 'bun:test';
import { finalizeEvent, generateSecretKey } from 'nostr-tools';
import { ProtocolClient } from '../nostr';

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
