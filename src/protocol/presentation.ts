import type { SignedEvent } from './events.ts';

/** Optional Soy convention, not part of the pinned NIP-5D specification. */
export const MANIFEST_PRESENTATION_PROFILE = 'soy.presentation/1';
/**
 * Journal marker for releases written with standard NIP-5D presentation media and
 * the four-element `source-archive` (PR 2303 at c041f84). It is never a manifest
 * tag; frozen jobs keep the format they were created with.
 */
export const NIP5D_PRESENTATION_PROFILE = 'nip5d.presentation/c041f84';
export const DIRECT_PRESENTATION_PROFILES = [
  MANIFEST_PRESENTATION_PROFILE,
  NIP5D_PRESENTATION_PROFILE,
] as const;
type TaggedEvent = Pick<SignedEvent, 'kind' | 'tags'>;
export type PresentationClaim = { hash: string; mime: string | null };
/** A local display budget, not a NIP-5D screenshot cardinality restriction. */
export const MAX_MANIFEST_SCREENSHOTS = 8;
const hashPattern = /^[a-f0-9]{64}$/;
const mimePattern = /^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*$/i;

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
  // A duplicate clip is ambiguous; extra screenshots only exceed a display budget.
  if (name === 'preview' && tags.length > limit) return [];
  const result = new Map<string, PresentationClaim>();
  const ambiguous = new Set<string>();
  for (const tag of tags) {
    if (tag.length !== 3 || !hashPattern.test(tag[1]) || !mimes.includes(tag[2])) continue;
    if (ambiguous.has(tag[1])) continue;
    if (result.has(tag[1]) && result.get(tag[1])!.mime !== tag[2]) {
      ambiguous.add(tag[1]);
      result.delete(tag[1]);
      continue;
    }
    result.set(tag[1], { hash: tag[1], mime: tag[2] });
    if (result.size === limit) break;
  }
  return [...result.values()].filter((c) => !ambiguous.has(c.hash));
}

/**
 * NIP-5D Presentation media (PR 2303 at c041f84): NIP-92 `key value` fields split
 * at the first ASCII space, exactly one lowercase `x`, optional `m`/`dim`/`size`/
 * `alt`/`duration`. Unknown, malformed or repeated optional fields are ignored.
 * An absent or unusable `m` leaves format detection to the bounded decoder.
 */
export function nip5dMediaFields(tag: string[]) {
  const fields = new Map<string, string | null>();
  for (const entry of tag.slice(1)) {
    if (typeof entry !== 'string') return null;
    const split = entry.indexOf(' ');
    if (split < 1) {
      if (['x', 'm', 'dim', 'size', 'alt', 'duration'].includes(entry)) fields.set(entry, null);
      continue;
    }
    const key = entry.slice(0, split);
    // A repeated field is malformed; remember it as unusable.
    fields.set(key, fields.has(key) ? null : entry.slice(split + 1));
  }
  const hash = fields.get('x');
  if (!hash || !hashPattern.test(hash)) return null;
  const mime = fields.get('m');
  return {
    hash,
    mime: mime && mimePattern.test(mime) ? mime.toLowerCase() : null,
    alt: fields.get('alt') ?? null,
  };
}
function standardClaims(event: TaggedEvent, name: string, mimes: string[]) {
  if (![35129, 15129, 5129].includes(event.kind)) return [];
  const result: PresentationClaim[] = [];
  for (const tag of event.tags) {
    if (tag[0] !== name) continue;
    const fields = nip5dMediaFields(tag);
    if (!fields || (fields.mime !== null && !mimes.includes(fields.mime))) continue;
    if (result.some((claim) => claim.hash === fields.hash && claim.mime === fields.mime)) continue;
    result.push({ hash: fields.hash, mime: fields.mime });
  }
  return result;
}

const SCREENSHOT_MIMES = ['image/png', 'image/jpeg', 'image/webp'];
/** Standard NIP-5D screenshots in tag order, then the older Soy convention. */
export function manifestScreenshots(event: TaggedEvent): PresentationClaim[] {
  const standard = standardClaims(event, 'screenshot', SCREENSHOT_MIMES);
  const legacy = claims(event, 'screenshot', SCREENSHOT_MIMES, MAX_MANIFEST_SCREENSHOTS).filter(
    (claim) => !standard.some((other) => other.hash === claim.hash),
  );
  // Clients MAY display a subset; extra entries never suppress usable ones.
  return [...standard, ...legacy].slice(0, MAX_MANIFEST_SCREENSHOTS);
}
export function manifestPreviewVideo(event: TaggedEvent): PresentationClaim | null {
  // NIP-5D: if multiple preview tags are present, ignore the preview.
  const previewTags = event.tags.filter((t) => t[0] === 'preview');
  if (previewTags.length > 1) return null;
  if (previewTags.length === 1 && nip5dMediaFields(previewTags[0]))
    return standardClaims(event, 'preview', ['video/webm'])[0] ?? null;
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
