import ipaddr from 'ipaddr.js';
import { nip19, type Filter, type EventTemplate } from 'nostr-tools';
import {
  MAX_READ_ARTIFACT_BYTES,
  verifiedEvent,
  sha256,
  encodeAddress,
  type SignedEvent,
} from '../../protocol/src';
import {
  legacySnapshotAddress,
  validateManifest,
  validateRelease,
} from '../../protocol/src/manifest';
import { appReferences, descriptorImages } from '../../protocol/src/preview';
import { descriptorVideos } from '../../protocol/src/preview-video';
import { manifestScreenshots, manifestPreviewVideo } from '../../protocol/src/presentation';
import { standalonePresentationKey } from '../../protocol/src/presentation-pairs';
import { repositoryRef } from '../../collaboration/src/protocol';
import { diagnose, DiagnosticError } from '../../diagnostics/src';
import type { LifecycleIO, LifecycleSigner } from './transport';

export type Operation = 'unpublish' | 'republish' | 'delete';
export type BlobItem = { origin: string; hash: string; labels: string[]; retained?: string };
export type RepoItem = { address: string; relay: string; clone: string; retained?: string };
export type LifecyclePlan = {
  version: 1;
  key: string;
  author: string;
  title: string;
  manifest: SignedEvent;
  manifests: SignedEvent[];
  /** Exact verified pairs selected only for this author-confirmed deletion inventory. */
  snapshotPairs?: { current: string; snapshot: string }[];
  metadata: SignedEvent[];
  sharedMetadata: string[];
  relays: string[];
  cutoff: number;
  blobs: BlobItem[];
  repositories: RepoItem[];
  warnings: string[];
  complete: boolean;
};
export type Step = {
  id: string;
  label: string;
  target: string;
  state: 'pending' | 'running' | 'done' | 'retained' | 'requested' | 'failed';
  message?: string;
};
export type LifecycleReceipt = {
  version: 1;
  operation: Operation;
  plan: LifecyclePlan;
  events: Record<string, SignedEvent>;
  steps: Step[];
  createdAt: number;
};
const tag = (e: SignedEvent, name: string) => e.tags.find((t) => t[0] === name)?.[1];
const unique = <T>(items: T[]) => [...new Set(items)];
const latest = (events: SignedEvent[]) =>
  [...events].sort((a, b) => b.created_at - a.created_at || a.id.localeCompare(b.id))[0];
export function nappletKey(e: SignedEvent) {
  e = verifiedEvent(e);
  if (e.kind === 5129) return legacySnapshotAddress(e) ?? e.id;
  if (![35129, 15129].includes(e.kind)) throw new Error('Expected a napplet manifest.');
  return `${e.kind}:${e.pubkey}:${e.kind === 15129 ? '' : (tag(e, 'd') ?? '')}`;
}
export function lifecycleUrl(plan: LifecyclePlan) {
  const parts = /^(35129|15129):([a-f0-9]{64}):(.*)$/.exec(plan.key);
  return parts
    ? `/n/${encodeAddress({ kind: Number(parts[1]) as 35129 | 15129, pubkey: parts[2], identifier: parts[3] }, plan.relays.slice(0, 8))}`
    : `/r/${plan.manifest.id}`;
}
export function lifecycleEndpoint(value: string, kind: 'relay' | 'http', local = false) {
  const url = new URL(value);
  const host = url.hostname.replace(/^\[|\]$/g, '').replace(/\.$/, '');
  const privateHost = ipaddr.isValid(host)
    ? ipaddr.process(host).range() !== 'unicast'
    : !host.includes('.') || /\.(localhost|local|internal|home|test|invalid)$/.test(host);
  const loopback = local && ['127.0.0.1', '[::1]'].includes(url.hostname);
  if (
    (privateHost && !loopback) ||
    value.length > 4096 ||
    url.username ||
    url.password ||
    url.hash ||
    url.search ||
    !(
      (kind === 'relay' ? url.protocol === 'wss:' : url.protocol === 'https:') ||
      (local &&
        ['127.0.0.1', '[::1]', 'localhost'].includes(url.hostname) &&
        (kind === 'relay' ? url.protocol === 'ws:' : url.protocol === 'http:'))
    )
  )
    throw new Error('Use public HTTPS/WSS services, or explicit loopback services in local mode.');
  return url.href.replace(/\/$/, '');
}
export function ownedDeletion(e: SignedEvent, target: SignedEvent) {
  return (
    e.kind === 5 &&
    e.pubkey === target.pubkey &&
    e.created_at >= target.created_at &&
    e.tags.some(
      (t) =>
        (t[0] === 'e' && t[1] === target.id) ||
        (t[0] === 'a' && target.kind !== 5129 && t[1] === nappletKey(target)),
    )
  );
}
async function lifecyclePair(current: SignedEvent, snapshot: SignedEvent) {
  const release = await validateRelease(current, snapshot);
  const presentation = standalonePresentationKey(current);
  if (presentation && presentation !== standalonePresentationKey(snapshot))
    throw new Error('Publication pair does not have the same signed presentation and timestamp.');
  return release;
}
/** Inventory is read-only. Nothing is signed until the caller explicitly confirms a plan. */
export async function planLifecycle(input: {
  manifest: SignedEvent;
  relays: string[];
  io: LifecycleIO;
  local?: boolean;
  operation?: Operation;
  saved?: SignedEvent[];
  history?: { manifests: SignedEvent[]; complete: boolean; warnings: string[] };
  snapshotPairs?: { current: SignedEvent; snapshot: SignedEvent }[];
  metadata?: SignedEvent[];
  extraBlobs?: { origin: string; hash: string; label: string }[];
  /** Linked repositories recorded in the local publication journal: retain only. */
  retainedRepositories?: string[];
}): Promise<LifecyclePlan> {
  await validateManifest(input.manifest);
  const manifest = verifiedEvent(input.manifest),
    key = nappletKey(manifest),
    author = manifest.pubkey;
  const relays = unique(input.relays.map((r) => lifecycleEndpoint(r, 'relay', input.local)));
  if (relays.length > 256)
    throw new DiagnosticError(
      'LIFECYCLE_RELAYS',
      'The known publication destinations exceed the 256-relay inventory limit. No destinations were silently dropped.',
    );
  if (!relays.length) throw new Error('Choose at least one relay.');
  const warnings: string[] = [...(input.history?.warnings ?? [])];
  let complete = input.history?.complete ?? true;
  if ((input.history?.manifests.length ?? 0) > 256)
    throw new Error('Retained publication history exceeded its inventory limit.');
  const events = new Map<string, SignedEvent>();
  const snapshotPairs: NonNullable<LifecyclePlan['snapshotPairs']> = [];
  if ((input.snapshotPairs?.length ?? 0) > 128)
    throw new Error('Too many saved publication pairs.');
  for (const pair of input.snapshotPairs ?? []) {
    const release = await lifecyclePair(pair.current, pair.snapshot);
    if (release.address !== key || pair.current.pubkey !== author)
      throw new Error('Saved publication pair belongs to another napplet.');
    events.set(pair.current.id, pair.current);
    events.set(pair.snapshot.id, pair.snapshot);
    if (!snapshotPairs.some((existing) => existing.snapshot === pair.snapshot.id))
      snapshotPairs.push({ current: pair.current.id, snapshot: pair.snapshot.id });
  }
  const pairedSnapshots = new Set(snapshotPairs.map((pair) => pair.snapshot));
  const belongs = (event: SignedEvent) =>
    nappletKey(event) === key || pairedSnapshots.has(event.id);
  for (const value of [
    manifest,
    ...(input.saved ?? []),
    ...(input.history?.manifests ?? []),
    ...(input.metadata ?? []),
  ]) {
    const e = verifiedEvent(value);
    if (e.pubkey === author) events.set(e.id, e);
  }
  const read = async (relay: string, filter: Filter) => {
    try {
      const found = await input.io.read(relay, filter);
      for (const e of found) events.set(e.id, verifiedEvent(e));
      return found;
    } catch (error) {
      complete = false;
      warnings.push(`${relay}: ${diagnose(error).message}`);
      return [];
    }
  };
  // Other creations from this author protect reused assets and repositories.
  await Promise.all(
    relays.map((r) => read(r, { authors: [author], kinds: [35129, 15129, 5129, 5], limit: 500 })),
  );
  const verified: SignedEvent[] = [];
  for (const e of events.values())
    if ([35129, 15129, 5129].includes(e.kind) && e.pubkey === author) {
      try {
        await validateManifest(e);
        verified.push(e);
      } catch {
        /* Other, invalid publications do not enter the deletion scope. */
      }
    }
  // A fresh client can review exact pairs without a publisher journal. Matching
  // bytes or ancestry alone never selects a snapshot, and selecting an
  // independent snapshot never expands the inventory to a named parent.
  const presentations = new Map<string, SignedEvent>();
  for (const event of verified) {
    const presentation =
      event.kind !== 5129 && nappletKey(event) === key && standalonePresentationKey(event);
    if (presentation) presentations.set(presentation, event);
  }
  for (const snapshot of verified) {
    if (snapshot.kind !== 5129 || pairedSnapshots.has(snapshot.id)) continue;
    const presentation = standalonePresentationKey(snapshot);
    const current = presentation && presentations.get(presentation);
    if (!current) continue;
    if (snapshotPairs.length >= 128) {
      complete = false;
      warnings.push(
        'Exact publication pairs exceeded the 128-pair inventory limit. Remaining snapshots and hosted files are retained.',
      );
      continue;
    }
    await lifecyclePair(current, snapshot);
    snapshotPairs.push({ current: current.id, snapshot: snapshot.id });
    pairedSnapshots.add(snapshot.id);
  }
  const manifests = verified.filter(belongs),
    others = verified.filter((event) => !belongs(event));
  if (manifests.length > 500)
    throw new Error(
      'Publication inventory exceeds 500 releases. Narrow the selection before deleting.',
    );
  const current = latest(manifests.filter((e) => e.kind !== 5129)) ?? manifest;
  if (!manifests.length) throw new Error('No verified releases in the selected publication.');
  const inventoryFiles = !input.operation || input.operation === 'delete';
  const allRefs = unique(
    (inventoryFiles ? [...manifests, ...others] : []).flatMap((e) =>
      appReferences(e)
        .filter((r) => r.pubkey === author)
        .map((r) => `${r.kind}:${r.pubkey}:${r.identifier}`),
    ),
  );
  if (allRefs.length > 160) {
    complete = false;
    warnings.push('Too many linked descriptors for a complete inventory. Assets will be retained.');
  }
  for (let start = 0; start < Math.min(allRefs.length, 160); start += 16) {
    const refs = allRefs.slice(start, start + 16).map((a) => {
      const [kind, pubkey, ...id] = a.split(':');
      return { kind: Number(kind), pubkey, identifier: id.join(':') };
    });
    await Promise.all(
      relays.map((r) =>
        read(r, {
          authors: [author],
          kinds: unique(refs.map((v) => v.kind)),
          '#d': refs.map((v) => v.identifier),
          limit: 100,
        }),
      ),
    );
  }
  const metadataFor = (m: SignedEvent) => {
    const refs = new Set(
      appReferences(m)
        .filter((r) => r.pubkey === author)
        .map((r) => `${r.kind}:${r.pubkey}:${r.identifier}`),
    );
    return [...events.values()].filter(
      (e) => e.pubkey === author && refs.has(`${e.kind}:${e.pubkey}:${tag(e, 'd') ?? ''}`),
    );
  };
  const metadata = unique(manifests.flatMap(metadataFor));
  const sharedMetadata = unique(
    others.flatMap((m) => appReferences(m).map((r) => `${r.kind}:${r.pubkey}:${r.identifier}`)),
  );
  const blobs = new Map<string, BlobItem>(),
    protectedHashes = new Set<string>();
  let resourceInventoryComplete = true;
  const add = (origin: string, hash: string, label: string, other = false) => {
    if (!/^[a-f0-9]{64}$/.test(hash)) return;
    try {
      origin = lifecycleEndpoint(origin, 'http', input.local);
      if (other) {
        protectedHashes.add(hash);
        return;
      }
      const id = `${origin}/${hash}`,
        old = blobs.get(id);
      if (old) old.labels = unique([...old.labels, label]);
      else blobs.set(id, { origin, hash, labels: [label] });
    } catch {
      if (!other) warnings.push(`Unmanaged ${label}: no supported Blossom URL.`);
    }
  };
  const addURL = (url: string | undefined, label: string, other = false) => {
    if (!url) return;
    try {
      const u = new URL(url),
        path = /^(.*\/)([a-f0-9]{64})(?:\.[a-z0-9]+)?$/.exec(u.pathname);
      if (path) {
        lifecycleEndpoint(url, 'http', input.local);
        add(`${u.origin}${path[1]}`, path[2], label, other);
      } else if (!other)
        warnings.push(
          `${label} is not a content-addressed Blossom link; retain it on its original host.`,
        );
    } catch {
      if (!other) warnings.push(`${label} is not a supported managed URL.`);
    }
  };
  const inventory = async (m: SignedEvent, other = false) => {
    const release = await validateManifest(m);
    for (const server of release.servers) {
      add(server, release.artifactHash, 'Build /index.html', other);
      if (release.icon) add(server, release.icon.hash, 'Icon', other);
      for (const image of manifestScreenshots(m)) add(server, image.hash, 'Preview image', other);
      const video = manifestPreviewVideo(m);
      if (video) add(server, video.hash, 'Preview video', other);
    }
    addURL(tag(m, 'source-archive'), 'Source archive', other);
    for (const d of metadataFor(m)) {
      for (const u of descriptorImages(d)) addURL(u, 'Preview image', other);
      for (const v of descriptorVideos(d)) addURL(v.url, 'Preview video', other);
    }
  };
  if (inventoryFiles) {
    for (const m of manifests) await inventory(m);
    for (const m of others) await inventory(m, true);
  }
  for (const b of inventoryFiles ? (input.extraBlobs ?? []) : []) add(b.origin, b.hash, b.label);
  // External resources are referenced in signed HTML. Read, hash-check, never execute it.
  const runtimeCache = new Map<string, Promise<string[] | null>>();
  const queue = inventoryFiles ? unique([...manifests, ...others]).slice(0, 500) : [];
  await Promise.all(
    Array.from({ length: Math.min(4, queue.length) }, async () => {
      while (queue.length) {
        const m = queue.shift()!;
        const release = await validateManifest(m);
        const cacheKey = JSON.stringify([release.artifactHash, release.servers]);
        if (!runtimeCache.has(cacheKey))
          runtimeCache.set(
            cacheKey,
            (async () => {
              for (const s of release.servers)
                try {
                  const url = `${lifecycleEndpoint(s, 'http', input.local)}/${release.artifactHash}`;
                  const response = await input.io.fetch(url);
                  if (!response.ok) {
                    await response.body?.cancel();
                    continue;
                  }
                  const bytes = await boundedBytes(response, MAX_READ_ARTIFACT_BYTES);
                  if ((await sha256(bytes)) !== release.artifactHash) continue;
                  return unique(
                    [
                      ...new TextDecoder().decode(bytes).matchAll(/blossom:sha256:([a-f0-9]{64})/g),
                    ].map((v) => v[1]),
                  );
                } catch {
                  /* Try the next signed server hint. */
                }
              return null;
            })(),
          );
        const hashes = await runtimeCache.get(cacheKey)!;
        if (hashes)
          for (const hash of hashes)
            for (const server of release.servers) add(server, hash, 'Runtime asset', !belongs(m));
        else {
          if (!belongs(m)) resourceInventoryComplete = false;
          complete = false;
          warnings.push(
            `Runtime assets could not be enumerated for ${tag(m, 'title') ?? m.id.slice(0, 12)}. Files are retained until a complete inventory is available.`,
          );
        }
      }
    }),
  );
  const repositories: RepoItem[] = [];
  for (const source of unique(
    (inventoryFiles ? manifests : []).map((m) => tag(m, 'source')).filter((s): s is string => !!s),
  )) {
    try {
      const ref = repositoryRef(source);
      if (ref.pubkey !== author) {
        warnings.push('Original author’s repository is retained.');
        continue;
      }
      const shared = others.some((m) => {
        try {
          return repositoryRef(tag(m, 'source') ?? '').address === ref.address;
        } catch {
          return false;
        }
      });
      // A matching name is not evidence that soyLI created the repository. The
      // author's signed linked-source policy (or local journal) takes precedence.
      const linked =
        ref.identifier !== key.split(':').slice(2).join(':') ||
        input.retainedRepositories?.includes(ref.address) ||
        manifests.some((m) =>
          m.tags.some(
            (t) => t[0] === 'soy-source-repository' && t[1] === ref.address && t[2] === 'linked',
          ),
        );
      for (const r of ref.relays) {
        const relay = lifecycleEndpoint(r, 'relay', input.local);
        const announcements = await read(relay, {
          authors: [author],
          kinds: [30617],
          '#d': [ref.identifier],
          limit: 50,
        });
        const a = latest(announcements);
        const clone =
          a?.tags.find((t) => t[0] === 'clone')?.[1] ??
          `${relay.replace(/^ws/, 'http')}/${nip19.npubEncode(author)}/${encodeURIComponent(ref.identifier)}.git`;
        repositories.push({
          address: ref.address,
          relay,
          clone,
          ...(shared
            ? { retained: 'Used by another napplet from this author.' }
            : linked
              ? { retained: 'Your own source repository is kept; soyLI did not create it.' }
              : {}),
        });
      }
      if (!ref.relays.length)
        warnings.push('Repository has no GRASP relay hint; remove it using its Git host.');
    } catch {
      warnings.push('Source repository is on an unmanaged host; it is not automatically deleted.');
    }
  }
  for (const b of blobs.values())
    if (protectedHashes.has(b.hash)) b.retained = 'Referenced by another napplet from this author.';
  if (!resourceInventoryComplete)
    for (const b of blobs.values())
      b.retained ??=
        'Another creation’s runtime assets could not be checked. Retained to avoid breaking it.';
  if (!complete) {
    for (const b of blobs.values())
      b.retained ??= 'Inventory incomplete. Retry discovery before deleting hosted files.';
    for (const r of repositories)
      r.retained ??= 'Inventory incomplete. Retry discovery before deleting the repository.';
  }
  const cutoff = Math.max(
    Math.floor(Date.now() / 1000),
    ...[...manifests, ...metadata].map((e) => e.created_at),
  );
  return {
    version: 1,
    key,
    author,
    title: (tag(current, 'title') ?? 'Untitled napplet').slice(0, 160),
    manifest: current,
    manifests,
    ...(snapshotPairs.length ? { snapshotPairs } : {}),
    metadata,
    sharedMetadata,
    relays,
    cutoff,
    blobs: [...blobs.values()],
    repositories,
    warnings: unique(warnings),
    complete,
  };
}
export async function boundedBytes(response: Response, max: number) {
  const reader = response.body?.getReader();
  if (!reader) return new Uint8Array();
  const parts: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const p = await reader.read();
      if (p.done) break;
      size += p.value.length;
      if (size > max) throw new Error('Service response exceeded byte limit.');
      parts.push(p.value);
    }
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
  const out = new Uint8Array(size);
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}
export function createLifecycleReceipt(
  plan: LifecyclePlan,
  operation: Operation,
): LifecycleReceipt {
  const steps: Step[] = plan.relays.map((target) => ({
    id: `relay:${target}`,
    label:
      operation === 'republish'
        ? 'Publish fresh listing'
        : operation === 'delete'
          ? 'Remove listings, releases and unshared metadata'
          : 'Unpublish listing and known releases',
    target,
    state: 'pending',
  }));
  if (operation === 'delete') {
    steps.push(
      ...plan.blobs.map((b) => ({
        id: `blob:${b.origin}/${b.hash}`,
        label: b.labels.join(' · '),
        target: `${b.origin}/${b.hash}`,
        state: b.retained ? ('retained' as const) : ('pending' as const),
        message: b.retained,
      })),
    );
    steps.push(
      ...plan.repositories.map((r) => ({
        id: `repo:${r.relay}:${r.address}`,
        label: 'Git repository',
        target: r.clone,
        state: r.retained ? ('retained' as const) : ('pending' as const),
        message: r.retained,
      })),
    );
  }
  return { version: 1, operation, plan, events: {}, steps, createdAt: Date.now() };
}
async function signed(signer: LifecycleSigner, author: string, template: EventTemplate) {
  const event = verifiedEvent(await signer.signEvent(template));
  if (
    event.pubkey !== author ||
    event.kind !== template.kind ||
    event.created_at !== template.created_at ||
    event.content !== template.content ||
    JSON.stringify(event.tags) !== JSON.stringify(template.tags)
  )
    throw new Error('Signer returned a different identity or changed the requested event.');
  return event;
}
async function authorization(
  signer: LifecycleSigner,
  author: string,
  origin: string,
  hash: string,
) {
  const now = Math.floor(Date.now() / 1000);
  const event = await signed(signer, author, {
    kind: 24242,
    created_at: now - 1,
    content: 'Delete selected napplet upload',
    tags: [
      ['t', 'delete'],
      ['x', hash],
      ['server', new URL(origin).hostname],
      ['expiration', String(now + 300)],
    ],
  });
  // Browser and standalone CLI use exactly the same wire format.
  const bytes = new TextEncoder().encode(JSON.stringify(event));
  return `Nostr ${btoa(Array.from(bytes, (b) => String.fromCharCode(b)).join(''))}`;
}
/** Caller must obtain explicit confirmation first; save is awaited before each side effect. */
export async function executeLifecycle(
  receipt: LifecycleReceipt,
  options: {
    signer: LifecycleSigner;
    io: LifecycleIO;
    save: (receipt: LifecycleReceipt) => Promise<void>;
    local?: boolean;
  },
) {
  const { plan, operation } = receipt,
    { signer, io } = options;
  let saving = Promise.resolve();
  const save = async (r: LifecycleReceipt) => {
    const snapshot = structuredClone(r);
    const next = saving.then(() => options.save(snapshot));
    saving = next;
    await next;
  };
  parseReceipt(receipt);
  if (plan.cutoff > Date.now() / 1000 + 60)
    throw new Error(
      'The confirmation timestamp is ahead of this clock. Inspect a fresh inventory.',
    );
  await validateManifest(plan.manifest);
  if (plan.author !== plan.manifest.pubkey || plan.key !== nappletKey(plan.manifest))
    throw new Error('Invalid saved lifecycle identity.');
  for (const pair of plan.snapshotPairs ?? []) {
    const current = plan.manifests.find((event) => event.id === pair.current)!;
    const snapshot = plan.manifests.find((event) => event.id === pair.snapshot)!;
    const release = await lifecyclePair(current, snapshot);
    if (release.address !== plan.key) throw new Error('Saved publication pair changed identity.');
  }
  // Validate persisted destinations again, even when retrying after a restart.
  for (const relay of plan.relays) lifecycleEndpoint(relay, 'relay', options.local);
  const signOnce = async (key: string, template: EventTemplate) => {
    if (!receipt.events[key]) {
      receipt.events[key] = await signed(signer, plan.author, template);
      await save(receipt);
    }
    const e = verifiedEvent(receipt.events[key]);
    if (
      e.pubkey !== plan.author ||
      e.kind !== template.kind ||
      e.content !== template.content ||
      JSON.stringify(e.tags) !== JSON.stringify(template.tags)
    )
      throw new Error('Saved request does not match the confirmed selection.');
    return e;
  };
  // Refuse stale confirmations after another tab or publisher advances this identity.
  const currentKind = Number(plan.key.split(':')[0]);
  if ([35129, 15129].includes(currentKind)) {
    const current = await io.read(plan.relays[0], {
      authors: [plan.author],
      kinds: [currentKind],
      ...(currentKind === 35129 ? { '#d': [plan.key.split(':').slice(2).join(':')] } : {}),
      limit: 20,
    });
    if (
      current.some(
        (e) => !plan.manifests.some((m) => m.id === e.id) && e.id !== receipt.events.listing?.id,
      )
    )
      throw new DiagnosticError(
        'LIFECYCLE_STALE',
        'A newer or different listing exists. Inspect a fresh inventory before proceeding.',
      );
  }
  let main: SignedEvent;
  if (operation === 'republish') {
    const release = await validateManifest(plan.manifest);
    let present = false;
    for (const server of release.servers)
      try {
        const response = await io.fetch(
          `${lifecycleEndpoint(server, 'http', options.local)}/${release.artifactHash}`,
        );
        if (!response.ok) {
          await response.body?.cancel();
          continue;
        }
        if (
          (await sha256(await boundedBytes(response, MAX_READ_ARTIFACT_BYTES))) ===
          release.artifactHash
        ) {
          present = true;
          break;
        }
      } catch {
        /* Try each signed hint; do not publish an unavailable build. */
      }
    if (!present)
      throw new DiagnosticError(
        'REPUBLISH_FILES_MISSING',
        'The saved build is no longer available. Publish again from your local source project to re-upload it.',
      );
    const deletions = await io.read(plan.relays[0], {
      authors: [plan.author],
      kinds: [5],
      '#a': [plan.key],
      limit: 200,
    });
    if (
      receipt.events.listing &&
      deletions.some((e) => e.created_at >= receipt.events.listing.created_at)
    )
      throw new Error(
        'This recovery attempt was superseded by another unpublish. Inspect a fresh inventory.',
      );
    const timestamp = Math.max(
      Math.floor(Date.now() / 1000),
      plan.cutoff + 1,
      ...deletions.map((e) => e.created_at + 1),
    );
    if (timestamp > Date.now() / 1000 + 60)
      throw new Error(
        'Deletion timestamp is ahead of this clock. Correct the clock before republishing.',
      );
    const kind = Number(plan.key.split(':')[0]);
    if (![35129, 15129].includes(kind))
      throw new Error(
        'This standalone snapshot has no stable address. Publish it again from its source project.',
      );
    const tags =
      plan.manifest.kind === 5129
        ? plan.manifest.tags.filter((t) => t[0] !== 'a')
        : [...plan.manifest.tags];
    if (kind === 35129 && plan.manifest.kind === 5129)
      tags.push(['d', plan.key.split(':').slice(2).join(':')]);
    main = await signOnce('listing', {
      kind,
      created_at: timestamp,
      content: plan.manifest.content,
      tags,
    });
  } else {
    const descriptors =
      operation === 'delete'
        ? plan.metadata.filter(
            (e) => !plan.sharedMetadata.includes(`${e.kind}:${e.pubkey}:${tag(e, 'd') ?? ''}`),
          )
        : [];
    const targets = [...plan.manifests, ...descriptors];
    const tags: string[][] = [
      ...(plan.key.includes(':') ? [['a', plan.key]] : []),
      ...unique(targets.map((e) => e.id)).map((id) => ['e', id]),
      ...unique(targets.map((e) => String(e.kind))).map((k) => ['k', k]),
    ];
    main = await signOnce('deletion', {
      kind: 5,
      created_at: plan.cutoff,
      content: 'Unpublished by the author',
      tags,
    });
  }
  const run = async (step: Step, fn: () => Promise<{ state: Step['state']; message: string }>) => {
    if (['done', 'retained'].includes(step.state)) return;
    step.state = 'running';
    step.message = undefined;
    await save(receipt);
    try {
      Object.assign(step, await fn());
    } catch (error) {
      step.state = 'failed';
      const d = diagnose(error);
      step.message = [d.message, ...(d.details ?? []), d.recovery].join(' ');
    }
    await save(receipt);
  };
  await Promise.all(
    receipt.steps
      .filter((s) => s.id.startsWith('relay:'))
      .map((s) =>
        run(s, async () => {
          await io.publish(s.target, main);
          if (operation === 'republish') {
            const visible = await io.read(s.target, { ids: [main.id], limit: 2 });
            return visible.some((e) => e.id === main.id)
              ? { state: 'done', message: 'Fresh listing confirmed. Same napplet address.' }
              : {
                  state: 'requested',
                  message: 'Accepted; listing visibility is not confirmed yet. Retry to check.',
                };
          }
          const remaining = await io.read(s.target, {
            authors: [plan.author],
            kinds: [35129, 15129, 5129, 31990, 32267],
            limit: 500,
          });
          const present = remaining.some(
            (e) =>
              main.tags.some((t) => t[0] === 'e' && t[1] === e.id) ||
              ([35129, 15129].includes(e.kind) &&
                nappletKey(e) === plan.key &&
                e.created_at <= plan.cutoff),
          );
          return present
            ? {
                state: 'requested',
                message:
                  'Deletion request accepted; this relay still serves a selected release. Retry to check.',
              }
            : { state: 'done', message: 'Selected listings no longer served by this relay.' };
        }),
      ),
  );
  if (operation !== 'delete') return receipt;
  if (!receipt.steps.some((s) => s.id.startsWith('relay:') && s.state === 'done')) return receipt;
  // Independent rows remain retryable. At most one destructive storage request runs at a time.
  for (const b of plan.blobs) {
    const step = receipt.steps.find((s) => s.id === `blob:${b.origin}/${b.hash}`)!;
    await run(step, async () => {
      lifecycleEndpoint(b.origin, 'http', options.local);
      if (!/^[a-f0-9]{64}$/.test(b.hash)) throw new Error('Invalid blob hash.');
      const response = await io.fetch(step.target, {
        method: 'DELETE',
        headers: { Authorization: await authorization(signer, plan.author, b.origin, b.hash) },
      });
      await response.body?.cancel();
      if (![200, 204, 404].includes(response.status))
        throw new DiagnosticError('BLOB_DELETE', 'Blossom refused to delete this upload.', {
          target: b.origin,
          status: response.status,
          detail: response.headers.get('x-reason') ?? undefined,
          recovery: 'Use the uploader identity, check the server policy and retry this file.',
        });
      const check = await io.fetch(step.target, { method: 'HEAD' });
      await check.body?.cancel();
      if (check.status === 404)
        return { state: 'done', message: 'File is no longer served by this Blossom server.' };
      if (check.ok && [200, 204].includes(response.status))
        return {
          state: 'retained',
          message:
            'Your deletion was accepted; shared bytes or server-retained copies remain available.',
        };
      return {
        state: 'requested',
        message: `Delete accepted; absence not confirmed (HEAD ${check.status}). Retry to check.`,
      };
    });
  }
  for (const repo of plan.repositories) {
    const step = receipt.steps.find((s) => s.id === `repo:${repo.relay}:${repo.address}`)!;
    await run(step, async () => {
      lifecycleEndpoint(repo.relay, 'relay', options.local);
      if (!repo.address.startsWith(`30617:${plan.author}:`))
        throw new Error('Cannot delete another author’s repository.');
      const e = await signOnce(step.id, {
        kind: 5,
        created_at: plan.cutoff,
        content: 'Remove my hosted napplet repository',
        tags: [
          ['a', repo.address],
          ['k', '30617'],
        ],
      });
      await io.publish(repo.relay, e);
      const id = repo.address.split(':').slice(2).join(':');
      const left = await io.read(repo.relay, {
        authors: [plan.author],
        kinds: [30617],
        '#d': [id],
        limit: 20,
      });
      if (left.some((a) => a.created_at <= plan.cutoff))
        return {
          state: 'requested',
          message: 'Repository deletion requested; announcement is still visible. Retry to check.',
        };
      lifecycleEndpoint(repo.clone, 'http', options.local);
      const response = await io.fetch(`${repo.clone}/info/refs?service=git-upload-pack`);
      await response.body?.cancel();
      if (response.status !== 404 && response.status !== 410)
        return {
          state: 'requested',
          message: `Announcement removed; Git download removal is not confirmed (HTTP ${response.status}). Retry to check.`,
        };
      // NIP-09 is a serving-state request, never a promise to erase a server's backups.
      return {
        state: 'retained',
        message:
          'Repository announcement removed. GRASP may retain a recovery archive (90 days on Soy); physical erasure is not confirmed. Clones and forks remain.',
      };
    });
  }
  return receipt;
}
export const lifecycleFinished = (r: LifecycleReceipt) =>
  (r.operation !== 'delete' || r.plan.complete) &&
  r.steps.every((s) => s.state === 'done' || s.state === 'retained');
export const listingRemoved = (r: LifecycleReceipt) =>
  r.operation !== 'republish' &&
  r.steps.some((s) => s.id.startsWith('relay:') && s.state === 'done');

/** Persist only public, signed recovery data and bounded service receipts. */
export function parseReceipt(value: unknown): LifecycleReceipt {
  const r = receiptSchema.parse(value) as LifecycleReceipt;
  verifiedEvent(r.plan.manifest);
  if (r.plan.author !== r.plan.manifest.pubkey || r.plan.key !== nappletKey(r.plan.manifest))
    throw new Error('Lifecycle record does not match its signed author.');
  const paired = new Set<string>();
  for (const pair of r.plan.snapshotPairs ?? []) {
    const current = r.plan.manifests.find((event) => event.id === pair.current);
    const snapshot = r.plan.manifests.find((event) => event.id === pair.snapshot);
    if (
      !current ||
      !snapshot ||
      current.kind === 5129 ||
      snapshot.kind !== 5129 ||
      nappletKey(current) !== r.plan.key ||
      paired.has(snapshot.id)
    )
      throw new Error('Lifecycle record contains an invalid publication pair.');
    paired.add(snapshot.id);
  }
  for (const e of r.plan.manifests)
    if (
      verifiedEvent(e).pubkey !== r.plan.author ||
      (nappletKey(e) !== r.plan.key && !paired.has(e.id))
    )
      throw new Error('Lifecycle record contains an unrelated release.');
  for (const e of r.plan.metadata) verifiedEvent(e);
  for (const e of Object.values(r.events))
    if (verifiedEvent(e).pubkey !== r.plan.author)
      throw new Error('Lifecycle signature belongs to another author.');
  const expected = createLifecycleReceipt(r.plan, r.operation).steps;
  if (
    r.steps.length !== expected.length ||
    r.steps.some((s, i) => s.id !== expected[i].id || s.target !== expected[i].target)
  )
    throw new Error('Lifecycle step targets were changed.');
  return r;
}
import { z } from 'zod';
import { eventSchema } from '../../protocol/src';
const text = z.string().max(4096),
  digest = z.string().regex(/^[a-f0-9]{64}$/);
const receiptSchema = z.object({
  version: z.literal(1),
  operation: z.enum(['unpublish', 'republish', 'delete']),
  createdAt: z.number().int().nonnegative(),
  plan: z.object({
    version: z.literal(1),
    key: text,
    author: digest,
    title: z.string().max(160),
    manifest: eventSchema,
    manifests: z.array(eventSchema).min(1).max(500),
    snapshotPairs: z
      .array(z.object({ current: digest, snapshot: digest }).strict())
      .max(128)
      .optional(),
    metadata: z.array(eventSchema).max(160),
    sharedMetadata: z.array(text).max(1000).default([]),
    relays: z.array(text).min(1).max(256),
    cutoff: z.number().int().nonnegative(),
    complete: z.boolean(),
    warnings: z.array(text).max(1000),
    blobs: z
      .array(
        z.object({
          origin: text,
          hash: digest,
          labels: z.array(text).max(32),
          retained: text.optional(),
        }),
      )
      .max(2000),
    repositories: z
      .array(z.object({ address: text, relay: text, clone: text, retained: text.optional() }))
      .max(128),
  }),
  events: z.record(z.string().max(8192), eventSchema),
  steps: z
    .array(
      z.object({
        id: z.string().max(8192),
        label: text,
        target: text,
        state: z.enum(['pending', 'running', 'done', 'retained', 'requested', 'failed']),
        message: z.string().max(24000).optional(),
      }),
    )
    .max(2400),
});
