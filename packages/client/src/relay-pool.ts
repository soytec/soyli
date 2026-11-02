import { RelayPool } from 'applesauce-relay';

/** Application-owned transport. Applesauce reuses connections and closes idle sockets. */
export const relayPool = new RelayPool({ keepAlive: 10000 });
