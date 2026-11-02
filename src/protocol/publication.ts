import { z } from 'zod';
import { eventSchema } from './events.ts';

/** A website projection receipt, not a Nostr event or a new publication standard. */
export const publicationReceiptSchema = z.object({
  version: z.literal(1),
  status: z.enum(['ready', 'pending', 'superseded']),
  checkedAt: z.number().int().nonnegative(),
  current: eventSchema.nullable(),
  snapshot: eventSchema.nullable(),
  artifactHash: z
    .string()
    .regex(/^[a-f0-9]{64}$/)
    .nullable(),
});
