import { expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { projectConfiguration } from '../project-config';
import discoveryRelays from '../../packages/nostr/discovery-relays.json';
import {
  defaultTargets,
  projectPublishingDefaults,
  projectSchema,
  resolveTargets,
} from '../../packages/publish/src/config';

test('effective targets are readable before setup and editable per network without changing runtime hints', async () => {
  const root = await mkdtemp(join(tmpdir(), 'napplet-config-'));
  try {
    const project = {
      schema: 'space-local-project/v1',
      name: 'Test',
      previewId: crypto.randomUUID(),
      entry: 'dist/index.html',
      license: 'MIT',
      relays: [],
      servers: [],
    };
    await Bun.write(join(root, 'napplet.json'), JSON.stringify(project));
    expect((await projectConfiguration(root, 'public')).targets).toMatchObject({
      relay: 'wss://relay.napplet.soy/',
      blossom: 'https://blossom.napplet.soy',
      grasp: 'https://git.napplet.soy',
    });
    await projectConfiguration(root, 'public', true);
    const binding = await Bun.file(join(root, '.napplet-space/project.json')).json();
    const configured = binding.project;
    expect(configured.publish.networks.public.relay).toBe('wss://relay.napplet.soy/');
    expect(configured.publish.networks.public.mirrors).toEqual(
      discoveryRelays.map((url) => new URL(url).href),
    );
    expect(configured.publish.networks.public.mirrors.length + 1).toBeGreaterThanOrEqual(5);
    expect(configured.publish.networks.public.mirrors.length + 1).toBeLessThanOrEqual(8);
    configured.publish.networks.public.blossom = 'https://assets.example.com';
    configured.publish.networks.public.mirrors = [];
    await Bun.write(join(root, '.napplet-space/project.json'), JSON.stringify(binding));
    expect(await Bun.file(join(root, 'napplet.json')).json()).toEqual(project);
    expect((await projectConfiguration(root, 'public')).targets).toMatchObject({
      blossom: 'https://assets.example.com',
      mirrors: [],
    });
    expect((await projectConfiguration(root, 'local')).targets).toEqual(defaultTargets('local'));
    const legacy = projectSchema.parse({
      ...project,
      publish: { blossom: 'https://legacy.example.com' },
    });
    expect(resolveTargets(legacy, 'public').blossom).toBe('https://legacy.example.com');
    const scaffolded = projectSchema.parse({ ...project, publish: projectPublishingDefaults() });
    expect(resolveTargets(scaffolded, 'local')).toEqual(defaultTargets('local'));
    expect(
      resolveTargets(scaffolded, 'public', { blossom: 'https://override.example.com' }).blossom,
    ).toBe('https://override.example.com');
    const mirrors = Array.from({ length: 7 }, (_, i) => `wss://mirror-${i}.example`);
    expect(resolveTargets(scaffolded, 'public', { mirrors }).mirrors).toHaveLength(7);
    expect(() =>
      resolveTargets(scaffolded, 'public', { mirrors: [...mirrors, 'wss://extra.example'] }),
    ).toThrow();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
