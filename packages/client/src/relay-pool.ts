import { RelayPool } from 'applesauce-relay';

// Share transport, not event stores or client-specific relay/permission policies.
// A module instance owns at most one live pool, even with concurrent clients.
let shared: ClientRelayPool | undefined;

class ClientRelayPool {
  private pool = new RelayPool({ keepAlive: 10000 });
  private clients = 0;
  private connections = new Map<
    string,
    { users: number; timer?: ReturnType<typeof setTimeout> }
  >();

  retain() {
    this.clients++;
    return this;
  }

  release() {
    if (--this.clients) return;
    for (const entry of this.connections.values()) clearTimeout(entry.timer);
    this.connections.clear();
    this.pool.close();
    shared = undefined;
  }

  connection(url: string) {
    let entry = this.connections.get(url);
    if (!entry) {
      if (this.connections.size >= 24) {
        const idle = [...this.connections].find(([, entry]) => !entry.users);
        if (!idle) throw new Error('Relay connections are busy. Retry shortly.');
        clearTimeout(idle[1].timer);
        this.pool.remove(idle[0]);
        this.connections.delete(idle[0]);
      }
      entry = { users: 0 };
      this.connections.set(url, entry);
    }
    clearTimeout(entry.timer);
    entry.users++;
    const current = entry;
    return {
      relay: this.pool.relay(url),
      release: () => {
        if (this.connections.get(url) !== current || --current.users) return;
        current.timer = setTimeout(() => {
          this.pool.remove(url);
          this.connections.delete(url);
        }, 10000);
        (current.timer as any).unref?.();
      },
    };
  }
}

export function acquireClientRelayPool() {
  shared ??= new ClientRelayPool();
  return shared.retain();
}
