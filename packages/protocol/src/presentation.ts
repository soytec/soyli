import type { SignedEvent } from './index';
import type { ManifestIcon } from './manifest';

/** Optional Soy convention, not part of the pinned NIP-5D specification. */
export const MANIFEST_PRESENTATION_PROFILE = 'soy.presentation/1';
type TaggedEvent = Pick<SignedEvent, 'kind' | 'tags'>;
export type PresentationClaim = { hash: string; mime: string };
const hashPattern = /^[a-f0-9]{64}$/;

function claims(event: TaggedEvent, name: string, mimes: string[], limit: number) {
  const profiles = event.tags.filter((t) => t[0] === 'presentation');
  if (
    ![35129, 15129, 5129].includes(event.kind) ||
    profiles.length !== 1 ||
    profiles[0].length !== 2 ||
    profiles[0][1] !== MANIFEST_PRESENTATION_PROFILE
  )
    return [];
  const tags = event.tags.filter((t) => t[0] === name);
  // Ambiguous/oversized optional declarations are ignored, never playback failures.
  if (tags.length > limit) return [];
  const result = new Map<string, PresentationClaim>();
  const ambiguous = new Set<string>();
  for (const tag of tags) {
    if (tag.length !== 3 || !hashPattern.test(tag[1]) || !mimes.includes(tag[2])) continue;
    if (result.has(tag[1]) && result.get(tag[1])!.mime !== tag[2]) ambiguous.add(tag[1]);
    result.set(tag[1], { hash: tag[1], mime: tag[2] });
  }
  return [...result.values()].filter((c) => !ambiguous.has(c.hash));
}

export function manifestScreenshots(event: TaggedEvent): ManifestIcon[] {
  return claims(
    event,
    'screenshot',
    ['image/png', 'image/jpeg', 'image/webp'],
    4,
  ) as ManifestIcon[];
}
export function manifestPreviewVideo(event: TaggedEvent): PresentationClaim | null {
  return claims(event, 'preview', ['video/webm'], 1)[0] ?? null;
}

/** Hash-only destinations, with the same declared-origin shape as NIP-5D icons.
 * The consumer still applies public DNS/network policy (or explicit local mode). */
export function presentationSources(event: Pick<SignedEvent, 'tags'>, hash: string): string[] {
  if (!hashPattern.test(hash)) return [];
  return [
    ...new Set(
      event.tags
        .filter((t) => t[0] === 'server')
        .flatMap((t) => {
          try {
            const url = new URL(t[1]);
            if (
              t.length !== 2 ||
              !['https:', 'http:'].includes(url.protocol) ||
              url.username ||
              url.password ||
              url.pathname !== '/' ||
              url.search ||
              url.hash
            )
              return [];
            return [`${url.origin}/${hash}`];
          } catch {
            return [];
          }
        }),
    ),
  ].slice(0, 8);
}
export function manifestScreenshotSources(event: TaggedEvent) {
  return manifestScreenshots(event).flatMap((claim) =>
    presentationSources(event, claim.hash).map((url) => ({ ...claim, url })),
  );
}
export function manifestVideoSources(event: TaggedEvent) {
  const claim = manifestPreviewVideo(event);
  return claim ? presentationSources(event, claim.hash).map((url) => ({ ...claim, url })) : [];
}
