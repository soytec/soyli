import { z } from 'zod';
import { verifiedEvent, type SignedEvent } from '../../protocol/src';

export const studioSigningKinds = [24242, 30617, 30618, 35129, 15129, 5129, 1618, 1619, 1631];
export const studioChannel = 'soy-studio-signing/1';
export const studioTemplate = z
  .object({
    kind: z
      .number()
      .int()
      .refine((k) => studioSigningKinds.includes(k)),
    created_at: z.number().int().nonnegative(),
    tags: z.array(z.array(z.string().max(16000)).max(32)).max(256),
    content: z.string().max(60000),
  })
  .strict()
  .refine((v) => new TextEncoder().encode(JSON.stringify(v)).length <= 65536);
export const studioSignRequest = z
  .object({
    protocol: z.literal(studioChannel),
    channel: z.uuid(),
    type: z.literal('sign'),
    id: z.uuid(),
    pubkey: z.string().regex(/^[a-f0-9]{64}$/),
    template: studioTemplate,
  })
  .strict();

/** The shell accepts its own origin, or an explicitly visited loopback Studio. */
export function studioSignerOrigin(value: string, shellOrigin: string) {
  try {
    const u = new URL(value);
    return (
      u.origin === value &&
      !u.username &&
      !u.password &&
      (value === shellOrigin ||
        (u.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(u.hostname)))
    );
  } catch {
    return false;
  }
}

export function verifyStudioSignature(
  pubkey: string,
  template: z.infer<typeof studioTemplate>,
  input: unknown,
): SignedEvent {
  const event = verifiedEvent(input);
  if (
    event.pubkey !== pubkey ||
    event.kind !== template.kind ||
    event.created_at !== template.created_at ||
    event.content !== template.content ||
    JSON.stringify(event.tags) !== JSON.stringify(template.tags)
  )
    throw new Error('The signed event does not match the requested publication or account.');
  return event;
}
