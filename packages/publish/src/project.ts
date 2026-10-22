import { relatedAssetHtml } from '../../assets/src/related';
import { validateAssets, ASSET_LOCK, ASSET_MODULE, ASSET_TYPES, assetMime } from '../../assets/src';
import { constants } from 'node:fs';
import { lstat, mkdir, open, realpath, rm } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { sha256, MAX_ARTIFACT_BYTES } from '../../protocol/src';
import { missingDomains } from '../../runtime/src/capabilities';
import { sourceGit } from '../../grasp/src/client';
import {
  projectSchema,
  projectIdentity,
  projectTopics,
  sourceDefaults,
  resolveTargets,
  projectRepositoryReference,
  PublishError,
  type Targets,
} from './config';
import type { Network } from '../../identity/src/signer';
import { builtRequirements } from './artifact';
import { effectiveProject } from './binding';
import { committedSource, inspectHistory } from './git-source';
import { readModule } from '../../dynamic-backends/src/module-source';
import { MAX_SOURCE_FILES } from './limits';
import { createSourceFileReader } from './source-links';
import { materializeSourceArchive } from './source-archive';

export const MAX_SOURCE_BYTES = 40 * 1024 * 1024;
export type SourceFile = { path: string; hash: string; size: number };
export async function regularFile(root: string, path: string, limit: number) {
  if (
    !path ||
    path.length > 200 ||
    path.startsWith('/') ||
    path.split('/').some((p) => !p || p === '.' || p === '..') ||
    /[\\\s\u0000-\u001f\u007f]/.test(path)
  )
    throw new PublishError(
      'SOURCE_PATH',
      'Source paths must be relative regular files without traversal, whitespace or symlinks.',
    );
  let current = root;
  for (const part of path.split('/')) {
    current = join(current, part);
    if ((await lstat(current)).isSymbolicLink())
      throw new PublishError(
        'SOURCE_PATH',
        `Path ${path} must be a regular file. Public source aliases are supported separately, but configuration, playable artifacts, managed assets and presentation files cannot be symlinks.`,
      );
  }
  const file = await open(current, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = await file.stat();
    if (!stat.isFile() || stat.size > limit)
      throw new PublishError(
        'SOURCE_LIMIT',
        'A source file exceeds the supported size or is not a regular file.',
      );
    const bytes = await file.readFile();
    if (bytes.length > limit)
      throw new PublishError('SOURCE_LIMIT', 'Source changed beyond its size limit while reading.');
    return new Uint8Array(bytes);
  } finally {
    await file.close();
  }
}
export function checkSource(path: string, bytes: Uint8Array) {
  if (path.startsWith('target/'))
    throw new PublishError(
      'SOURCE_GENERATED',
      'Rust target/ build caches must not be published. Add /target/ to .gitignore and remove tracked build caches; retain Cargo.toml, Cargo.lock and rust-toolchain.toml.',
    );
  if (
    path
      .split('/')
      .some((p) =>
        /^(?:\.git|\.napplet-space|node_modules|\.env(?:\..*)?|.*\.(?:pem|key|p12|pfx|ncryptsec))$/i.test(
          p,
        ),
      ) ||
    /(?:^|\/)(?:accounts\.json|id_rsa|id_ed25519)$/.test(path)
  )
    throw new PublishError(
      'SOURCE_SECRET',
      'The source contains a private or generated path. Keep private and generated files out of public source and Git history.',
    );
  checkSourceContent(bytes);
}
export function checkSourceContent(bytes: Uint8Array) {
  const text = new TextDecoder().decode(bytes);
  if (
    /nsec1[023456789acdefghjklmnpqrstuvwxyz]{58}|ncryptsec1[023456789acdefghjklmnpqrstuvwxyz]{30,}|-----BEGIN [A-Z ]*PRIVATE KEY-----|bunker:\/\/[^\s"'<>]+[?&]secret=|(?:sk-(?:proj-)?[A-Za-z0-9_-]{24,}|ghp_[A-Za-z0-9]{30,})/.test(
      text,
    )
  )
    throw new PublishError(
      'SOURCE_SECRET',
      'A selected source file contains a likely credential. Remove it before publishing. Secret values are never printed.',
    );
}
export async function inspectProject(
  directory: string,
  network: Network,
  pubkey: string,
  overrides: Partial<Targets> = {},
  frozenCommit?: string,
  frozenFiles?: string[],
  manifestFormat: 'standalone' | 'legacy' = 'standalone',
) {
  const root = await realpath(directory);
  let configBytes = await regularFile(root, 'napplet.json', 16384);
  let project;
  try {
    project = projectSchema.parse(
      JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(configBytes)),
    );
  } catch (cause) {
    throw new PublishError(
      'PROJECT_CONFIG',
      'Invalid napplet.json. Check the entry and manifest metadata: optionalDomains contains bare NAP names, archetypes contains labels, intents contains queryless intent/parameters objects with at most 14 parameter names each, and icon.file names a local PNG, JPEG or WebP.',
      'check',
      false,
      cause,
    );
  }
  project = await effectiveProject(root, project);
  // A scaffold's public creator reference is a hint, not authority over the user's
  // account selection. Frozen jobs alone retain their already-reviewed author.
  if (!frozenCommit) project = projectSchema.parse({ ...project, creator: { pubkey, network } });
  configBytes = new TextEncoder().encode(JSON.stringify(project, null, 2) + '\n');
  if (project.creator && (project.creator.pubkey !== pubkey || project.creator.network !== network))
    throw new PublishError(
      'CREATOR_MISMATCH',
      'This frozen release belongs to another creator or network. Keep its original author when resuming; do not switch accounts automatically.',
    );
  const targets = resolveTargets(project, network, overrides);
  const managed = await validateAssets(root);
  const built = project.entry === 'dist/index.html';
  const defaults = !frozenCommit
    ? (
        await sourceGit(root, [
          '-c',
          'core.fsmonitor=false',
          'ls-files',
          '--cached',
          '--others',
          '--exclude-standard',
          '-z',
        ]).catch(() => sourceDefaults.join('\0'))
      )
        .split('\0')
        .filter(Boolean)
    : sourceDefaults;
  const selected = [
    ...new Set([
      ...(frozenFiles ?? [...defaults, ...(project.publish?.files ?? [])]),
      ...(built ? [project.entry] : []),
      ...(managed.assets.length
        ? [ASSET_LOCK, ASSET_MODULE, ASSET_TYPES, ...managed.assets.map((a) => a.path)]
        : []),
      ...(project.preview?.image ? [project.preview.image] : []),
      ...(project.preview?.video ? [project.preview.video.file] : []),
      ...(project.icon ? [project.icon.file] : []),
    ]),
  ].sort();
  if (selected.length > MAX_SOURCE_FILES)
    throw new PublishError(
      'SOURCE_LIMIT',
      `This project selects ${selected.length} publication inputs; soyLI supports up to ${MAX_SOURCE_FILES}. The total includes Git-tracked and unignored files, the built entry and presentation assets. publish.files is additive and cannot exclude tracked files. Remove unnecessary files from Git tracking and ignore them before saving a checkpoint, or split a larger project.`,
    );
  if (!['index.html', 'napplet.json', 'LICENSE'].every((p) => selected.includes(p)))
    throw new PublishError(
      'SOURCE_REQUIRED',
      'publish.files must include index.html, napplet.json and LICENSE.',
    );
  const files: SourceFile[] = [],
    contents = new Map<string, Uint8Array>();
  const sourceFile = await createSourceFileReader(root, new Set(selected), {
    regularFile,
    checkSource,
  });
  const strictFiles = new Set([
    'index.html',
    project.entry,
    ASSET_LOCK,
    ASSET_MODULE,
    ASSET_TYPES,
    ...managed.assets.map((asset) => asset.path),
    project.preview?.image,
    project.preview?.video?.file,
    project.icon?.file,
  ]);
  let total = 0;
  for (const path of selected) {
    let bytes: Uint8Array;
    try {
      bytes =
        path === 'napplet.json'
          ? configBytes
          : strictFiles.has(path)
            ? await regularFile(
                root,
                path,
                path === project.entry ? MAX_ARTIFACT_BYTES : MAX_SOURCE_BYTES,
              )
            : await sourceFile(path, MAX_SOURCE_BYTES);
    } catch (error) {
      if (path === project.entry && (error as NodeJS.ErrnoException).code === 'ENOENT')
        throw new PublishError(
          'ARTIFACT_MISSING',
          'Build the project before checking or publishing: soyli build.',
        );
      if (
        (error as NodeJS.ErrnoException).code === 'ENOENT' &&
        !project.publish?.files &&
        ![
          'index.html',
          'LICENSE',
          project.preview?.image,
          project.preview?.video?.file,
          project.icon?.file,
        ].includes(path)
      )
        continue;
      throw error;
    }
    total += bytes.length;
    if (total > MAX_SOURCE_BYTES)
      throw new PublishError('SOURCE_LIMIT', 'Keep the selected source under 40 MiB.');
    checkSource(path, bytes);
    contents.set(path, bytes);
    files.push({ path, hash: await sha256(bytes), size: bytes.length });
  }
  for (const path of project.backend?.modules ?? [])
    await readModule(path, async (file) => {
      const bytes = contents.get(file);
      if (!bytes)
        throw new PublishError(
          'SOURCE_REQUIRED',
          `Backend source is missing from the snapshot: ${file}. Track every declared module manifest, handler and schema, and include them in publish.files when selecting source explicitly.`,
        );
      // Backend build inputs retain their existing regular-file contract.
      await regularFile(root, file, MAX_SOURCE_BYTES);
      return bytes;
    });
  if (
    project.build?.kind === 'rust' &&
    !['Cargo.toml', 'Cargo.lock', 'rust-toolchain.toml'].every((path) => contents.get(path)?.length)
  )
    throw new PublishError(
      'RUST_SOURCE',
      'Rust publications must retain nonempty Cargo.toml, Cargo.lock and rust-toolchain.toml in public source. Track these files before publishing or proposing changes.',
    );
  if (!contents.get('LICENSE')?.length)
    throw new PublishError('SOURCE_LICENSE', 'Provide a nonempty LICENSE file before publishing.');
  const originalHtml = contents.get(project.entry)!;
  try {
    if (!new TextDecoder('utf-8', { fatal: true }).decode(originalHtml).trim()) throw new Error();
  } catch {
    throw new PublishError('ARTIFACT_INVALID', 'index.html must be nonempty UTF-8 HTML.');
  }
  // Frozen publications already contain the reviewed bytes, including older jobs
  // that predate related links. Never retrofit metadata during a retry.
  const html = frozenCommit ? originalHtml : await relatedAssetHtml(originalHtml, managed);
  if (html.length > MAX_ARTIFACT_BYTES)
    throw new PublishError(
      'ARTIFACT_LIMIT',
      'The HTML including related asset links exceeds 25 MiB.',
    );
  contents.set(project.entry, html);
  const artifactFile = files.find((file) => file.path === project.entry)!;
  total += html.length - originalHtml.length;
  if (total > MAX_SOURCE_BYTES)
    throw new PublishError('SOURCE_LIMIT', 'Keep the selected source under 40 MiB.');
  artifactFile.hash = await sha256(html);
  artifactFile.size = html.length;
  const requires = [
    ...new Set([
      ...project.requires,
      ...(managed.assets.some((a) => a.storage === 'external') ? ['resource'] : []),
      ...(built ? await builtRequirements(html) : []),
    ]),
  ];
  const missing = missingDomains(requires);
  if (missing.length)
    throw new PublishError(
      'PROJECT_CAPABILITY',
      `Unsupported required domains: ${missing.join(', ')}.`,
    );
  let icon:
    | { file: string; hash: string; bytes: number; mime: 'image/png' | 'image/jpeg' | 'image/webp' }
    | undefined;
  if (project.icon) {
    const bytes = contents.get(project.icon.file)!;
    const mime = assetMime(bytes);
    if (
      !bytes.length ||
      bytes.length > 5 * 1024 * 1024 ||
      !['image/png', 'image/jpeg', 'image/webp'].includes(mime) ||
      (project.icon.mime && project.icon.mime !== mime)
    )
      throw new PublishError(
        'PROJECT_ICON',
        'Use a PNG, JPEG or WebP icon no larger than 5 MiB, with a matching MIME type.',
      );
    icon = {
      file: project.icon.file,
      hash: await sha256(bytes),
      bytes: bytes.length,
      mime: mime as 'image/png' | 'image/jpeg' | 'image/webp',
    };
  }
  const plan = {
    network,
    pubkey,
    identifier: projectIdentity(project),
    title: project.title ?? project.name,
    description:
      manifestFormat === 'standalone'
        ? project.description.trim() || project.title?.trim() || project.name.trim() || 'A napplet.'
        : project.description,
    license: project.license,
    requires,
    topics: projectTopics(project),
    servers: [...new Set([targets.blossom, ...project.servers])],
    targets,
    files,
    artifactHash: await sha256(html),
    sourceBytes: total,
    sourceCommit:
      frozenCommit ?? (await sourceGit(root, ['rev-parse', 'HEAD']).catch(() => '0'.repeat(40))),
    ...(project.remix ? { remix: project.remix } : {}),
    ...(manifestFormat === 'standalone'
      ? {
          manifestFormat: 'standalone' as const,
          ...(project.optionalDomains
            ? {
                optionalDomains: [...new Set(project.optionalDomains)].filter(
                  (d) => !requires.includes(d),
                ),
              }
            : {}),
          ...(project.archetypes ? { archetypes: [...new Set(project.archetypes)] } : {}),
          ...(project.intents
            ? {
                intents: project.intents.map((i) => ({
                  ...i,
                  parameters: [...new Set(i.parameters)],
                })),
              }
            : {}),
          ...(icon ? { icon } : {}),
        }
      : {}),
  };
  return {
    root,
    plan,
    contents,
    fingerprint: await sha256(JSON.stringify(plan)),
    repository: projectRepositoryReference(project, network),
  };
}
export type PublishPlan = Awaited<ReturnType<typeof inspectProject>>['plan'];
export async function durableFile(path: string, bytes: Uint8Array | string) {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const file = await open(path, 'wx', 0o600);
  try {
    await file.writeFile(bytes);
    await file.sync();
  } finally {
    await file.close();
  }
}
/** Freeze actual committed history; built files are separate immutable release inputs. */
export async function freezeSource(
  directory: string,
  contents: Map<string, Uint8Array>,
  createdAt: number,
  parent: { directory: string; commit: string },
) {
  const history = await inspectHistory(parent.directory, parent.commit);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const repo = join(directory, 'source');
  await rm(repo, { recursive: true, force: true });
  await mkdir(repo);
  await sourceGit(repo, ['init']);
  await sourceGit(repo, [
    '-c',
    'protocol.file.allow=always',
    'fetch',
    '--no-tags',
    parent.directory,
    parent.commit,
  ]);
  await sourceGit(repo, ['checkout', '-B', 'main', parent.commit]);
  const frozen = join(directory, 'files');
  await rm(frozen, { recursive: true, force: true });
  for (const [path, bytes] of contents) await durableFile(join(frozen, path), bytes);
  // The exact selection is needed when checking frozen builds outside a Git worktree.
  const commit = parent.commit;
  const archive = join(directory, 'source.tar');
  // The portable archive represents the complete verified tree, not a Git export.
  // info/attributes takes precedence over root/nested .gitattributes (including
  // directory exclusions). Override only the export rules in this private clone;
  // keep the author's attributes, source bytes, history and working repo intact.
  await durableFile(join(repo, '.git/info/attributes'), '* -export-ignore -export-subst\n');
  await sourceGit(repo, ['archive', '--format=tar', `--output=${archive}`, commit]);
  const original = await regularFile(directory, 'source.tar', 50 * 1024 * 1024);
  const bytes = materializeSourceArchive(original, history.aliases);
  const file = await open(archive, 'r+');
  try {
    await file.writeFile(bytes);
    await file.truncate(bytes.length);
    await file.sync();
  } finally {
    await file.close();
  }
  return { commit, archiveHash: await sha256(bytes), archiveBytes: bytes.length };
}
