import { z } from 'zod';
import { eventSchema, verifiedEvent, type SignedEvent } from './index';
import { manifestIcon } from './manifest';
import { iconSources } from './icon';
import { manifestScreenshotSources } from './presentation';

export const PREVIEW_PROFILE = 'manifest-presentation-and-legacy-descriptors-4';
export const MAX_PREVIEW_BYTES = 5 * 1024 * 1024;
export const MAX_CACHED_PREVIEW_BYTES = 4 * 1024 * 1024;
export type AppReference = { kind: number; pubkey: string; identifier: string; relay?: string };
export const referenceAddress = (ref: AppReference) =>
  `${ref.kind}:${ref.pubkey}:${ref.identifier}`;

/** NIP-5A app references, with adapters only for the descriptor formats we understand. */
export function appReferences(manifest: SignedEvent): AppReference[] {
  const refs = new Map<string, AppReference>();
  for (const tag of manifest.tags) {
    if (tag[0] !== 'app' || tag.length < 2 || tag.length > 3) continue;
    const match = /^(31990|32267):([a-f0-9]{64}):([^\u0000-\u001f\u007f]{0,256})$/.exec(tag[1]);
    if (!match) continue;
    const ref = { kind: Number(match[1]), pubkey: match[2], identifier: match[3], relay: tag[2] };
    if (!refs.has(referenceAddress(ref))) refs.set(referenceAddress(ref), ref);
    if (refs.size === 4) break;
  }
  return [...refs.values()];
}

/** Select Nostr's newest signed winner before interpreting optional content. */
export function latestMetadata(ref: AppReference, inputs: unknown[]) {
  let newest: SignedEvent | undefined;
  for (const input of inputs) {
    try {
      // Cheap selection precedes signature work; a catalog can reference many descriptors.
      const candidate = input as Partial<SignedEvent> | null;
      if (
        !candidate ||
        candidate.kind !== ref.kind ||
        candidate.pubkey !== ref.pubkey ||
        !Array.isArray(candidate.tags) ||
        (ref.kind !== 0 &&
          !candidate.tags.some((t) => Array.isArray(t) && t[0] === 'd' && t[1] === ref.identifier))
      )
        continue;
      if (new TextEncoder().encode(JSON.stringify(input)).length > 16384) continue;
      const event = verifiedEvent(input);
      const d = event.tags.filter((t) => t[0] === 'd');
      if (
        event.kind !== ref.kind ||
        event.pubkey !== ref.pubkey ||
        (ref.kind !== 0 && (d.length !== 1 || d[0].length !== 2 || d[0][1] !== ref.identifier)) ||
        event.created_at > Date.now() / 1000 + 600
      )
        continue;
      if (
        !newest ||
        event.created_at > newest.created_at ||
        (event.created_at === newest.created_at && event.id < newest.id)
      )
        newest = event;
    } catch {
      /* Invalid relay events are not metadata. */
    }
  }
  return newest;
}

export function descriptorImages(descriptor: SignedEvent, profile?: SignedEvent) {
  if (descriptor.kind === 32267) {
    // Zapstore software application metadata: screenshots first, then the icon.
    return [
      ...descriptor.tags.filter((t) => t[0] === 'image'),
      ...descriptor.tags.filter((t) => t[0] === 'icon'),
    ]
      .map((t) => t[1])
      .filter(Boolean)
      .slice(0, 4);
  }
  if (descriptor.kind !== 31990) return [];
  try {
    // NIP-89 falls back to the descriptor author's kind 0 only when content is empty.
    const content = descriptor.content === '' ? profile?.content : descriptor.content;
    const metadata = JSON.parse(content ?? 'null');
    return metadata && typeof metadata.picture === 'string' ? [metadata.picture] : [];
  } catch {
    return [];
  }
}

export const cachedPreviewSchema = z.object({
  descriptor: eventSchema,
  profile: eventSchema.optional(),
  url: z.string().max(4096),
  hash: z.string().regex(/^[a-f0-9]{64}$/),
  width: z.number().int().min(1).max(1200),
  height: z.number().int().min(1).max(750),
  bytes: z.number().int().min(1).max(MAX_CACHED_PREVIEW_BYTES),
});
export type CachedPreview = z.infer<typeof cachedPreviewSchema>;

/** Recheck the signed manifest → exact descriptor → image association when reading disk caches. */
export function validatedPreview(manifest: SignedEvent, input: unknown): CachedPreview | null {
  try {
    const preview = cachedPreviewSchema.parse(input);
    if (preview.descriptor.id === manifest.id) {
      const descriptor = verifiedEvent(preview.descriptor);
      if (
        preview.profile ||
        ![
          ...manifestScreenshotSources(manifest).map((c) => c.url),
          ...(manifestIcon(manifest) ? iconSources(manifest) : []),
        ].includes(preview.url)
      )
        return null;
      return { ...preview, descriptor };
    }
    const ref = appReferences(manifest).find((r) => latestMetadata(r, [preview.descriptor]));
    if (!ref) return null;
    const descriptor = latestMetadata(ref, [preview.descriptor])!;
    const profile =
      preview.profile &&
      latestMetadata({ kind: 0, pubkey: descriptor.pubkey, identifier: '' }, [preview.profile]);
    if (preview.profile && !profile) return null;
    if (!descriptorImages(descriptor, profile).includes(preview.url)) return null;
    return { ...preview, descriptor, profile };
  } catch {
    return null;
  }
}
