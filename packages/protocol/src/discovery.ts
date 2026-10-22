import { nip19, type Filter } from 'nostr-tools';
import { decodeAddress, encodeAddress, identityAddress } from './index';
import { manifestFormat } from './manifest';

/** Parse an identity, never fetch the pasted web URL. Relay hints remain untrusted. */
export function discoveryTarget(input: string) {
  if (input.length > 4096) throw new Error('Napplet address is too long');
  let value = input.trim().replace(/^nostr:/i, '');
  if (/^https?:\/\//i.test(value)) {
    const url = new URL(value);
    const match = /^\/(?:n|r)\/([^/]+)\/?$/.exec(url.pathname);
    if (!match) throw new Error('Paste a napplet naddr or a portable /n/ or /r/ link');
    value = decodeURIComponent(match[1]);
  }
  if (/^[a-f0-9]{64}$/.test(value))
    return {
      key: value,
      type: 'snapshot' as const,
      id: value,
      hints: [] as string[],
      path: `/r/${value}`,
    };
  const decoded = nip19.decode(value);
  if (decoded.type === 'naddr') {
    const identity = decodeAddress(value);
    return {
      key: identityAddress(identity),
      type: 'address' as const,
      naddr: encodeAddress(identity, decoded.data.relays?.slice(0, 4)),
      hints: (decoded.data.relays ?? []).slice(0, 4),
      path: `/n/${value}`,
    };
  }
  if (decoded.type === 'note' || decoded.type === 'nevent') {
    const id = decoded.type === 'note' ? decoded.data : decoded.data.id;
    return {
      key: id,
      type: 'snapshot' as const,
      id,
      hints: decoded.type === 'nevent' ? (decoded.data.relays ?? []).slice(0, 4) : [],
      path: `/r/${id}`,
    };
  }
  throw new Error('Expected a napplet naddr, note or nevent');
}
export type DiscoveryTarget = ReturnType<typeof discoveryTarget>;

export type TargetedDiscovery = {
  archetypes?: readonly string[];
  intents?: readonly string[];
  requiredDomains?: readonly string[];
  optionalDomains?: readonly string[];
};
export type IntersectionDiscoveryFilter = Filter & {
  '&z'?: string[];
  '&i'?: string[];
  '&R'?: string[];
  '&O'?: string[];
};

/**
 * Target advertisements selected by a user, not "all supported napplets".
 * # filters use OR within one tag; every result still needs local matching and
 * its complete R set checked. Opt-in NIP-91 intersections always retain a
 * standard NIP-01 fallback in the same filter for relays that do not implement
 * NIP-91 (PR2252 b93bda29d45998866e81c65e0693616294a78672).
 */
export function targetedDiscoveryFilters(
  target: TargetedDiscovery,
  options: { intersections?: boolean; legacyRequirements?: boolean; limit?: number } = {},
): { primary: IntersectionDiscoveryFilter[]; fallback: Filter[] } {
  const base: Filter = {
    kinds: [35129, 15129, 5129],
    limit: Math.max(1, Math.min(300, options.limit ?? 100)),
  };
  const standard: Filter = { ...base };
  const intersection: IntersectionDiscoveryFilter = { ...base };
  let useIntersection = false;
  for (const [tag, values] of [
    ['z', target.archetypes],
    ['i', target.intents],
    ['R', target.requiredDomains],
    ['O', target.optionalDomains],
  ] as const) {
    const selected = [
      ...new Set((values ?? []).filter((value) => value && value.length <= 1024)),
    ].slice(0, 16);
    if (!selected.length) continue;
    standard[`#${tag}`] = selected;
    intersection[`#${tag}`] = selected;
    if (options.intersections && selected.length > 1) {
      intersection[`&${tag}`] = selected;
      useIntersection = true;
    }
  }
  const legacy: Filter[] = [];
  if (options.legacyRequirements && standard['#R']?.length && !standard['#O']?.length) {
    // Legacy requires is not a single-letter indexed tag. Keep other narrowing
    // and the same per-filter budget, then check normalized requirements locally.
    // An O selection cannot match an admitted legacy manifest, so needs no fallback.
    const { '#R': _required, ...candidate } = standard;
    legacy.push(candidate);
  }
  return {
    primary: [useIntersection ? intersection : standard, ...legacy],
    fallback: [standard, ...legacy],
  };
}

/** Apply the requested local intersection even when a relay ignores the optional & keys. */
export function matchesDiscoveryTarget(
  event: { tags: readonly (readonly string[])[] },
  target: TargetedDiscovery,
) {
  const requiredTag =
    manifestFormat({ tags: event.tags.map((tag) => [...tag]) }) === 'legacy' ? 'requires' : 'R';
  return (
    [
      ['z', target.archetypes],
      ['i', target.intents],
      [requiredTag, target.requiredDomains],
      ['O', target.optionalDomains],
    ] as const
  ).every(([tag, values]) =>
    (values ?? []).every((value) =>
      event.tags.some((entry) => entry[0] === tag && entry[1] === value),
    ),
  );
}
