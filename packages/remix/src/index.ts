import { DiagnosticError } from '../../diagnostics/src';
import { validateAssets, parseAssets, ASSET_LOCK } from '../../assets/src';
import { relatedAssetHtml } from '../../assets/src/related';
import { ProtocolClient } from '../../client/src/nostr';
import { readRepository, repositoryRef } from '../../collaboration/src/protocol';
import { cloneRevision } from '../../collaboration/src/git';
import { writeBinding } from '../../publish/src/binding';
import { loopbackRelayUrl } from '../../nostr/src/relay-policy';
import { mkdir, writeFile, rm } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { nip19, type Filter } from 'nostr-tools';
import {
  MAX_READ_ARTIFACT_BYTES,
  sha256,
  decodeAddress,
  identityAddress,
  type SignedEvent,
} from '../../protocol/src';
import { validateManifest } from '../../protocol/src/manifest';
import { remixLineage } from '../../protocol/src/remix';
import { manifestTopics } from '../../protocol/src/topics';
import { fetchPublicBytes } from '../../backend/src/blossom';
import { publicRelayUrl } from '../../nostr/src/relay-policy';
import { discoverRemix } from './discovery';
import { projectPublishingDefaults, projectSchema } from '../../publish/src/config';
import { sourceGit } from '../../grasp/src/client';
import { sourceArchive } from './archive';
import type { Network } from '../../identity/src/signer';
import { AccountError } from '../../identity/src/signer';
import discoveryRelays from '../../nostr/discovery-relays.json';

export async function remixBytes(url: URL, local: boolean, signal: AbortSignal, limit: number) {
  if (!local) return fetchPublicBytes(url, signal, limit);
  if (
    url.protocol !== 'http:' ||
    !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname) ||
    url.username ||
    url.password ||
    url.hash
  )
    throw new Error('Local remixes use loopback HTTP only');
  const response = await fetch(url, { signal, redirect: 'error' });
  if (!response.ok || !response.body || Number(response.headers.get('content-length')) > limit)
    throw new Error('Download unavailable');
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > limit) throw new Error('Download too large');
      chunks.push(value);
    }
  } finally {
    await reader.cancel();
  }
  return new Uint8Array(Buffer.concat(chunks));
}

function remixReference(reference: string) {
  try {
    let ref = reference.replace(/^nostr:/, ''),
      hints: string[] = [];
    if (/^https?:/.test(reference)) {
      const url = new URL(reference);
      const match = /^\/(?:n\/(naddr1[^/]+)|r\/([a-f0-9]{64}))\/?$/.exec(url.pathname);
      if (!match || url.username || url.password || url.search || url.hash) throw new Error();
      ref = match[1] ?? match[2];
    }
    let filter: Filter;
    if (ref.startsWith('naddr1')) {
      const identity = decodeAddress(ref);
      identityAddress(identity);
      const decoded = nip19.decode(ref);
      if (decoded.type === 'naddr') hints = decoded.data.relays ?? [];
      filter = {
        kinds: [identity.kind],
        authors: [identity.pubkey],
        ...(identity.kind === 35129 ? { '#d': [identity.identifier] } : {}),
        limit: 3,
      };
    } else {
      if (/^(nevent|note)1/.test(ref)) {
        const decoded = nip19.decode(ref);
        if (decoded.type === 'nevent') {
          ref = decoded.data.id;
          hints = decoded.data.relays ?? [];
        } else if (decoded.type === 'note') ref = decoded.data;
      }
      if (!/^[a-f0-9]{64}$/.test(ref)) throw new Error();
      filter = { ids: [ref], kinds: [35129, 15129, 5129], limit: 1 };
    }
    return { filter, hints };
  } catch {
    throw new AccountError(
      'REMIX_REFERENCE',
      'Use a plain napplet /n/naddr or /r/event link, naddr, nevent, note or hexadecimal event ID.',
    );
  }
}

export async function loadRemix(reference: string, network: Network, signal: AbortSignal) {
  const { filter, hints } = remixReference(reference);
  const destinations =
    network === 'local'
      ? [
          ...new Set([
            ...hints.flatMap((r) => {
              try {
                return [loopbackRelayUrl(r)];
              } catch {
                return [];
              }
            }),
            'ws://127.0.0.1:19347/relay',
          ]),
        ]
      : [...new Set([...hints, 'wss://relay.napplet.soy', ...discoveryRelays])]
          .filter((r) => {
            try {
              publicRelayUrl(r);
              return true;
            } catch {
              return false;
            }
          })
          .slice(0, 8);
  const manifest = await discoverRemix(filter, destinations, signal);
  const release = await validateManifest(manifest);
  let artifact: Uint8Array | undefined;
  const downloadFailures: Error[] = [];
  for (const url of [
    ...release.servers.map((s) => `${s.replace(/\/$/, '')}/${release.artifactHash}`),
  ]) {
    try {
      const bytes = await remixBytes(
        new URL(url),
        network === 'local',
        signal,
        MAX_READ_ARTIFACT_BYTES,
      );
      if ((await sha256(bytes)) === release.artifactHash) {
        artifact = bytes;
        break;
      }
      throw new Error('Downloaded artifact hash differs from the signed manifest.');
    } catch (cause) {
      downloadFailures.push(
        new DiagnosticError('BLOSSOM_DOWNLOAD', 'Artifact download failed.', {
          target: url,
          cause,
        }),
      );
    }
  }
  if (!artifact)
    throw new DiagnosticError(
      'REMIX_DOWNLOAD',
      'No verified download is available for this version. Its declared Blossom servers may be unavailable; retry later.',
      {
        operation: 'download remix artifact',
        cause: new AggregateError(downloadFailures, 'Declared artifact sources failed.'),
      },
    );
  let files: Map<string, Uint8Array> | undefined;
  const archive = manifest.tags.find((t) => t[0] === 'source-archive')?.[1];
  let archiveError: unknown;
  if (archive) {
    try {
      const url = new URL(archive),
        hash = /\/([a-f0-9]{64})(?:\.tar)?$/.exec(url.pathname)?.[1];
      if (!hash) throw new Error('The signed source archive needs a content hash');
      const bytes = await remixBytes(url, network === 'local', signal, 50 * 1024 * 1024);
      if ((await sha256(bytes)) !== hash) throw new Error('Source archive hash mismatch');
      files = sourceArchive(bytes);
    } catch (error) {
      archiveError = error;
    }
  }
  let repository: Awaited<ReturnType<typeof readRepository>> | undefined;
  const source = manifest.tags.find((t) => t[0] === 'source')?.[1];
  const commit = manifest.tags.find((t) => t[0] === 'source-commit')?.[1];
  if (source?.startsWith('nostr://') && /^[a-f0-9]{40}$/.test(commit ?? '')) {
    const client = new ProtocolClient(() =>
      network === 'local'
        ? [
            ...hints,
            ...repositoryRef(source).relays.map(loopbackRelayUrl),
            'ws://127.0.0.1:19347/relay',
          ]
        : [...hints, 'wss://relay.napplet.soy', ...discoveryRelays],
    );
    try {
      repository = await readRepository(client, source);
    } finally {
      client.close();
    }
  }
  if (archiveError && !repository)
    throw new DiagnosticError(
      'REMIX_SOURCE',
      'The published source archive could not be downloaded or verified. Retry later or ask the creator to check the release.',
      { operation: 'download source archive', target: archive, cause: archiveError },
    );
  return { manifest, artifact, files, repository, network };
}

export async function createRemix(
  parent: string,
  name: string,
  input: Omit<Awaited<ReturnType<typeof loadRemix>>, 'repository' | 'network'> &
    Partial<Pick<Awaited<ReturnType<typeof loadRemix>>, 'repository' | 'network'>>,
) {
  if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(name))
    throw new AccountError('REMIX_FOLDER', 'Choose a new lowercase folder name.');
  const lineage = await remixLineage(input.manifest);
  const release = await validateManifest(input.manifest);
  const files = input.files ?? new Map<string, Uint8Array>();
  const decode = (path: string) =>
    new TextDecoder('utf-8', { fatal: true }).decode(files.get(path));
  let previous = files.has('napplet.json')
    ? projectSchema.parse(JSON.parse(decode('napplet.json')))
    : undefined;
  const entry = previous?.entry ?? 'index.html';
  if (files.has(entry)) {
    const source = files.get(entry)!;
    const artifactHash = await sha256(input.artifact);
    // Legacy HTML remains editable source. Accept only the exact deterministic
    // resource-link preparation, retaining the byte equality guard for all else.
    if (
      (await sha256(source)) !== artifactHash &&
      (await sha256(await relatedAssetHtml(source, parseAssets(files.get(ASSET_LOCK))))) !==
        artifactHash
    )
      throw new Error('Source archive does not contain this version’s artifact');
  }
  const target = resolve(parent, name);
  try {
    await mkdir(target); // Refuse overwrite before writing any source.
  } catch {
    throw new AccountError(
      'REMIX_DESTINATION',
      'Could not create the remix folder. Choose a new folder name in a writable directory; existing folders are never overwritten.',
    );
  }
  try {
    if (input.repository && lineage.sourceCommit) {
      const clone = await cloneRevision(
        target,
        input.repository,
        lineage.sourceCommit,
        input.network === 'local',
      );
      const clonedProject = projectSchema.parse(
        await Bun.file(join(target, 'napplet.json')).json(),
      );
      const previewId = crypto.randomUUID();
      await writeBinding(target, {
        version: 1,
        project: {
          previewId,
          identifier: `n-${previewId.replaceAll('-', '').slice(0, 11)}`,
          remix: lineage,
          creator: undefined,
          publish: projectPublishingDefaults(),
        },
        upstream: {
          address: input.repository.address,
          relays: input.repository.relays,
          clone,
          commit: lineage.sourceCommit,
          manifest: input.manifest,
        },
      });
      await validateAssets(target);
      return {
        directory: target,
        lineage,
        source: 'git',
        needsSetup: clonedProject.entry === 'dist/index.html',
      };
    }
    for (const [path, bytes] of files) {
      if (path === 'napplet.json') continue;
      await mkdir(dirname(join(target, path)), { recursive: true });
      await writeFile(join(target, path), bytes, { flag: 'wx' });
    }
    await mkdir(dirname(join(target, entry)), { recursive: true });
    if (!files.has(entry)) await writeFile(join(target, entry), input.artifact, { flag: 'wx' });
    const previewId = crypto.randomUUID();
    const config = {
      ...(previous ?? {}),
      schema: 'space-local-project/v1',
      name,
      title:
        `${previous?.title ?? previous?.name ?? input.manifest.tags.find((t) => t[0] === 'title')?.[1] ?? 'Napplet'} remix`.slice(
          0,
          160,
        ),
      entry,
      previewId,
      identifier: `n-${previewId.replaceAll('-', '').slice(0, 11)}`,
      description: previous?.description || release.description.slice(0, 1000),
      license: previous?.license ?? 'UNLICENSED',
      requires: [...new Set([...(previous?.requires ?? []), ...release.domains])],
      optionalDomains: previous?.optionalDomains ?? release.optionalDomains.slice(0, 32),
      // Remote advertisements can exceed this authoring tool's narrower limits.
      // Keep supported declarations verbatim; never turn truncation into a new
      // routing identity or let optional metadata create an unusable project.
      archetypes:
        previous?.archetypes ??
        release.archetypes
          .filter((value) => projectSchema.shape.archetypes.safeParse([value]).success)
          .slice(0, 32),
      intents:
        previous?.intents ??
        release.intents
          .filter((value) => projectSchema.shape.intents.safeParse([value]).success)
          .slice(0, 32),
      topics: previous?.topics ?? manifestTopics(input.manifest),
      relays: previous?.relays ?? [],
      servers:
        previous?.servers ??
        input.manifest.tags
          .filter((t) => t[0] === 'server')
          .map((t) => t[1])
          .slice(0, 8),
      remix: lineage,
    };
    delete (config as Record<string, unknown>).creator;
    (config as Record<string, unknown>).publish = projectPublishingDefaults();
    delete (config as Record<string, unknown>).preview;
    // A scene-ready milestone is build behavior, not an inherited promotional asset.
    if (previous?.preview?.readySelector)
      (config as Record<string, unknown>).preview = {
        readySelector: previous.preview.readySelector,
        ...(previous.preview.delayMs !== undefined ? { delayMs: previous.preview.delayMs } : {}),
      };
    await writeFile(join(target, 'napplet.json'), JSON.stringify(config, null, 2) + '\n', {
      flag: 'wx',
    });
    if (!files.has('AGENTS.md'))
      await writeFile(
        join(target, 'AGENTS.md'),
        '# Remix workspace\n\nRead docs/napplet-space.md for the installed upstream creator skills and CLI commands. Preserve original license notices and the remix lineage in napplet.json. Use the host-mediated NAP APIs and keep the playable build self-contained. Never put private signing keys in this repository.\n',
      );
    if (!files.has('LICENSE'))
      await writeFile(
        join(target, 'LICENSE'),
        'No source license was supplied with this manifest. Check the original source before distributing changes.\n',
      );
    if (!files.has('package.json'))
      await writeFile(
        join(target, 'package.json'),
        JSON.stringify(
          {
            name,
            private: true,
            scripts: {
              dev: 'soyli dev',
              check: 'soyli check',
              publish: 'soyli publish',
            },
          },
          null,
          2,
        ) + '\n',
      );
    const notice = `\n\nRemixed from Nostr event ${input.manifest.id}.\nOriginal napplet: ${lineage.parent ?? input.manifest.id}\nOriginal creator: ${input.manifest.pubkey}\nSource: ${files.size ? 'hash-verified author-published source archive' : 'verified self-contained HTML'}${lineage.sourceCommit ? `\nAuthor-recorded source commit: ${lineage.sourceCommit}` : ''}\n`;
    await writeFile(
      join(target, 'README.md'),
      (files.has('README.md') ? decode('README.md') : `# ${name}`) + notice,
    );
    await writeFile(
      join(target, '.gitignore'),
      (files.has('.gitignore') ? decode('.gitignore') : '') +
        '\n.napplet-space/\nnode_modules/\n.env\n.env.*\n*.nsec\n',
    );
    await validateAssets(target);
    await sourceGit(target, ['init']);
    await sourceGit(target, ['symbolic-ref', 'HEAD', 'refs/heads/main']);
    return {
      directory: target,
      lineage,
      source: files.size ? 'archive' : 'html',
      needsSetup: entry === 'dist/index.html',
    };
  } catch (error) {
    await rm(target, { recursive: true, force: true });
    throw error;
  }
}
