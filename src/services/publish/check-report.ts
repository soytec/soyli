import { z } from 'zod';

/** Coverage is local check evidence, never a manifest field or a conformance certificate. */
export const checkReportSchema = z
  .object({
    profile: z.string().max(80),
    browser: z.string().max(80),
    // Older frozen publications have no coverage record; do not infer one for them.
    coverage: z
      .object({
        startup: z.literal('passed'),
        interaction: z
          .object({
            status: z.enum(['not-run', 'exercised']),
            actions: z.number().int().nonnegative(),
            source: z.enum(['preview.recording', 'interactive-capture']).optional(),
          })
          .strict(),
        mediaCoordination: z.literal('not-verified'),
        independentHost: z.literal('not-run'),
      })
      .strict()
      .optional(),
    warnings: z.array(z.string().max(600)).max(8).optional(),
  })
  .strict();
export type CheckReport = z.infer<typeof checkReportSchema>;
