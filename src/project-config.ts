import { sha256 } from '../packages/protocol/src';
import { effectiveProject, readBinding, writeBinding } from '../packages/publish/src/binding';
import { developmentAuthor } from './backend';
import { rename, rm, writeFile, lstat } from 'node:fs/promises';
import { join } from 'node:path';
import { realpath as realDirectory } from 'node:fs/promises';
import {
  PublishError,
  projectSchema,
  resolveTargets,
  type Project,
  recordingSchema,
  type Recording,
} from '../packages/publish/src/config';
import { inspectProject, regularFile } from '../packages/publish/src/project';
import type { Network } from '../packages/identity/src/signer';
import { inspectPreviewVideo } from '../packages/protocol/src/preview-video';
import { checkPublication } from './publish-check';

async function readProject(directory: string) {
  const root = await realDirectory(directory);
  const bytes = await regularFile(root, 'napplet.json', 16384);
  try {
    return {
      root,
      bytes,
      project: projectSchema.parse(JSON.parse(new TextDecoder().decode(bytes))),
    };
  } catch (cause) {
    throw new PublishError('PROJECT_CONFIG', 'Invalid napplet.json.', 'check', false, cause);
  }
}
async function saveProject(root: string, original: Uint8Array, project: Project) {
  if (!Buffer.from(await regularFile(root, 'napplet.json', 16384)).equals(Buffer.from(original)))
    throw new PublishError(
      'PROJECT_CHANGED',
      'Configuration changed while checking. Retry with the current file.',
    );
  const temporary = join(root, `.napplet-config-${crypto.randomUUID()}.tmp`);
  try {
    await writeFile(temporary, JSON.stringify(project, null, 2) + '\n', { flag: 'wx' });
    await rename(temporary, join(root, 'napplet.json'));
  } finally {
    await rm(temporary, { force: true });
  }
}

/** No account, build, signing or network access is needed to inspect destinations. */
export async function projectConfiguration(
  directory: string,
  network: Network,
  initialize = false,
) {
  const { root, bytes, project: portable } = await readProject(directory);
  const project = await effectiveProject(root, portable);
  const targets = resolveTargets(project, network);
  if (initialize) {
    project.publish = {
      ...project.publish,
      networks: {
        ...project.publish?.networks,
        [network]: { ...project.publish?.networks?.[network], ...targets },
      },
    };
    const binding = (await readBinding(root)) ?? { version: 1 as const, project: {} };
    binding.project.publish = project.publish;
    await writeBinding(root, binding);
  }
  return {
    binding: join(root, '.napplet-space/project.json'),
    file: join(root, 'napplet.json'),
    network,
    targets,
    runtime: { relays: project.relays, servers: project.servers },
    manifest: {
      format: 'standalone',
      description:
        project.description.trim() || project.title?.trim() || project.name.trim() || 'A napplet.',
      requires: project.requires,
      optionalDomains: project.optionalDomains ?? [],
      archetypes: project.archetypes ?? [],
      intents: project.intents ?? [],
      icon: project.icon ?? null,
    },
    preview: {
      ...(project.preview?.image ? { image: project.preview.image } : { capture: 'automatic' }),
      delayMs: project.preview?.delayMs ?? 1500,
      readySelector: project.preview?.readySelector ?? null,
      video: project.preview?.video ?? null,
      recording: project.preview?.recording ?? { startMs: 0, durationMs: 6000, actions: [] },
    },
  };
}

/** Save a reviewable project image without overwriting an existing asset or publishing anything. */
export async function screenshotProject(
  directory: string,
  network: Network,
  name = 'preview.png',
  interactive = false,
  signal?: AbortSignal,
) {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,120}\.png$/.test(name))
    throw new PublishError(
      'PREVIEW_PATH',
      'Choose a PNG filename in the project root, such as preview-2.png.',
    );
  const { root, bytes, project } = await readProject(directory);
  const { plan, contents, fingerprint } = await inspectProject(
    root,
    network,
    (await effectiveProject(root, project)).creator?.pubkey ?? developmentAuthor,
  );
  const checked = await checkPublication(contents, true, undefined, interactive, signal);
  if ((await inspectProject(root, network, plan.pubkey)).fingerprint !== fingerprint)
    throw new PublishError(
      'PROJECT_CHANGED',
      'Source changed during capture. Build and capture again.',
    );
  const path = join(root, name);
  try {
    await writeFile(path, checked.preview, { flag: 'wx' });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST')
      throw new PublishError(
        'PREVIEW_EXISTS',
        'This image already exists. Use screenshot preview-2.png to keep it and capture a new image.',
      );
    throw error;
  }
  try {
    project.preview = { ...project.preview, image: name };
    await saveProject(root, bytes, project);
  } catch (error) {
    await rm(path, { force: true });
    throw error;
  }
  return {
    image: path,
    artifactHash: plan.artifactHash,
    bytes: checked.preview.length,
    selected: 'preview.image in napplet.json',
  };
}

/** A fresh bounded recording of the exact build, with optional timed keyboard/click actions. */
export async function recordProject(
  directory: string,
  network: Network,
  name = 'preview.webm',
  settings?: Recording,
  interactive = false,
  signal?: AbortSignal,
) {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,120}\.webm$/.test(name))
    throw new PublishError('PREVIEW_PATH', 'Choose a WebM filename in the project root.');
  const { root, bytes, project } = await readProject(directory);
  if (
    (await lstat(join(root, name)).catch(() => null)) ||
    (await lstat(join(root, name + '.json')).catch(() => null))
  )
    throw new PublishError(
      'PREVIEW_EXISTS',
      'This clip already exists. Use record preview-2.webm to preserve it.',
    );
  const { plan, contents, fingerprint } = await inspectProject(
    root,
    network,
    (await effectiveProject(root, project)).creator?.pubkey ?? developmentAuthor,
  );
  const recording = recordingSchema.parse(settings ?? project.preview?.recording ?? {});
  const checked = await checkPublication(contents, false, recording, interactive, signal);
  if (!checked.video) throw new PublishError('PREVIEW_VIDEO', 'No clip was recorded.');
  if ((await inspectProject(root, network, plan.pubkey)).fingerprint !== fingerprint)
    throw new PublishError(
      'PROJECT_CHANGED',
      'Source changed during recording. Build and record again.',
    );
  const path = join(root, name);
  try {
    await writeFile(path, checked.video, { flag: 'wx' });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST')
      throw new PublishError(
        'PREVIEW_EXISTS',
        'This clip already exists. Use record preview-2.webm to preserve it.',
      );
    throw error;
  }
  let sidecarCreated = false;
  try {
    project.preview = {
      ...project.preview,
      video: { file: name, artifactHash: plan.artifactHash },
      recording,
    };
    await writeFile(
      path + '.json',
      JSON.stringify({
        hash: await sha256(checked.video),
        artifactHash: plan.artifactHash,
      }) + '\n',
      { flag: 'wx' },
    );
    sidecarCreated = true;
    await saveProject(root, bytes, project);
  } catch (error) {
    await rm(path, { force: true });
    if (sidecarCreated) await rm(path + '.json', { force: true });
    throw error;
  }
  return {
    video: path,
    bytes: checked.video.length,
    ...inspectPreviewVideo(checked.video),
    selected: 'preview.video in napplet.json',
  };
}
