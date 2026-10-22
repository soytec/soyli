import { Database } from 'bun:sqlite';
import { mkdir, lstat, open, rename, rm, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import {
  readAssets,
  assetBytes,
  importAsset,
  saveAssets,
  ASSET_LOCK,
  MAX_ASSET_BYTES,
  assetMime,
} from '../packages/assets/src';
import {
  PublishError,
  projectSchema,
  projectTopics,
  resolveTargets,
  targetsSchema,
} from '../packages/publish/src/config';
import { effectiveProject, readBinding, writeBinding } from '../packages/publish/src/binding';
import { regularFile } from '../packages/publish/src/project';
import { sha256 } from '../packages/protocol/src';
import { inspectPreviewVideo } from '../packages/protocol/src/preview-video';
import { sourceGit } from '../packages/grasp/src/client';
import type { Network } from '../packages/identity/src/signer';

async function state(root: string) {
  const config = await regularFile(root, 'napplet.json', 16384);
  const binding = await readBinding(root);
  const assets = await readAssets(root);
  return {
    config,
    binding,
    assets,
    revision: await sha256(
      Buffer.concat([config, Buffer.from(JSON.stringify({ binding, assets }))]),
    ),
  };
}
export async function manageProject(root: string, network: Network) {
  const current = await state(root);
  const project = await effectiveProject(
    root,
    projectSchema.parse(JSON.parse(new TextDecoder().decode(current.config))),
  );
  const targets = resolveTargets(project, network);
  const assets = [];
  for (const asset of current.assets.assets) {
    let error: string | null = null;
    try {
      await assetBytes(root, asset);
    } catch {
      error = 'Missing or changed. Restore the original or import a new asset.';
    }
    assets.push({
      ...asset,
      error,
      url: `/manager/asset/${asset.hash}`,
      destination:
        asset.storage === 'external'
          ? `${targets.blossom}/${asset.hash}`
          : 'Embedded in the built HTML',
    });
  }
  const presentation = (await readdir(root))
    .filter((name) => /^(?:preview|presentation)[a-zA-Z0-9._-]*\.(png|webm)$/.test(name))
    .slice(0, 48);
  return {
    revision: current.revision,
    project: {
      name: project.name,
      title: project.title ?? project.name,
      description: project.description,
      topics: project.topics,
      license: project.license,
      requires: project.requires,
      optionalDomains: project.optionalDomains ?? [],
      archetypes: project.archetypes ?? [],
      intents: project.intents ?? [],
      icon: project.icon ?? null,
    },
    targets,
    preview: project.preview ?? {},
    assets,
    presentation,
    git: await sourceGit(root, ['-c', 'core.fsmonitor=false', 'status', '--short']).catch(
      () => 'Git unavailable',
    ),
    storage: {
      runtimePerFile: MAX_ASSET_BYTES,
      managedTotal: 32 * 1024 * 1024,
      sourceTotal: 40 * 1024 * 1024,
      providerAllowance: null,
      used: assets.reduce((n, a) => n + a.bytes, 0),
    },
  };
}
const changesSchema = z
  .object({
    name: z.string().min(1).max(160),
    title: z.string().min(1).max(160),
    description: z.string().max(1000),
    license: z.string().min(1).max(100),
    topics: z.array(z.string().max(256)).max(32),
    requires: projectSchema.shape.requires.removeDefault().optional(),
    optionalDomains: projectSchema.shape.optionalDomains,
    archetypes: projectSchema.shape.archetypes,
    intents: projectSchema.shape.intents,
    icon: projectSchema.shape.icon.nullable(),
  })
  .strict();
export const managerAction = z.discriminatedUnion('action', [
  z.object({ action: z.literal('project'), revision: z.string(), changes: changesSchema }).strict(),
  z.object({ action: z.literal('targets'), revision: z.string(), targets: targetsSchema }).strict(),
  z
    .object({
      action: z.literal('asset'),
      revision: z.string(),
      id: z.string(),
      storage: z.enum(['embedded', 'external']),
      license: z.string(),
      source: z.string().optional(),
      data: z.string().max(14 * 1024 * 1024),
    })
    .strict(),
  z
    .object({
      action: z.literal('asset-update'),
      revision: z.string(),
      id: z.string(),
      storage: z.enum(['embedded', 'external']),
      license: z.string().min(1).max(160),
      source: z.string().max(500),
    })
    .strict(),
  z.object({ action: z.literal('asset-remove'), revision: z.string(), id: z.string() }).strict(),
  z.object({ action: z.literal('asset-sync'), revision: z.string() }).strict(),
  z
    .object({
      action: z.literal('select'),
      revision: z.string(),
      kind: z.enum(['image', 'video']),
      file: z.string().max(200).nullable(),
    })
    .strict(),
]);
export async function editProject(root: string, network: Network, input: unknown) {
  const parsed = managerAction.safeParse(input);
  if (!parsed.success)
    throw new PublishError(
      'PROJECT_EDIT',
      typeof input === 'object' && input !== null && 'action' in input && input.action === 'project'
        ? 'Invalid project metadata. Supply a flat object with name, title, description, topics and license, plus optional discovery fields; do not pass the whole project show response. Each intent supports at most 14 parameter names. Check metadata lengths and icon format.'
        : 'Invalid edit. Check names, metadata lengths, storage mode and destinations.',
      'check',
      false,
      parsed.error,
    );
  const action = parsed.data;
  await mkdir(join(root, '.napplet-space'), { recursive: true, mode: 0o700 });
  if ((await lstat(join(root, '.napplet-space'))).isSymbolicLink())
    throw new PublishError('PROJECT_EDIT', 'Unsafe project state directory.');
  const lockPath = join(root, '.napplet-space/manager-lock.sqlite');
  if ((await lstat(lockPath).catch(() => null))?.isSymbolicLink())
    throw new PublishError('PROJECT_EDIT', 'Unsafe edit lock.');
  const db = new Database(lockPath, { create: true });
  try {
    db.exec('PRAGMA busy_timeout=0; BEGIN EXCLUSIVE');
    const current = await state(root);
    if (current.revision !== action.revision)
      throw new PublishError(
        'PROJECT_EDIT',
        'Project changed in your editor or another window. Reload before saving; your edits have not been applied.',
      );
    const project = projectSchema.parse(JSON.parse(new TextDecoder().decode(current.config)));
    if (action.action === 'targets') {
      const effective = await effectiveProject(root, project);
      resolveTargets(effective, network, action.targets);
      const binding = current.binding ?? {
        version: 1 as const,
        project: {
          creator: effective.creator,
          identifier: effective.identifier,
          previewId: effective.previewId,
          remix: effective.remix,
          backend: effective.backend,
        },
      };
      binding.project.publish = {
        ...effective.publish,
        networks: {
          ...effective.publish?.networks,
          [network]: { ...effective.publish?.networks?.[network], ...action.targets },
        },
      };
      await writeBinding(root, binding);
    } else if (action.action === 'asset') {
      if (!/^[A-Za-z0-9+/]*={0,2}$/.test(action.data))
        throw new PublishError('PROJECT_EDIT', 'Invalid file upload.');
      await importAsset(root, {
        ...action,
        bytes: new Uint8Array(Buffer.from(action.data, 'base64')),
      });
    } else if (['asset-remove', 'asset-sync', 'asset-update'].includes(action.action)) {
      if (action.action === 'asset-remove')
        current.assets.assets = current.assets.assets.filter((a) => a.id !== action.id);
      if (action.action === 'asset-update') {
        const asset = current.assets.assets.find((a) => a.id === action.id);
        if (!asset) throw new PublishError('PROJECT_EDIT', 'Asset not found.');
        Object.assign(asset, {
          storage: action.storage,
          license: action.license,
          source: action.source,
        });
        await assetBytes(root, asset);
      }
      await saveAssets(root, current.assets);
    } else {
      if (action.action === 'project') {
        Object.assign(project, action.changes);
        if (action.changes.icon === null) delete project.icon;
        if (project.icon) {
          const bytes = await regularFile(root, project.icon.file, 5 * 1024 * 1024);
          const mime = assetMime(bytes);
          if (
            !['image/png', 'image/jpeg', 'image/webp'].includes(mime) ||
            (project.icon.mime && mime !== project.icon.mime)
          )
            throw new PublishError(
              'PROJECT_EDIT',
              'Choose a PNG, JPEG or WebP icon with a matching MIME type.',
            );
        }
        project.topics = projectTopics(project);
      } else if (action.action === 'select') {
        project.preview ??= {};
        if (action.kind === 'image') {
          if (!action.file) delete project.preview.image;
          else {
            const image = await regularFile(root, action.file, 5 * 1024 * 1024);
            if (
              image.length < 33 ||
              Buffer.from(image.subarray(0, 8)).toString('hex') !== '89504e470d0a1a0a'
            )
              throw new PublishError('PROJECT_EDIT', 'Select a PNG screenshot.');
            project.preview.image = action.file;
          }
        } else {
          if (!action.file) delete project.preview.video;
          else {
            // Only keep the recorded build association; never bless an old clip as a new build.
            const metadata = JSON.parse(
              new TextDecoder().decode(await regularFile(root, action.file + '.json', 4096)),
            );
            const bytes = await regularFile(root, action.file, 5 * 1024 * 1024);
            inspectPreviewVideo(bytes);
            if (
              metadata.hash !== (await sha256(bytes)) ||
              !/^[a-f0-9]{64}$/.test(metadata.artifactHash)
            )
              throw new PublishError('PROJECT_EDIT', 'Clip provenance is invalid. Record again.');
            project.preview.video = { file: action.file, artifactHash: metadata.artifactHash };
          }
        }
      }
      projectSchema.parse(project);
      if (
        !Buffer.from(await regularFile(root, 'napplet.json', 16384)).equals(
          Buffer.from(current.config),
        )
      )
        throw new PublishError('PROJECT_EDIT', 'Project changed while saving. Reload and retry.');
      const temp = join(root, `.soyli-project-${crypto.randomUUID()}.tmp`);
      const file = await open(temp, 'wx', 0o600);
      try {
        await file.writeFile(JSON.stringify(project, null, 2) + '\n');
        await file.sync();
        await file.close();
        await rename(temp, join(root, 'napplet.json'));
      } finally {
        await file.close();
        await rm(temp, { force: true });
      }
    }
    return await manageProject(root, network);
  } finally {
    db.close();
  }
}
