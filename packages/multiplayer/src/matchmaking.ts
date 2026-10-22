import { z } from 'zod';
import { decodeAddress, identityAddress } from '../../protocol/src';

export const joinSchema = z
  .object({
    napplet: z.string().max(4096),
    artifact: z.string().regex(/^[a-f0-9]{64}$/),
    queue: z
      .string()
      .regex(/^[a-z0-9-]{1,48}$/)
      .default('casual'),
    players: z.number().int().min(2).max(8).default(2),
  })
  .strict();
export const ticketSchema = z.object({ ticket: z.string().uuid() }).strict();
export const protocolJoinSchema = joinSchema
  .omit({ artifact: true })
  .extend({
    protocol: z.string().min(1).max(128),
  })
  .strict();
export const matchSchema = z.object({
  version: z.literal(1),
  ticket: z.string().uuid(),
  state: z.enum(['waiting', 'matched', 'closed']),
  expiresAt: z.number().int(),
  room: z.string().uuid().nullable(),
  peers: z.array(z.string().regex(/^[a-f0-9]{64}$/)).max(8),
});
type Match = z.infer<typeof matchSchema>;
type Ticket = Match & { actor: string; group: string; players: number };

/** Ephemeral rendezvous only. No game code, arbitrary writes, scores, or simulation authority. */
export class Matchmaking {
  private tickets = new Map<string, Ticket>();
  private limits = new Map<string, { start: number; calls: number }>();
  constructor(
    private now = Date.now,
    private capacity = 1000,
  ) {}
  private sweep() {
    const now = this.now();
    for (const [id, ticket] of this.tickets) if (ticket.expiresAt <= now) this.tickets.delete(id);
    for (const [actor, limit] of this.limits)
      if (limit.start + 60_000 <= now) this.limits.delete(actor);
  }
  private authorize(actor: string) {
    if (!/^[a-f0-9]{64}$/.test(actor)) throw new Error('Authenticated ContextVM client required');
    this.sweep();
    const limit = this.limits.get(actor);
    if (limit && ++limit.calls > 120) throw new Error('Too many requests; retry in a minute');
    if (!limit) {
      if (this.limits.size >= this.capacity * 2) throw new Error('Matchmaker is busy');
      this.limits.set(actor, { start: this.now(), calls: 1 });
    }
  }
  private view({ actor: _, group: __, players: ___, ...result }: Ticket): Match {
    return { ...result, peers: [...result.peers] };
  }
  join(actor: string, input: unknown) {
    const args = joinSchema.parse(input);
    return this.enqueue(actor, args, ['artifact', args.artifact]);
  }
  joinProtocol(actor: string, input: unknown) {
    const args = protocolJoinSchema.parse(input);
    return this.enqueue(actor, args, ['protocol', args.protocol]);
  }
  private enqueue(
    actor: string,
    args: { napplet: string; queue: string; players: number },
    version: string[],
  ) {
    this.authorize(actor);
    const address = identityAddress(decodeAddress(args.napplet));
    const group = JSON.stringify([address, version, args.queue, args.players]);
    const previous = [...this.tickets.values()].find((ticket) => ticket.actor === actor);
    if (previous?.state === 'closed') this.tickets.delete(previous.ticket);
    else if (previous) {
      if (previous.group !== group)
        throw new Error('Leave your current match before joining another queue');
      if (previous.state === 'waiting') previous.expiresAt = this.now() + 60_000;
      return this.view(previous);
    }
    if (this.tickets.size >= this.capacity) throw new Error('Matchmaker is full');
    const ticket: Ticket = {
      version: 1,
      ticket: crypto.randomUUID(),
      actor,
      group,
      players: args.players,
      state: 'waiting',
      expiresAt: this.now() + 60_000,
      room: null,
      peers: [],
    };
    this.tickets.set(ticket.ticket, ticket);
    const waiting = [...this.tickets.values()].filter(
      (t) => t.group === group && t.state === 'waiting',
    );
    if (waiting.length >= args.players) {
      const selected = waiting.slice(0, args.players);
      const room = crypto.randomUUID();
      for (const t of selected)
        Object.assign(t, {
          state: 'matched',
          room,
          peers: selected.map((p) => p.actor),
          expiresAt: this.now() + 10 * 60_000,
        });
    }
    return this.view(ticket);
  }
  status(actor: string, input: unknown) {
    this.authorize(actor);
    const { ticket: id } = ticketSchema.parse(input);
    const ticket = this.tickets.get(id);
    if (!ticket || ticket.actor !== actor) throw new Error('Match ticket unavailable');
    if (ticket.state === 'waiting') ticket.expiresAt = this.now() + 60_000;
    return this.view(ticket);
  }
  leave(actor: string, input: unknown) {
    this.authorize(actor);
    const { ticket: id } = ticketSchema.parse(input);
    const ticket = this.tickets.get(id);
    if (ticket && ticket.actor !== actor) throw new Error('Match ticket unavailable');
    if (ticket?.room)
      for (const peer of this.tickets.values())
        if (peer.room === ticket.room) {
          peer.state = 'closed';
          peer.peers = [];
          peer.expiresAt = this.now() + 60_000;
        }
    this.tickets.delete(id);
    return { left: true };
  }
}
