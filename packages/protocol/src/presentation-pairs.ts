import { identityAddress, type SignedEvent } from './index';
import { appReferences, latestMetadata } from './preview';
import { manifestFormat } from './manifest';

/**
 * Presentation-only equality for already validated standalone manifests. The
 * same publisher, exact timestamp and every shared signed field must agree.
 * This is never an app identity, storage scope, backend grant or social scope.
 */
export function standalonePresentationKey(event: SignedEvent): string | null {
  if (![35129, 15129, 5129].includes(event.kind) || manifestFormat(event) !== 'standalone')
    return null;
  return JSON.stringify({
    author: event.pubkey,
    createdAt: event.created_at,
    content: event.content,
    tags: event.tags
      .filter((tag) => !['d', 'a', 'A'].includes(tag[0]))
      .map((tag) => JSON.stringify(tag))
      .sort(),
  });
}

/**
 * A release-specific, signed descriptor can name an author's current listing
 * even after a relay prunes the old named event. This is a display hint only;
 * callers must observe a live named target. It never changes snapshot identity.
 */
export function snapshotPresentationAddress(
  snapshot: SignedEvent,
  metadata: SignedEvent[] = [],
): string | null {
  if (snapshot.kind !== 5129 || manifestFormat(snapshot) !== 'standalone') return null;
  const addresses = new Set<string>();
  for (const ref of appReferences(snapshot)) {
    if (ref.kind !== 32267 || ref.pubkey !== snapshot.pubkey) continue;
    const descriptor = latestMetadata(ref, metadata);
    if (!descriptor || descriptor.created_at !== snapshot.created_at) continue;
    const names = descriptor.tags.filter((t) => t[0] === 'name');
    const titles = snapshot.tags.filter((t) => t[0] === 'title');
    if (names.length !== 1 || titles.length !== 1 || names[0][1] !== titles[0][1]) continue;
    const latest = descriptor.tags.filter((t) => t[0] === 'latest');
    if (latest.length !== 1 || latest[0].length < 2 || latest[0].length > 3) continue;
    const match = /^(35129|15129):([a-f0-9]{64}):(.*)$/.exec(latest[0][1]);
    if (!match || match[2] !== snapshot.pubkey) continue;
    try {
      addresses.add(
        identityAddress({
          kind: Number(match[1]) as 35129 | 15129,
          pubkey: match[2],
          identifier: match[3],
        }),
      );
    } catch {
      /* Malformed or ambiguous metadata cannot hide a publication. */
    }
  }
  return addresses.size === 1 ? [...addresses][0] : null;
}
