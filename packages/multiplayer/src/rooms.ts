import { z } from 'zod';
import { decodeAddress, identityAddress } from '../../protocol/src';

export const roomNamespace = z.object({
  napplet: z.string().max(4096),
  protocol: z.string().regex(/^[a-zA-Z0-9._-]{1,64}$/),
});
export const roomCreate = roomNamespace
  .extend({
    name: z.string().min(1).max(80),
    capacity: z.number().int().min(2).max(64),
    listed: z.boolean().default(true),
  })
  .strict();
export const roomKey = z.object({ room: z.string().uuid() }).strict();
type Room = z.infer<typeof roomCreate> & {
  id: string;
  namespace: string;
  peers: Map<string, number>;
};
const namespace = (args: z.infer<typeof roomNamespace>) =>
  `${identityAddress(decodeAddress(args.napplet))}/${args.protocol}`;

/** Leased membership, not game authority. A room survives departure while other peers renew it. */
export class Rooms {
  private rooms = new Map<string, Room>();
  constructor(
    private now = Date.now,
    private maximum = 1000,
    private maxPeers = 8,
  ) {}
  private sweep() {
    for (const [id, room] of this.rooms) {
      for (const [key, expiry] of room.peers) if (expiry <= this.now()) room.peers.delete(key);
      if (!room.peers.size) this.rooms.delete(id);
    }
  }
  private view(room: Room) {
    return {
      version: 1,
      room: room.id,
      name: room.name,
      protocol: room.protocol,
      capacity: room.capacity,
      peers: [...room.peers.keys()].sort(),
      expiresAt: Math.min(...room.peers.values()),
    };
  }
  create(actor: string, input: unknown) {
    this.sweep();
    const args = roomCreate.parse(input);
    if (args.capacity > this.maxPeers)
      throw new Error(`Provider room capacity is ${this.maxPeers}`);
    // Prevent unlimited rooms from one caller; joining multiple rooms is also bounded below.
    if (
      [...this.rooms.values()].filter((r) => r.peers.has(actor)).length >= 4 ||
      this.rooms.size >= this.maximum
    )
      throw new Error('Room capacity reached');
    const room: Room = {
      ...args,
      id: crypto.randomUUID(),
      namespace: namespace(args),
      peers: new Map([[actor, this.now() + 60_000]]),
    };
    this.rooms.set(room.id, room);
    return this.view(room);
  }
  list(input: unknown) {
    this.sweep();
    const group = namespace(roomNamespace.strict().parse(input));
    return {
      rooms: [...this.rooms.values()]
        .filter((r) => r.namespace === group && r.listed)
        .slice(0, 100)
        .map((r) => this.view(r)),
    };
  }
  access(actor: string, input: unknown, join: boolean) {
    this.sweep();
    const { room: id } = roomKey.parse(input),
      room = this.rooms.get(id);
    if (!room) throw new Error('Room expired');
    if (!room.peers.has(actor)) {
      if (!join) throw new Error('Join this room first');
      if (room.peers.size >= room.capacity) throw new Error('Room full');
      if ([...this.rooms.values()].filter((r) => r.peers.has(actor)).length >= 4)
        throw new Error('Membership limit reached');
    }
    room.peers.set(actor, this.now() + 60_000);
    return this.view(room);
  }
  leave(actor: string, input: unknown) {
    this.rooms.get(roomKey.parse(input).room)?.peers.delete(actor);
    this.sweep();
    return { left: true };
  }
}
