import { z } from 'zod';
import { validateScoreDataSchema } from './score-data';

const dataSchema = z
  .record(z.string(), z.unknown())
  .superRefine((value, context) => {
    try {
      validateScoreDataSchema(value);
    } catch (error) {
      // This validator emits field paths/rules, never rejected values. Opt it in
      // to useful CLI diagnostics; arbitrary Zod messages remain suppressed.
      context.addIssue({
        code: 'custom',
        message: (error as Error).message,
        params: { diagnosticMessage: (error as Error).message },
      });
    }
  })
  .describe(
    'Bounded JSON Schema object for required public score data. Supports nested objects/arrays, primitive types, required, enum and bounds. 8 KiB maximum; no refs, regex or executable logic.',
  );

export const boardRef = z.object({
  napplet: z.string().max(4096),
  board: z.string().regex(/^[a-z0-9-]{1,48}$/),
});
export const boardDefinition = boardRef
  .extend({
    title: z.string().min(1).max(100),
    order: z.enum(['highest', 'lowest']),
    minimum: z.number().finite().min(-1e12).max(1e12),
    maximum: z.number().finite().min(-1e12).max(1e12),
    dataSchema: dataSchema.optional(),
  })
  .strict();
export const boardRegister = z
  .object({ definition: boardDefinition, authorization: z.unknown() })
  .strict();
export const boardSubmit = boardRef
  .extend({
    score: z.number().finite(),
    name: z.string().max(40).default('Player'),
    data: z
      .record(z.string(), z.unknown())
      .optional()
      .describe(
        'Public JSON attachment, required when the board declares dataSchema. Maximum 8192 UTF-8 bytes, depth 8, 256 items per array. Saved atomically only for a better score.',
      ),
  })
  .strict();
export const boardRead = boardRef
  .extend({
    limit: z.number().int().min(1).max(100).default(20),
    offset: z.number().int().min(0).max(1000).default(0),
  })
  .strict();
export const boardEntry = boardRef
  .extend({
    actor: z.string().regex(/^[a-f0-9]{64}$/),
    revision: z
      .string()
      .regex(/^[a-f0-9]{32}$/)
      .optional()
      .describe(
        'Revision from soy_board_read. A changed personal best returns stale: true instead of another run’s data.',
      ),
  })
  .strict();
export type BoardDefinition = z.infer<typeof boardDefinition>;

/** Signed, unpublished application proof. It is not a relay event or a NIP-98 HTTP request. */
export function boardAuthorization(
  provider: string,
  actor: string,
  definition: BoardDefinition,
  now = Date.now(),
) {
  return {
    kind: 1,
    created_at: Math.floor(now / 1000),
    tags: [
      ['t', 'soy-board-registration-v1'],
      ['p', provider],
    ],
    content: JSON.stringify({ actor, definition: boardDefinition.parse(definition) }),
  };
}

export const backendConfig = z
  .object({
    provider: z
      .object({
        pubkey: z.string().regex(/^[a-f0-9]{64}$/),
        relays: z.array(z.string().max(256)).min(1).max(8),
      })
      .strict()
      .optional(),
    boards: z
      .array(boardDefinition.omit({ napplet: true }))
      .max(16)
      .default([]),
    modules: z.array(z.string().min(1).max(240)).max(8).optional(),
  })
  .strict();
