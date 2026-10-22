import { DiagnosticError, ToolOutput } from '../../diagnostics/src';
import { RelayPool } from 'applesauce-relay';
import { lastValueFrom, toArray } from 'rxjs';
import { nip19, type EventTemplate } from 'nostr-tools';
import { verifiedEvent, type SignedEvent } from '../../protocol/src';

export type SourceSigner = {
  getPublicKey(): Promise<string>;
  signEvent(event: EventTemplate): Promise<SignedEvent>;
};
export type SourcePublication = { announcement: SignedEvent; state: SignedEvent };
const identifierPattern = /^[a-z0-9][a-z0-9-]{0,63}$/;
const commitPattern = /^[a-f0-9]{40}$/;
export function graspOrigin(input: string, local = false) {
  const url = new URL(input);
  if (
    url.username ||
    url.password ||
    url.pathname !== '/' ||
    url.search ||
    url.hash ||
    (local
      ? url.protocol !== 'http:' || !['127.0.0.1', '[::1]'].includes(url.hostname)
      : url.protocol !== 'https:')
  )
    throw new Error(
      'GRASP needs a root HTTPS origin, or literal-loopback HTTP in the explicit local profile.',
    );
  return url.origin;
}
export function sourceUrls(origin: string, pubkey: string, identifier: string, local = false) {
  if (!/^[a-f0-9]{64}$/.test(pubkey) || !identifierPattern.test(identifier))
    throw new Error('Invalid source identity');
  origin = graspOrigin(origin, local);
  const npub = nip19.npubEncode(pubkey);
  const relay = `${origin.replace(/^http/, 'ws')}/`;
  return {
    relay,
    clone: `${origin}/${npub}/${identifier}.git`,
    portable: `nostr://${npub}/${encodeURIComponent(relay)}/${identifier}`,
  };
}
/** Git never sees a Nostr secret. Fixed HTTP targets, disabled hooks/helpers and bounded subprocesses. */
export async function sourceGit(
  directory: string,
  args: string[],
  extra: Record<string, string> = {},
  outputLimit = 2 * 1024 * 1024,
) {
  const env: Record<string, string> = {
    PATH: process.env.PATH ?? '/usr/bin:/bin',
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_TERMINAL_PROMPT: '0',
    GIT_AUTHOR_NAME: 'Napplet creator',
    GIT_AUTHOR_EMAIL: 'creator@napplet.invalid',
    GIT_COMMITTER_NAME: 'Napplet creator',
    GIT_COMMITTER_EMAIL: 'creator@napplet.invalid',
    ...extra,
  };
  const operation = `Git ${args.find((arg) => ['init', 'fetch', 'push', 'status', 'commit', 'merge', 'rev-parse', 'rev-list', 'diff', 'show', 'checkout', 'symbolic-ref', 'merge-base', 'merge-tree', 'ls-remote', 'config', 'tag', 'ls-files', 'cat-file'].includes(arg)) ?? 'command'}`;
  let child;
  try {
    child = Bun.spawn(
      [
        'git',
        '-c',
        'core.hooksPath=/dev/null',
        '-c',
        'credential.helper=',
        '-c',
        'http.extraHeader=',
        '-c',
        'http.followRedirects=false',
        '-c',
        'http.proxy=',
        ...args,
      ],
      {
        cwd: directory,
        env,
        stdout: 'pipe',
        stderr: 'pipe',
        stdin: 'ignore',
      },
    );
  } catch (cause) {
    throw new DiagnosticError('GIT_START', 'Could not start Git.', {
      operation,
      tool: 'git',
      cause,
      recovery: 'Check git --version, the project directory and executable permissions.',
    });
  }
  let timeout = false;
  const timer = setTimeout(() => {
    timeout = true;
    child.kill('SIGKILL');
  }, 60000);
  const outDiagnostic = new ToolOutput(),
    errDiagnostic = new ToolOutput();
  const failureOutput = () =>
    [
      outDiagnostic.text && `Git stdout:\n${outDiagnostic.text.slice(-900)}`,
      errDiagnostic.text && `Git stderr:\n${errDiagnostic.text.slice(-900)}`,
    ]
      .filter(Boolean)
      .join('\n');
  const read = async (stream: ReadableStream<Uint8Array>, diagnostic: ToolOutput) => {
    const reader = stream.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
      while (true) {
        const next = await reader.read();
        if (next.done) break;
        diagnostic.push(next.value);
        size += next.value.byteLength;
        if (size > outputLimit) {
          child.kill('SIGKILL');
          throw new DiagnosticError('GIT_OUTPUT_LIMIT', 'Git output exceeded its limit.', {
            operation,
            tool: 'git',
          });
        }
        chunks.push(next.value);
      }
      return Buffer.concat(chunks).toString('utf8').trim();
    } finally {
      diagnostic.finish();
      reader.releaseLock();
    }
  };
  try {
    const [stdout, , code] = await Promise.all([
      read(child.stdout, outDiagnostic),
      read(child.stderr, errDiagnostic),
      child.exited,
    ]);
    if (timeout)
      throw new DiagnosticError('GIT_TIMEOUT', 'Git operation timed out after 60 seconds.', {
        operation,
        tool: 'git',
        target: directory,
        detail: failureOutput(),
        recovery:
          'Check the Git server and connection; inspect soyli status before retrying a push.',
      });
    if (code !== 0)
      throw new DiagnosticError('GIT_COMMAND', `${operation} failed.`, {
        operation,
        tool: 'git',
        exitCode: code,
        target: directory,
        // merge-tree and other Git commands report actionable failures on stdout.
        // Keep both sanitized streams; never print successful source/diff output here.
        detail: failureOutput(),
        recovery: 'Resolve the Git error shown here, then retry the operation.',
      });
    return stdout;
  } finally {
    clearTimeout(timer);
    if (child.exitCode === null) {
      child.kill('SIGKILL');
      await child.exited;
    }
  }
}
export async function prepareSource(input: {
  directory: string;
  identifier: string;
  title: string;
  origin: string;
  signer: SourceSigner;
  local?: boolean;
  createdAt?: number;
  upstream?: string;
  announcement?: SignedEvent;
  releaseRefs?: Record<string, string>;
}) {
  const origin = graspOrigin(input.origin, input.local);
  const pubkey = await input.signer.getPublicKey();
  const urls = sourceUrls(origin, pubkey, input.identifier, input.local);
  if (!input.title.trim() || input.title.length > 200) throw new Error('Invalid repository title');
  const commit = await sourceGit(input.directory, ['rev-parse', '--verify', 'HEAD^{commit}']);
  const roots = (await sourceGit(input.directory, ['rev-list', '--max-parents=0', 'HEAD'])).split(
    '\n',
  );
  if (!commitPattern.test(commit) || roots.length !== 1 || !commitPattern.test(roots[0]))
    throw new Error(
      'Source publication currently requires a SHA-1 repository with one root commit',
    );
  if (await sourceGit(input.directory, ['status', '--porcelain']))
    throw new Error('Commit source changes before preparing a publication');
  const createdAt = input.createdAt ?? Math.floor(Date.now() / 1000);
  const releaseRefs = Object.entries(input.releaseRefs ?? {});
  if (
    releaseRefs.length > 128 ||
    releaseRefs.some(
      ([ref, commit]) =>
        !/^refs\/tags\/release-[a-f0-9]{16}$/.test(ref) || !commitPattern.test(commit),
    )
  )
    throw new Error('Invalid release refs');
  async function sign(kind: number, tags: string[][]) {
    const template = { kind, created_at: createdAt, content: '', tags };
    const requestedTags = JSON.stringify(tags);
    const event = verifiedEvent(await input.signer.signEvent(template));
    if (
      event.pubkey !== pubkey ||
      event.kind !== kind ||
      event.created_at !== createdAt ||
      event.content !== '' ||
      JSON.stringify(event.tags) !== requestedTags
    )
      throw new Error('Signer changed the source authorization');
    return event;
  }
  return {
    announcement: input.announcement
      ? verifiedEvent(input.announcement)
      : await sign(30617, [
          ['d', input.identifier],
          ['name', input.title],
          ...(input.upstream ? [['u', input.upstream]] : []),
          ['clone', urls.clone],
          ['relays', urls.relay],
          ['r', roots[0], 'euc'],
        ]),
    // This first publishing adapter explicitly owns one main branch. It never pushes private local branches or tags.
    state: await sign(30618, [
      ['d', input.identifier],
      ['refs/heads/main', commit],
      ...releaseRefs,
      ['HEAD', 'ref: refs/heads/main'],
    ]),
  } satisfies SourcePublication;
}
function publicationIdentity(publication: SourcePublication, origin: string, local: boolean) {
  const announcement = verifiedEvent(publication.announcement);
  const state = verifiedEvent(publication.state);
  const single = (e: SignedEvent, key: string, length: number) => {
    const tags = e.tags.filter((t) => t[0] === key);
    if (tags.length !== 1 || tags[0].length !== length)
      throw new Error(`Invalid source ${key} tag`);
    return tags[0][1];
  };
  const identifier = single(announcement, 'd', 2);
  if (
    announcement.kind !== 30617 ||
    state.kind !== 30618 ||
    announcement.pubkey !== state.pubkey ||
    single(state, 'd', 2) !== identifier
  )
    throw new Error('Source announcement and state do not share an identity');
  const urls = sourceUrls(origin, state.pubkey, identifier, local);
  if (
    single(announcement, 'clone', 2) !== urls.clone ||
    single(announcement, 'relays', 2) !== urls.relay
  )
    throw new Error('Source publication targets differ from the selected GRASP server');
  const commit = single(state, 'refs/heads/main', 2);
  if (
    !commitPattern.test(commit) ||
    single(state, 'HEAD', 2) !== 'ref: refs/heads/main' ||
    state.tags.filter((t) => t[0].startsWith('refs/')).length > 129 ||
    state.tags.some(
      (t) =>
        t[0].startsWith('refs/') &&
        t[0] !== 'refs/heads/main' &&
        (!/^refs\/tags\/release-[a-f0-9]{16}$/.test(t[0]) ||
          t.length !== 2 ||
          !commitPattern.test(t[1])),
    ) ||
    new Set(state.tags.filter((t) => t[0].startsWith('refs/')).map((t) => t[0])).size !==
      state.tags.filter((t) => t[0].startsWith('refs/')).length
  )
    throw new Error('Source adapter supports one explicit main branch');
  return {
    announcement,
    state,
    commit,
    refs: state.tags.filter((t) => t[0].startsWith('refs/')),
    ...urls,
  };
}
export async function publishSource(input: {
  directory: string;
  origin: string;
  publication: SourcePublication;
  local?: boolean;
  expectedCommit?: string | null;
}) {
  const identity = publicationIdentity(input.publication, input.origin, input.local ?? false);
  await sourceGit(input.directory, ['cat-file', '-e', `${identity.commit}^{commit}`]);
  const pool = new RelayPool();
  try {
    const relay = pool.relay(identity.relay);
    const ids = [identity.announcement.id, identity.state.id];
    const read = async () =>
      (
        await lastValueFrom(
          relay
            .request({ ids, limit: 2 }, { timeout: 5000, reconnect: false, waitForAuth: false })
            .pipe(toArray()),
        )
      ).map(verifiedEvent);
    const have = new Set((await read()).map((e) => e.id));
    const remoteRefs = await sourceGit(input.directory, [
      'ls-remote',
      identity.clone,
      ...identity.refs.map(([ref]) => ref),
    ]).catch(() => '');
    const refsMatch = (text: string) => {
      const refs = new Map(
        text
          .split('\n')
          .filter(Boolean)
          .map((line) => line.split(/\s+/).reverse() as [string, string]),
      );
      return identity.refs.every(([ref, commit]) => refs.get(ref) === commit);
    };
    const head =
      remoteRefs
        .split('\n')
        .find((line) => line.endsWith('\trefs/heads/main'))
        ?.split(/\s/)[0] ?? null;
    if (
      input.expectedCommit !== undefined &&
      head !== input.expectedCommit &&
      head !== identity.commit
    )
      throw new Error('Source branch changed since publication preparation');
    if (ids.every((id) => have.has(id)) && refsMatch(remoteRefs))
      return { ...identity, changed: false };
    for (const event of [identity.announcement, identity.state]) {
      if (have.has(event.id)) continue;
      const result = await relay.publish(event, {
        timeout: 5000,
        retries: false,
        reconnect: false,
      });
      if (!result.ok) throw new Error(`GRASP rejected source event: ${result.message}`);
    }
    // State may be accepted into GRASP purgatory until this exact commit is received.
    await sourceGit(input.directory, [
      'push',
      ...(input.expectedCommit === undefined
        ? ['--force']
        : [`--force-with-lease=refs/heads/main:${head ?? ''}`]),
      '--no-verify',
      identity.clone,
      ...identity.refs.map(([ref, commit]) => `${commit}:${ref}`),
    ]);
    for (let attempt = 0; attempt < 30; attempt++) {
      const returned = new Set((await read()).map((e) => e.id));
      if (ids.every((id) => returned.has(id))) {
        const refs = await sourceGit(input.directory, [
          'ls-remote',
          identity.clone,
          ...identity.refs.map(([ref]) => ref),
        ]);
        if (!refsMatch(refs)) throw new Error('GRASP served a different commit after publication');
        return { ...identity, changed: true };
      }
      await Bun.sleep(100);
    }
    throw new Error(
      'Source bytes were pushed but signed metadata has not become queryable; retry the same publication',
    );
  } finally {
    pool.close();
  }
}
