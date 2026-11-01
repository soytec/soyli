import { nip19 } from 'nostr-tools';
import { z } from 'zod';
import { DiagnosticError } from '../../diagnostics/src';
import { verifiedEvent, sha256, type SignedEvent } from '../../protocol/src';
import { validateManifest } from '../../protocol/src/manifest';
import type { ProtocolClient } from '../../client/src/nostr';
import { Observable, map, filter, distinctUntilChanged, Subscription } from 'rxjs';

export const commitPattern = /^[a-f0-9]{40}$/;
export const tag = (event: SignedEvent, name: string) => event.tags.find((t) => t[0] === name)?.[1];
export const values = (event: SignedEvent, name: string) =>
  event.tags.filter((t) => t[0] === name).flatMap((t) => t.slice(1));
export const latest = (events: SignedEvent[]) =>
  [...events].sort((a, b) => b.created_at - a.created_at || a.id.localeCompare(b.id));
export function repositoryRef(reference: string) {
  let ref = reference.replace(/^nostr:\/\//, '').replace(/^nostr:/, ''),
    relays: string[] = [];
  if (ref.startsWith('naddr1')) {
    const decoded = nip19.decode(ref);
    if (decoded.type !== 'naddr' || decoded.data.kind !== 30617)
      throw new Error('Expected a Git repository address.');
    ref = `30617:${decoded.data.pubkey}:${decoded.data.identifier}`;
    relays = decoded.data.relays ?? [];
  } else if (ref.startsWith('npub1')) {
    const parts = ref.split('/'),
      decoded = nip19.decode(parts[0]);
    if (decoded.type !== 'npub' || ![2, 3].includes(parts.length))
      throw new Error('Invalid repository URL.');
    if (parts.length === 3) {
      const hint = decodeURIComponent(parts[1]);
      relays = [/^wss?:/.test(hint) ? hint : `wss://${hint}`];
    }
    ref = `30617:${decoded.data}:${decodeURIComponent(parts.at(-1)!)}`;
  }
  const match = /^30617:([a-f0-9]{64}):([^\u0000-\u001f]{1,256})$/.exec(ref);
  if (!match) throw new Error('Use a NIP-34 repository address or nostr:// clone URL.');
  return { address: ref, pubkey: match[1], identifier: match[2], relays };
}
const nip05Pattern = /^(?:([a-z0-9._-]{1,64})@)?((?:[a-z0-9-]{1,63}\.)+[a-z]{2,63})$/i;
/** ngit remote URLs may name the owner by NIP-05 and carry a transport hint:
 * nostr://[protocol/]<npub|nip05>[/<relay>]/<identifier>. */
export async function resolveRepositoryRef(
  reference: string,
  options: { fetch?: typeof fetch; signal?: AbortSignal } = {},
) {
  if (!reference.startsWith('nostr://')) return repositoryRef(reference);
  let parts = reference.slice('nostr://'.length).split('/');
  if (parts.length > 2 && ['ssh', 'https', 'http', 'git'].includes(parts[0].toLowerCase()))
    parts = parts.slice(1);
  const owner = decodeURIComponent(parts[0] ?? '');
  const nip05 = nip05Pattern.exec(owner);
  if (!nip05 || ![2, 3].includes(parts.length)) return repositoryRef(`nostr://${parts.join('/')}`);
  const [name, domain] = [(nip05[1] ?? '_').toLowerCase(), nip05[2].toLowerCase()];
  const target = `https://${domain}/.well-known/nostr.json?name=${encodeURIComponent(name)}`;
  let pubkey: unknown;
  try {
    const response = await (options.fetch ?? fetch)(target, {
      redirect: 'error',
      credentials: 'omit',
      signal: options.signal
        ? AbortSignal.any([options.signal, AbortSignal.timeout(8000)])
        : AbortSignal.timeout(8000),
    });
    if (!response.ok) {
      await response.body?.cancel();
      throw new DiagnosticError('NIP05_STATUS', 'NIP-05 lookup returned an error status.', {
        status: response.status,
      });
    }
    const reader = response.body?.getReader();
    if (!reader) throw new Error('NIP-05 document is empty.');
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > 64 * 1024) throw new Error('NIP-05 document exceeds 64 KiB.');
        chunks.push(value);
      }
    } finally {
      await reader.cancel();
      reader.releaseLock();
    }
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    pubkey = (JSON.parse(new TextDecoder().decode(bytes)) as { names?: Record<string, unknown> })
      .names?.[name];
  } catch (cause) {
    throw new DiagnosticError('REPOSITORY_OWNER_LOOKUP', `Could not resolve ${name}@${domain}.`, {
      operation: 'resolve repository owner',
      target,
      cause,
      recovery:
        'Retry when the NIP-05 host is reachable, or set publish.repository in napplet.json to the repository naddr1… address, which needs no lookup.',
    });
  }
  if (typeof pubkey !== 'string' || !/^[a-f0-9]{64}$/.test(pubkey))
    throw new DiagnosticError(
      'REPOSITORY_OWNER_LOOKUP',
      `${name}@${domain} does not publish a Nostr public key.`,
      {
        operation: 'resolve repository owner',
        target,
        recovery:
          'Check the remote URL, or set publish.repository in napplet.json to the repository naddr1… address.',
      },
    );
  return repositoryRef(`nostr://${[nip19.npubEncode(pubkey), ...parts.slice(1)].join('/')}`);
}
export function proposalId(value: string) {
  value = value.replace(/^nostr:/, '');
  if (/^(nevent|note)1/.test(value)) {
    const d = nip19.decode(value);
    value = d.type === 'nevent' ? d.data.id : d.type === 'note' ? d.data : '';
  }
  if (!/^[a-f0-9]{64}$/.test(value)) throw new Error('Use the full proposal event id or nevent.');
  return value;
}
export type Repository = ReturnType<typeof repositoryRef> & {
  event: SignedEvent;
  clones: string[];
  maintainers: string[];
  euc?: string;
};
export async function readRepository(
  client: ProtocolClient,
  reference: string,
): Promise<Repository> {
  const ref = repositoryRef(reference);
  const event = latest(
    await client.query(
      [{ kinds: [30617], authors: [ref.pubkey], '#d': [ref.identifier], limit: 5 }],
      ref.relays,
    ),
  )[0];
  if (!event) throw new Error('Repository announcement unavailable.');
  return repositoryFromEvent(ref, event);
}
/** Legacy NIP-34 reciprocal maintainership at the selected repository coordinate.
 * An invitation alone must not make a state authoritative. */
export async function readRepositoryState(client: ProtocolClient, repo: Repository) {
  if (repo.event.tags.some((t) => ['M', 'm'].includes(t[0])))
    throw new DiagnosticError(
      'REPOSITORY_AUTHORITY_UNSUPPORTED',
      'This repository uses role-based maintainer authority outside the selected adapter profile.',
      {
        operation: 'resolve repository state',
        target: repo.address,
        recovery:
          'Use ngit for this repository’s merge and push operations. Soy has not changed its announcement or selected another identity.',
      },
    );
  const announcements = await client.query(
    [{ kinds: [30617], authors: repo.maintainers, '#d': [repo.identifier], limit: 100 }],
    repo.relays,
  );
  const authors = [
    repo.pubkey,
    ...repo.maintainers.filter((pubkey) => {
      const announcement = latest(announcements.filter((e) => e.pubkey === pubkey))[0];
      return (
        announcement &&
        !announcement.tags.some((t) => ['M', 'm'].includes(t[0])) &&
        values(announcement, 'maintainers').includes(repo.pubkey)
      );
    }),
  ];
  const state = latest(
    await client.query(
      [{ kinds: [30618], authors, '#d': [repo.identifier], limit: 100 }],
      repo.relays,
    ),
  )[0];
  return { state, authors: [...new Set(authors)] };
}
export function repositoryFromEvent(
  ref: ReturnType<typeof repositoryRef>,
  event: SignedEvent,
): Repository {
  return {
    ...ref,
    event,
    relays: [...new Set([...values(event, 'relays'), ...ref.relays])].slice(0, 8),
    clones: values(event, 'clone'),
    maintainers: [
      ...new Set([
        event.pubkey,
        ...values(event, 'maintainers').filter((p) => /^[a-f0-9]{64}$/.test(p)),
      ]),
    ],
    euc: event.tags.find((t) => t[0] === 'r' && t[2] === 'euc')?.[1],
  };
}
/** A display projection; later announcements replace earlier ones as relays respond. */
export function observeRepository(client: ProtocolClient, reference: string) {
  const ref = repositoryRef(reference);
  return client
    .observeQuery(
      [{ kinds: [30617], authors: [ref.pubkey], '#d': [ref.identifier], limit: 5 }],
      ref.relays,
    )
    .pipe(
      map((events) => latest(events)[0]),
      filter((event): event is SignedEvent => !!event),
      distinctUntilChanged((a, b) => a.id === b.id),
      map((event) => {
        if (!client.allowed(event)) throw new Error('Repository unavailable here.');
        return repositoryFromEvent(ref, event);
      }),
    );
}
export type Proposal = {
  root: SignedEvent;
  revision: SignedEvent;
  revisions: SignedEvent[];
  status: 'open' | 'merged' | 'closed' | 'draft';
  statusEvent?: SignedEvent;
  comments: SignedEvent[];
  head?: string;
  base?: string;
  clones: string[];
  title: string;
  patch: boolean;
};
export function proposalsFromEvents(repo: Repository, inputs: SignedEvent[]): Proposal[] {
  const events = inputs.flatMap((input) => {
    try {
      const e = verifiedEvent(input);
      return e.created_at <= Date.now() / 1000 + 60 ? [e] : [];
    } catch {
      return [];
    }
  });
  return latest(
    events.filter(
      (e) =>
        (e.kind === 1618 || (e.kind === 1617 && values(e, 't').includes('root'))) &&
        values(e, 'a').includes(repo.address),
    ),
  ).map((root) => {
    const revisions = latest([
      root,
      ...events.filter(
        (e) =>
          e.kind === 1619 &&
          e.pubkey === root.pubkey &&
          tag(e, 'E') === root.id &&
          tag(e, 'P') === root.pubkey &&
          values(e, 'a').includes(repo.address) &&
          commitPattern.test(tag(e, 'c') ?? '') &&
          values(e, 'clone').length > 0,
      ),
    ]);
    const revision = revisions[0];
    const statusEvent = latest(
      events.filter(
        (e) =>
          [1630, 1631, 1632, 1633].includes(e.kind) &&
          (e.pubkey === root.pubkey || repo.maintainers.includes(e.pubkey)) &&
          e.tags.some((t) => t[0] === 'e' && t[1] === root.id && t[3] === 'root'),
      ),
    )[0];
    const comments = events
      .filter(
        (e) =>
          e.kind === 1111 &&
          tag(e, 'E') === root.id &&
          tag(e, 'K') === String(root.kind) &&
          tag(e, 'P') === root.pubkey,
      )
      .sort((a, b) => a.created_at - b.created_at);
    return {
      root,
      revision,
      revisions,
      status:
        ({ 1630: 'open', 1631: 'merged', 1632: 'closed', 1633: 'draft' } as const)[
          statusEvent?.kind as 1630
        ] ?? 'open',
      statusEvent,
      comments,
      head: tag(revision, root.kind === 1617 ? 'commit' : 'c'),
      base: tag(revision, 'merge-base'),
      clones: values(revision, 'clone'),
      title: tag(root, 'subject') ?? 'Change proposal',
      patch: root.kind === 1617,
    };
  });
}
export async function readProposals(client: ProtocolClient, repo: Repository, selected?: string) {
  const roots = await client.query(
    [
      { kinds: [1617, 1618], '#a': [repo.address], limit: 100 },
      ...(selected ? [{ kinds: [1617, 1618], ids: [proposalId(selected)], limit: 1 }] : []),
    ],
    repo.relays,
  );
  if (!roots.length) return [];
  const ids = roots.map((e) => e.id);
  const related = await client.query(
    [
      { kinds: [1619, 1111], '#E': ids, limit: 500 },
      { kinds: [1630, 1631, 1632, 1633], '#e': ids, limit: 500 },
    ],
    repo.relays,
  );
  return proposalsFromEvents(repo, [...roots, ...related]);
}
/** Progressive review UI. The CLI's merge/review reads keep their full-query contract. */
export function observeProposals(client: ProtocolClient, repo: Repository, selected?: string) {
  const filters = [
    { kinds: [1617, 1618], '#a': [repo.address], limit: 100 },
    ...(selected ? [{ kinds: [1617, 1618], ids: [proposalId(selected)], limit: 1 }] : []),
  ];
  return new Observable<Proposal[]>((observer) => {
    const subscriptions = new Subscription();
    const requested = new Set<string>(),
      related = new Map<string, SignedEvent>();
    let roots: SignedEvent[] = [],
      timer: ReturnType<typeof setTimeout> | undefined,
      rootsComplete = false,
      loadingRelated = false,
      pendingRelated = 0;
    const complete = () => {
      if (rootsComplete && !timer && !loadingRelated && pendingRelated === 0) observer.complete();
    };
    const emit = () =>
      observer.next(
        proposalsFromEvents(repo, [...roots, ...related.values()].filter(client.allowed)),
      );
    const loadRelated = () => {
      timer = undefined;
      loadingRelated = true;
      const ids = roots.filter((event) => !requested.has(event.id)).map((event) => event.id);
      for (let i = 0; i < ids.length && !observer.closed; i += 32) {
        const group = ids.slice(i, i + 32);
        group.forEach((id) => requested.add(id));
        pendingRelated++;
        subscriptions.add(
          client
            .observeQuery(
              [
                { kinds: [1619, 1111], '#E': group, limit: 500 },
                { kinds: [1630, 1631, 1632, 1633], '#e': group, limit: 500 },
              ],
              repo.relays,
            )
            .subscribe({
              next: (events) => {
                for (const event of events)
                  if (related.size < 2000 || related.has(event.id)) related.set(event.id, event);
                emit();
              },
              error: (error) => observer.error(error),
              complete: () => {
                pendingRelated--;
                complete();
              },
            }),
        );
      }
      loadingRelated = false;
      complete();
    };
    subscriptions.add(
      client.observeQuery(filters, repo.relays).subscribe({
        next: (events) => {
          roots = latest(events)
            .filter((e) => values(e, 'a').includes(repo.address))
            .slice(0, 100);
          emit();
          if (!timer) timer = setTimeout(loadRelated, 40);
        },
        error: (error) => observer.error(error),
        complete: () => {
          rootsComplete = true;
          clearTimeout(timer);
          loadRelated();
        },
      }),
    );
    return () => {
      clearTimeout(timer);
      subscriptions.unsubscribe();
    };
  });
}
export const previewSchema = z
  .object({
    version: z.literal(1),
    commit: z.string().regex(commitPattern),
    manifest: z.unknown(),
    check: z.object({ profile: z.string().max(80), browser: z.string().max(80) }),
    image: z.string().max(2048).optional(),
  })
  .strict();
export async function validatePreview(bytes: Uint8Array, revision: SignedEvent) {
  const attachments = revision.tags.filter((t) => t[0] === 'soy-preview');
  if (attachments.length !== 1 || attachments[0].length !== 4)
    throw new Error('No unambiguous playable preview for this revision.');
  const attachment = attachments[0];
  if (bytes.length > 65536 || (await sha256(bytes)) !== attachment[2])
    throw new Error('Preview descriptor hash mismatch.');
  const preview = previewSchema.parse(
    JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)),
  );
  if (preview.commit !== tag(revision, 'c') || preview.commit !== attachment[3])
    throw new Error('Preview belongs to another source commit.');
  const release = await validateManifest(preview.manifest);
  if (
    release.manifest.pubkey !== revision.pubkey ||
    tag(release.manifest, 'source-commit') !== preview.commit
  )
    throw new Error('Preview author or source mismatch.');
  return { ...preview, manifest: release.manifest, artifactHash: release.artifactHash };
}
