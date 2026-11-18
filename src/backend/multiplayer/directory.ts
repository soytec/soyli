import { z } from 'zod';
import { decodeAddress, encodeAddress } from '#src/protocol/events.ts';

export const directoryFamily = 'soy.room-directory.v1';
export const joinConvention = 'napplet:game/join';
export const entryKey = 'soy.room-entry.v1';
const label = z
  .string()
  .trim()
  .min(1)
  .max(64)
  .regex(/^[^\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]+$/u);
export const directoryDetails = z
  .object({
    title: label,
    phase: z.enum(['lobby', 'playing']),
    accepting: z.boolean(),
    badges: z.array(label).max(3).default([]),
  })
  .strict();
export const advertiseRoom = z
  .object({ room: z.string().uuid(), listing: directoryDetails.nullable() })
  .strict();
export const listDirectory = z
  .object({
    after: z.string().uuid().optional(),
    limit: z.number().int().min(1).max(50).default(16),
  })
  .strict();
export const entryRef = z
  .object({
    version: z.literal(1),
    provider: z.string().regex(/^[0-9a-f]{64}$/),
    napplet: z
      .string()
      .max(4096)
      .transform((v, ctx) => {
        try {
          return encodeAddress(decodeAddress(v));
        } catch {
          ctx.addIssue({ code: 'custom', message: 'Invalid game address' });
          return z.NEVER;
        }
      }),
    protocol: z.string().regex(/^[a-zA-Z0-9._-]{1,64}$/),
    room: z.string().uuid(),
  })
  .strict();
export type RoomEntry = z.infer<typeof entryRef>;
export const directoryRow = directoryDetails
  .extend({
    entry: entryRef,
    players: z.number().int().min(1).max(64),
    capacity: z.number().int().min(2).max(64),
    expiresAt: z.number().int().positive(),
  })
  .strict();
export const directoryPage = z
  .object({ rooms: z.array(directoryRow).max(50), next: z.string().uuid().nullable() })
  .strict();
export type DirectoryRow = z.infer<typeof directoryRow>;
