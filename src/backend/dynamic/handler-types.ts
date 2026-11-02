/** Authoring types for soy-handler-v1. Type-only: no runtime imports in a handler. */
export type Principal = `nostr:${string}` | `guest:${string}`;
export type BackendAccess = {
  visibility: 'public' | 'members';
  building: 'members' | 'everyone';
  guestsMayBuild: boolean;
  members: Record<`nostr:${string}`, 'builder' | 'viewer'>;
};
export type BackendContext = Readonly<{
  /** Ephemeral transport public key. Not a durable account. */
  actor: string;
  /** Verified raw hex public key, or null for a guest. */
  account: string | null;
  /** Compare principal === owner, not account === owner. */
  principal: Principal;
  owner: Principal;
  instance: string;
  release: string;
  operation: string;
  requestId: string;
  /** Unix seconds supplied by the provider. */
  now: number;
  state: Readonly<{
    get<T = unknown>(collection: string, key: string): Promise<T | null>;
    set(collection: string, key: string, value: unknown): Promise<null>;
    remove(collection: string, key: string): Promise<null>;
    access(): Promise<BackendAccess>;
    setAccess(value: BackendAccess): Promise<null>;
    setMember(principal: `nostr:${string}`, role: 'builder' | 'viewer' | null): Promise<null>;
  }>;
}>;
