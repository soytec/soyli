import { z } from 'zod';
import { AccountError, type Network } from '../../identity/src/signer';
import { normalizeTopic } from '../../protocol/src/topics';
import { checkedEndpoint } from '../../nostr/src/publication-copies';
export { checkedEndpoint } from '../../nostr/src/publication-copies';
import { remixSchema } from '../../protocol/src/remix';
import { backendConfig } from '../../multiplayer/src/contracts';
import discoveryRelays from '../../nostr/discovery-relays.json';
import { MAX_SOURCE_FILES } from './limits';

export class PublishError extends AccountError {
  constructor(
    code: string,
    message: string,
    public stage = 'check',
    public retryable = false,
    cause?: unknown,
  ) {
    super(code, message);
    this.cause = cause;
  }
}
const identifier = z.string().regex(/^[a-z0-9][a-z0-9-]{0,11}[a-z0-9]$|^[a-z0-9]$/);
export const sourceDefaults = [
  'index.html',
  'napplet.json',
  'soy-backend.json',
  'LICENSE',
  'README.md',
  'AGENTS.md',
  'CLAUDE.md',
  'dev.ts',
  'package.json',
  'Cargo.toml',
  'Cargo.lock',
  'rust-toolchain.toml',
  '.gitignore',
  '.napplet/server.js',
  '.napplet/client.js',
  '.napplet/preview.html',
];
export const targetsSchema = z
  .object({
    relay: z.string().max(256),
    blossom: z.string().max(256),
    grasp: z.string().max(256),
    site: z.string().max(256),
    mirrors: z.array(z.string().max(256)).max(7),
  })
  .strict();
export type Targets = z.infer<typeof targetsSchema>;
const repositoryReference = z.string().min(1).max(512);
const networkTargets = targetsSchema
  .partial()
  .extend({ repository: repositoryReference.optional() });
export const recordingSchema = z
  .object({
    durationMs: z.number().int().min(2000).max(8000).default(6000),
    startMs: z.number().int().min(0).max(10000).default(0),
    actions: z
      .array(
        z.discriminatedUnion('type', [
          z
            .object({
              type: z.literal('click'),
              atMs: z.number().int().min(0).max(7999),
              x: z.number().min(0).max(959),
              y: z.number().min(0).max(599),
            })
            .strict(),
          z
            .object({
              type: z.enum(['keyDown', 'keyUp']),
              atMs: z.number().int().min(0).max(7999),
              key: z.string().regex(/^(Arrow(Up|Down|Left|Right)|Space|Enter|[a-z0-9])$/),
            })
            .strict(),
        ]),
      )
      .max(32)
      .default([]),
  })
  .strict()
  .refine(
    (value) => value.actions.every((action) => action.atMs < value.durationMs),
    'Actions must occur within the clip.',
  );
export type Recording = z.infer<typeof recordingSchema>;
const watchInputs = z.array(z.string().min(1).max(200)).min(1).max(32).optional();
const domain = z.string().regex(/^[a-z][a-z0-9-]{0,39}$/);
export const intentSchema = z
  .object({
    intent: z
      .string()
      .min(1)
      .max(256)
      .regex(
        /^[a-z][a-z0-9+.-]*:[^\s?#]+$/i,
        'Use a queryless intent identity such as napplet:feed/open.',
      ),
    parameters: z
      .array(
        z
          .string()
          .min(1)
          .max(80)
          .regex(/^[A-Za-z][A-Za-z0-9_.-]*$/),
      )
      // An i tag includes its name and intent before these parameters.
      .max(14, 'An intent supports at most 14 parameter names.')
      .default([]),
  })
  .strict();
export const iconSchema = z
  .object({
    file: z.string().min(1).max(200),
    mime: z.enum(['image/png', 'image/jpeg', 'image/webp']).optional(),
  })
  .strict();
/** Local build recipes only: never projected into a manifest or executed by playback. */
export const buildSchema = z.discriminatedUnion('kind', [
  z
    .object({
      kind: z.literal('rust'),
      crate: z.string().regex(/^[a-zA-Z_][a-zA-Z0-9_-]{0,63}$/),
      target: z.enum(['bin', 'lib']).default('bin'),
      toolchain: z.string().regex(/^\d+\.\d+\.\d+$/),
      bindgen: z.string().regex(/^\d+\.\d+\.\d+$/),
      profile: z
        .string()
        .regex(/^[a-z][a-z0-9-]{0,40}$/)
        .default('release'),
      features: z
        .array(z.string().regex(/^[a-zA-Z0-9_/-]+$/))
        .max(32)
        .default([]),
      defaultFeatures: z.boolean().default(true),
      watch: watchInputs,
    })
    .strict(),
  z
    .object({
      kind: z.literal('command'),
      command: z.array(z.string().min(1).max(1000)).min(1).max(32),
      watch: watchInputs,
      timeoutSeconds: z.number().int().min(10).max(1200).default(300),
    })
    .strict(),
]);
export type Build = z.infer<typeof buildSchema>;
export const projectSchema = z
  .object({
    schema: z.literal('space-local-project/v1'),
    name: z.string().min(1).max(160),
    title: z.string().min(1).max(160).optional(),
    description: z.string().max(1000).default(''),
    entry: z.enum(['index.html', 'dist/index.html']),
    previewId: z.uuid(),
    identifier: identifier.optional(),
    template: z.string().optional(),
    build: buildSchema.optional(),
    remix: remixSchema.optional(),
    license: z.string().min(1).max(100),
    requires: z.array(domain).max(32).default([]),
    optionalDomains: z.array(domain).max(32).optional(),
    archetypes: z
      .array(
        z
          .string()
          .min(1)
          .max(80)
          .regex(/^[^\s\u0000-\u001f\u007f]+$/),
      )
      .max(32)
      .optional(),
    intents: z.array(intentSchema).max(32).optional(),
    icon: iconSchema.optional(),
    topics: z.array(z.string().max(256)).max(32).default([]),
    relays: z.array(z.string().max(256)).max(8).default([]),
    servers: z.array(z.string().max(256)).max(8).default([]),
    backend: backendConfig.optional(),
    preview: z
      .object({
        image: z.string().min(1).max(200).optional(),
        video: z
          .object({
            file: z.string().min(1).max(200),
            artifactHash: z.string().regex(/^[a-f0-9]{64}$/),
          })
          .strict()
          .optional(),
        recording: recordingSchema.optional(),
        delayMs: z.number().int().min(250).max(10000).optional(),
        readySelector: z.string().min(1).max(200).optional(),
      })
      .strict()
      .optional(),
    creator: z
      .object({ pubkey: z.string().regex(/^[a-f0-9]{64}$/), network: z.enum(['local', 'public']) })
      .strict()
      .optional(),
    publish: targetsSchema
      .partial()
      .extend({
        files: z.array(z.string().max(200)).min(3).max(MAX_SOURCE_FILES).optional(),
        // The creator's own NIP-34 repository. It is referenced, never written.
        repository: repositoryReference.optional(),
        networks: z
          .object({
            public: networkTargets.optional(),
            local: networkTargets.optional(),
          })
          .strict()
          .optional(),
      })
      .strict()
      .optional(),
  })
  .strict();
export type Project = z.infer<typeof projectSchema>;
/** Shared by scaffold, config inspection and publishing; old projects inherit these defaults. */
export function defaultTargets(network: Network): Targets {
  return network === 'local'
    ? {
        relay: 'ws://127.0.0.1:19347/relay',
        blossom: 'http://127.0.0.1:8081',
        grasp: 'http://127.0.0.1:8082',
        site: 'http://localhost:8080',
        mirrors: [],
      }
    : {
        relay: 'wss://relay.napplet.soy',
        blossom: 'https://blossom.napplet.soy',
        grasp: 'https://git.napplet.soy',
        site: 'https://napplet.soy',
        mirrors: [...discoveryRelays],
      };
}
export const projectPublishingDefaults = () => ({
  networks: { public: defaultTargets('public'), local: defaultTargets('local') },
});
/** Throws for a destination outside the selected network's public/loopback policy. */
export function resolveTargets(
  project: Project,
  network: Network,
  overrides: Partial<Targets> = {},
): Targets {
  const { files: _, networks, repository: __, ...configured } = project.publish ?? {};
  const { repository: ___, ...networkTargets } = networks?.[network] ?? {};
  const targets = targetsSchema.parse({
    ...defaultTargets(network),
    ...configured,
    ...networkTargets,
    ...overrides,
  });
  const endpoint = (value: string, relay = false, site = false) =>
    checkedEndpoint(value, network, relay, site);
  try {
    targets.relay = endpoint(targets.relay, true);
    targets.mirrors = [...new Set(targets.mirrors.map((r) => endpoint(r, true)))].filter(
      (r) => r !== targets.relay,
    );
    targets.blossom = endpoint(targets.blossom);
    targets.grasp = endpoint(targets.grasp);
    targets.site = endpoint(targets.site, false, true);
    // Runtime hints must respect the selected network as well. They are never publication targets.
    project.relays.forEach((r) => endpoint(r, true));
    project.servers.forEach((r) => endpoint(r));
    return targets;
  } catch {
    throw new PublishError(
      'PUBLISH_TARGET',
      'Use HTTPS/WSS public targets, or literal-loopback HTTP/WS targets with --network local.',
    );
  }
}
/** A per-network setting overrides the shared one. */
export function projectRepositoryReference(project: Project, network: Network) {
  return project.publish?.networks?.[network]?.repository ?? project.publish?.repository;
}
export function projectIdentity(project: Project) {
  return project.identifier ?? `n-${project.previewId.replaceAll('-', '').slice(0, 11)}`;
}
export function projectTopics(project: Project) {
  const topics = project.topics.map(normalizeTopic);
  if (topics.some((t) => !t))
    throw new PublishError(
      'PROJECT_TOPICS',
      'Use nonempty topics without whitespace, control characters or embedded # characters.',
    );
  return [...new Set(topics)];
}
