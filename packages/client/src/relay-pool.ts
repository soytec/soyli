import { RelayPool } from 'applesauce-relay';

/** Application-owned transport. Consumers cancel their own I/O, not this pool. */
export const relayPool = new RelayPool({ keepAlive: 10000 });

// Track active operations only, to bound relay objects and avoid evicting busy relays.
const connections = new Map<
  string,
  { users: number; timer?: ReturnType<typeof setTimeout> }
>();

export function relayConnection(url: string) {
  let entry = connections.get(url);
  if (!entry) {
    if (connections.size >= 24) {
      const idle = [...connections].find(([, entry]) => !entry.users);
      if (!idle) throw new Error('Relay connections are busy. Retry shortly.');
      clearTimeout(idle[1].timer);
      relayPool.remove(idle[0]);
      connections.delete(idle[0]);
    }
    entry = { users: 0 };
    connections.set(url, entry);
  }
  clearTimeout(entry.timer);
  entry.users++;
  const current = entry;
  return {
    relay: relayPool.relay(url),
    release: () => {
      if (connections.get(url) !== current || --current.users) return;
      current.timer = setTimeout(() => {
        relayPool.remove(url);
        connections.delete(url);
      }, 10000);
      (current.timer as any).unref?.();
    },
  };
}

/** Application/test teardown only; ordinary consumers just abort or unsubscribe. */
export function disconnectRelays() {
  for (const entry of connections.values()) clearTimeout(entry.timer);
  connections.clear();
  relayPool.close();
}
