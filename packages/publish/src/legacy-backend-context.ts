import { z } from 'zod';
import { decodeAddress, encodeAddress } from '../../protocol/src';

export const LEGACY_BACKEND_CONTEXT = '.napplet-space/soy-backend.json';
const relay = z
  .string()
  .max(256)
  .refine((value) => {
    try {
      const url = new URL(value);
      return (
        !url.username &&
        !url.password &&
        !url.search &&
        !url.hash &&
        (url.protocol === 'wss:' ||
          (url.protocol === 'ws:' && ['127.0.0.1', '[::1]'].includes(url.hostname)))
      );
    } catch {
      return false;
    }
  });
// Historical output of backendProject, not a general exemption for generated files.
// Unknown/nested private fields and arbitrary JSON payloads must never be accepted.
const contextSchema = z
  .object({
    version: z.literal(1),
    napplet: z
      .string()
      .max(4096)
      .refine((value) => {
        try {
          const identity = decodeAddress(value);
          return (
            identity.kind === 35129 &&
            /^[a-z0-9][a-z0-9-]{0,63}$/.test(identity.identifier) &&
            encodeAddress(identity) === value
          ); // no extra TLVs/relay hints in generated context
        } catch {
          return false;
        }
      }),
    provider: z
      .object({
        pubkey: z.string().regex(/^[a-f0-9]{64}$/),
        relays: z.array(relay).min(1).max(8),
      })
      .strict()
      .optional(),
    boards: z.array(z.string().regex(/^[a-z0-9-]{1,48}$/)).max(16),
    modules: z
      .array(z.string().regex(/^[a-z][a-z0-9-]{0,47}$/))
      .max(8)
      .optional(),
  })
  .strict();

export function isLegacyPublicBackendContext(bytes: Uint8Array, objectSize: number) {
  if (objectSize > 16384) return false;
  try {
    const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    const parsed = JSON.parse(text);
    // Only ordinary JSON serialization is compatible. In particular, reject duplicate
    // keys whose earlier values JSON.parse would silently discard before validation.
    const compact = text.replace(/"(?:[^"\\]|\\.)*"|\s+/g, (part) =>
      part.startsWith('"') ? part : '',
    );
    return compact === JSON.stringify(parsed) && contextSchema.safeParse(parsed).success;
  } catch {
    return false;
  }
}
