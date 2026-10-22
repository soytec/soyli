import { readAssets } from '../../packages/assets/src';
import { effectiveProject } from '../../packages/publish/src/binding';
import {
  inspectPreviewVideo,
  MAX_VIDEO_BYTES,
} from '../../packages/protocol/src/preview-video';
import {
  projectSchema,
  projectIdentity,
  projectTopics,
  resolveTargets,
} from '../../packages/publish/src/config';
import { regularFile } from '../../packages/publish/src/project';
import { MAX_PREVIEW_BYTES } from '../../packages/protocol/src/preview';
import { encodeAddress, sha256 } from '../../packages/protocol/src';
import { missingDomains } from '../../packages/runtime/src/capabilities';
import type { Network } from '../../packages/identity/src/signer';
import { builtConfiguration, builtRequirements } from '../../packages/publish/src/artifact';
import {
  MAX_ARTIFACT_BYTES,
  MAX_READ_ARTIFACT_BYTES,
} from '../../packages/protocol/src/artifact';

async function projectAt(root: string) {
  return projectSchema.parse(
    JSON.parse(new TextDecoder().decode(await regularFile(root, 'napplet.json', 16384))),
  );
}
export async function listingImage(root: string) {
  const config = await projectAt(root);
  if (!config.preview?.image) throw new Error('No screenshot selected.');
  const bytes = await regularFile(root, config.preview.image, MAX_PREVIEW_BYTES);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (
    bytes.length < 33 ||
    Buffer.from(bytes.subarray(0, 8)).toString('hex') !== '89504e470d0a1a0a' ||
    Buffer.from(bytes.subarray(12, 16)).toString() !== 'IHDR' ||
    !view.getUint32(16) ||
    !view.getUint32(20) ||
    view.getUint32(16) > 4096 ||
    view.getUint32(20) > 4096
  )
    throw new Error('Select a PNG up to 4096 × 4096 and 5 MiB.');
  return {
    bytes,
    width: view.getUint32(16),
    height: view.getUint32(20),
    hash: await sha256(bytes),
  };
}

export async function listingVideo(root: string) {
  const config = await projectAt(root);
  if (!config.preview?.video) throw new Error('No preview clip selected.');
  const bytes = await regularFile(root, config.preview.video.file, MAX_VIDEO_BYTES);
  return { bytes, ...inspectPreviewVideo(bytes), hash: await sha256(bytes) };
}

/** Only public project settings and the explicitly selected image are exposed. */
export async function listingPreview(
  root: string,
  network: Network,
  captureAvailable: boolean,
  recordingAvailable = false,
) {
  const project = await effectiveProject(root, await projectAt(root));
  const targets = resolveTargets(project, network);
  const warnings: string[] = [];
  let artifact: { bytes: number; hash: string } | null = null;
  let requires = [...project.requires];
  try {
    if ((await readAssets(root)).assets.some((asset) => asset.storage === 'external'))
      requires.push('resource');
  } catch {
    warnings.push('Managed asset inventory is invalid. Run soyli assets list and repair it.');
  }
  let configuration: { properties: number; version: number | null } | null = null;
  try {
    const bytes = await regularFile(root, project.entry, MAX_READ_ARTIFACT_BYTES);
    artifact = { bytes: bytes.length, hash: await sha256(bytes) };
    if (bytes.length > MAX_ARTIFACT_BYTES)
      warnings.push(
        'This app can be previewed, but soyLI publication requires HTML at or below 25 MiB.',
      );
    try {
      const schema = await builtConfiguration(bytes);
      if (schema)
        configuration = {
          properties: Object.keys(schema.properties ?? {}).length,
          version: schema.$version ?? null,
        };
    } catch {
      warnings.push('The built settings schema is invalid. Check config.schema.json and rebuild.');
    }
    requires = [
      ...new Set([
        ...requires,
        ...(project.entry === 'dist/index.html' ? await builtRequirements(bytes) : []),
      ]),
    ];
  } catch {
    warnings.push('The built app is unavailable. Build the project before checking or publishing.');
  }
  let image: { url: string; width: number; height: number; file: string } | null = null;
  if (project.preview?.image) {
    try {
      const selected = await listingImage(root);
      image = {
        url: `/listing/preview.png?v=${selected.hash}`,
        width: selected.width,
        height: selected.height,
        file: project.preview.image,
      };
    } catch (error) {
      warnings.push(
        `Screenshot: ${error instanceof Error ? error.message : 'Cannot read selected image.'}`,
      );
    }
  } else
    warnings.push(
      'No screenshot selected yet. Capture one to review it; publishing otherwise captures one automatically.',
    );
  let video: {
    url: string;
    width: number;
    height: number;
    durationMs: number;
    bytes: number;
    file: string;
    stale: boolean;
  } | null = null;
  if (project.preview?.video) {
    try {
      const selected = await listingVideo(root);
      video = {
        url: `/listing/preview.webm?v=${selected.hash}`,
        width: selected.width,
        height: selected.height,
        durationMs: selected.durationMs,
        bytes: selected.bytes.length,
        file: project.preview.video.file,
        stale: artifact?.hash !== project.preview.video.artifactHash,
      };
      if (video.stale)
        warnings.push(
          'The clip belongs to an older build. Record again or remove preview.video before publishing.',
        );
    } catch {
      warnings.push('The selected preview video is unavailable or invalid. Record a new clip.');
    }
  }
  if (!project.description.trim())
    warnings.push('Add a description so visitors know what to expect.');
  if (!project.topics.length) warnings.push('Add topics so visitors can find your napplet by tag.');
  if (!project.creator)
    warnings.push('No creator identity selected. Connect or create an account before publishing.');
  const unsupported = missingDomains(requires);
  if (unsupported.length)
    warnings.push(`This host cannot run required capabilities: ${unsupported.join(', ')}.`);
  const naddr = project.creator
    ? encodeAddress(
        { kind: 35129, pubkey: project.creator.pubkey, identifier: projectIdentity(project) },
        [targets.relay, ...targets.mirrors],
      )
    : null;
  return {
    title: project.title ?? project.name,
    name: project.name,
    description: project.description,
    topics: projectTopics(project),
    license: project.license,
    identifier: projectIdentity(project),
    creator: project.creator?.pubkey ?? null,
    network,
    targets,
    runtime: {
      requires,
      optionalDomains: project.optionalDomains ?? [],
      relays: project.relays,
      servers: project.servers,
      configuration,
    },
    discovery: {
      archetypes: project.archetypes ?? [],
      intents: project.intents ?? [],
      icon: project.icon ?? null,
    },
    artifact,
    image,
    video,
    recording: project.preview?.recording ?? { startMs: 0, durationMs: 6000, actions: [] },
    recordingAvailable,
    warnings,
    captureAvailable,
    page: naddr ? `${targets.site}/n/${naddr}` : null,
  };
}
export type ListingPreview = Awaited<ReturnType<typeof listingPreview>>;
