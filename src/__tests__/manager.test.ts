import { test, expect } from 'bun:test';
import { mkdtemp, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { manageProject, editProject } from '../manager';
import {
  readAssets,
  importAsset,
  assetBytes,
  validateAssets,
  ASSET_LOCK,
} from '../../packages/assets/src';
import { inspectProject } from '../../packages/publish/src/project';
const png = new Uint8Array(
  Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/lS8AAAAASUVORK5CYII=',
    'base64',
  ),
);
test('project set explains incomplete input through the CLI and accepts the documented flat metadata object', async () => {
  const root = await mkdtemp(join(tmpdir(), 'soy-project-edit-cli-'));
  const entry = new URL('../index.ts', import.meta.url).pathname;
  const command = process.env.SPACE_TEST_CLI
    ? [process.env.SPACE_TEST_CLI]
    : [process.execPath, entry];
  try {
    await Bun.write(
      join(root, 'napplet.json'),
      JSON.stringify({
        schema: 'space-local-project/v1',
        name: 'Original',
        entry: 'index.html',
        license: 'MIT',
        previewId: crypto.randomUUID(),
      }),
    );
    const input = join(root, 'metadata.json');
    const run = async () => {
      const child = Bun.spawn(
        [...command, 'project', 'set', input, '--project', root, '--network', 'local', '--json'],
        {
          cwd: root,
          stdin: 'ignore',
          stdout: 'pipe',
          stderr: 'pipe',
          env: { PATH: process.env.PATH, SPACE_ACCOUNT_HOME: join(root, 'accounts') },
        },
      );
      const [code, out, err] = await Promise.all([
        child.exited,
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
      ]);
      return { code, out, err };
    };
    const privateText = 'private-description-do-not-echo';
    await Bun.write(input, JSON.stringify({ description: privateText, requires: ['storage'] }));
    const rejected = await run();
    expect(rejected.code).toBe(1);
    expect(rejected.out + rejected.err).toContain('PROJECT_EDIT');
    expect(rejected.out + rejected.err).toContain(
      'flat object with name, title, description, topics and license',
    );
    expect(rejected.out + rejected.err).not.toContain(privateText);
    expect((await Bun.file(join(root, 'napplet.json')).json()).name).toBe('Original');
    const metadata = {
      name: 'track-editor',
      title: 'Track editor',
      description: 'Draw a racetrack.',
      license: 'MIT',
      topics: ['racing', 'editor'],
      requires: ['storage'],
      optionalDomains: ['theme', 'identity'],
      archetypes: ['track', 'editor'],
      intents: [{ intent: 'napplet:track/edit', parameters: ['track', 'mode'] }],
    };
    await Bun.write(input, JSON.stringify(metadata));
    const accepted = await run();
    expect(accepted.code, accepted.out + accepted.err).toBe(0);
    expect(JSON.parse(accepted.out).project).toMatchObject(metadata);
    expect(await Bun.file(join(root, 'napplet.json')).json()).toMatchObject(metadata);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
test('manager edits shared files, preserves identity/destinations, rejects stale edits and verifies asset source', async () => {
  const root = await mkdtemp(join(tmpdir(), 'soy-manager-'));
  const creator = { pubkey: 'a'.repeat(64), network: 'local' };
  try {
    await Bun.write(
      join(root, 'napplet.json'),
      JSON.stringify({
        schema: 'space-local-project/v1',
        name: 'Demo',
        entry: 'index.html',
        license: 'MIT',
        previewId: crypto.randomUUID(),
        creator,
      }),
    );
    await Bun.write(join(root, 'index.html'), '<!doctype html><p>Demo</p>');
    await Bun.write(join(root, 'LICENSE'), 'MIT');
    let state = await manageProject(root, 'local');
    const before = state;
    state = await editProject(root, 'local', {
      action: 'project',
      revision: state.revision,
      changes: { ...state.project, title: 'New title', description: 'A story', topics: ['#Game'] },
    });
    expect(state.project.topics).toEqual(['game']);
    await expect(
      editProject(root, 'local', {
        action: 'project',
        revision: before.revision,
        changes: before.project,
      }),
    ).rejects.toThrow('Project changed');
    const targets = { ...state.targets, blossom: 'http://127.0.0.1:9123' };
    state = await editProject(root, 'local', {
      action: 'targets',
      revision: state.revision,
      targets,
    });
    expect(state.targets.blossom).toBe(targets.blossom);
    expect(
      (await Bun.file(join(root, '.napplet-space/project.json')).json()).project.creator,
    ).toEqual(creator);
    state = await editProject(root, 'local', {
      action: 'asset',
      revision: state.revision,
      id: 'sprite',
      storage: 'external',
      license: 'CC0',
      data: Buffer.from(png).toString('base64'),
    });
    const asset = state.assets[0];
    expect(asset.mime).toBe('image/png');
    expect(await assetBytes(root, asset)).toEqual(png);
    const inspected = await inspectProject(root, 'local', creator.pubkey);
    expect(inspected.plan.requires).toContain('resource');
    expect(inspected.contents.get(asset.path)).toEqual(png);
    expect(inspected.contents.has(ASSET_LOCK)).toBe(true);
    state = await editProject(root, 'local', {
      action: 'project',
      revision: state.revision,
      changes: {
        ...state.project,
        requires: ['storage'],
        optionalDomains: ['theme'],
        archetypes: ['editor'],
        intents: [{ intent: 'napplet:track/edit', parameters: ['track'] }],
        icon: { file: asset.path },
      },
    });
    const metadata = await inspectProject(root, 'local', creator.pubkey);
    expect(metadata.plan.requires).toEqual(['storage', 'resource']);
    expect(metadata.plan.optionalDomains).toEqual(['theme']);
    expect(metadata.plan.intents).toEqual([
      { intent: 'napplet:track/edit', parameters: ['track'] },
    ]);
    expect(metadata.plan.icon?.hash).toBe(asset.hash);
    expect((await Bun.file(join(root, 'napplet.json')).json()).icon).toEqual({ file: asset.path });
    state = await editProject(root, 'local', {
      action: 'project',
      revision: state.revision,
      changes: { ...state.project, icon: null, optionalDomains: [] },
    });
    expect(state.project.icon).toBeNull();
    expect((await Bun.file(join(root, 'napplet.json')).json()).icon).toBeUndefined();
    await expect(
      importAsset(root, { id: 'sprite', storage: 'external', license: 'CC0', bytes: png }),
    ).rejects.toThrow('already exists');
    await Bun.write(join(root, asset.path), 'changed');
    await expect(validateAssets(root)).rejects.toThrow('corrupt');
    expect((await manageProject(root, 'local')).assets[0].error).not.toBeNull();
    await rm(join(root, asset.path));
    await symlink(join(root, 'LICENSE'), join(root, asset.path));
    await expect(assetBytes(root, asset)).rejects.toThrow('symlink');
    await rm(join(root, asset.path));
    await Bun.write(join(root, asset.path), png);
    state = await manageProject(root, 'local');
    await editProject(root, 'local', {
      action: 'asset-remove',
      revision: state.revision,
      id: 'sprite',
    });
    expect((await readAssets(root)).assets).toHaveLength(0);
    expect(await Bun.file(join(root, asset.path)).exists()).toBe(true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
