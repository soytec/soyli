import {
  APP_DATA_KIND,
  APP_DATA_PROFILE,
  APP_DATA_MAX_BYTES,
  dataIdentifier,
  dataTags,
  decodeDataRecord,
  validateDataJson,
  type DataBody,
  type DataEvent,
  type DataPolicy,
  type DataTemplate,
} from './app-data-contract.js';

/** Works through the injected NAP APIs; contains no transport or signing key. */
export type AppDataHost = {
  shell: {
    onReady(callback: (environment: { capabilities?: { appData?: DataPolicy } }) => void): {
      close(): void;
    };
  };
  identity: { getPublicKey(): Promise<string> };
  outbox: {
    query(
      filters: Record<string, unknown>[],
      options?: { relays?: string[]; timeoutMs?: number },
    ): Promise<{
      events: { event: DataEvent }[];
      incomplete?: boolean;
      error?: string;
    }>;
    publish(
      template: DataTemplate,
      options?: { relays?: string[]; toOutbox?: boolean },
    ): Promise<{
      ok: boolean;
      event?: DataEvent;
      error?: string;
      relays?: Record<string, boolean>;
    }>;
  };
};
export type AppRecord<T> = {
  id: string;
  author: string;
  scope: string;
  collection: string;
  title: string;
  revision: string;
  createdAt: number;
  deleted: boolean;
  data: T | null;
  event: DataEvent;
};

/** Default public collection. validate must reject malformed application payloads. */
export async function appDataCollection<T>(options: {
  collection: string;
  schema: string;
  version: number;
  validate(data: unknown): T;
  host?: AppDataHost;
  relays?: string[];
}) {
  const host = options.host ?? (globalThis as unknown as { napplet: AppDataHost }).napplet;
  if (!host?.shell?.onReady || !host.outbox || !host.identity)
    throw new Error('app-data-unavailable: this host needs shell, outbox and identity support.');
  // Observe the host's existing initialization; never initiate an app-owned handshake.
  const policy = await new Promise<DataPolicy | undefined>((resolve, reject) => {
    let subscription: { close(): void } | undefined,
      settled = false;
    const timeout = setTimeout(() => {
      subscription?.close();
      reject(
        new Error(
          'app-data-unavailable: host initialization did not finish. Keep drafts locally and retry.',
        ),
      );
    }, 5000);
    subscription = host.shell.onReady((environment) => {
      settled = true;
      clearTimeout(timeout);
      subscription?.close();
      resolve(environment.capabilities?.appData);
    });
    if (settled) subscription.close();
  });
  if (policy?.profile !== APP_DATA_PROFILE)
    throw new Error(
      'app-data-unavailable: update soyLI or use a host supporting soy.app-data/1. Keep drafts locally.',
    );
  const relays = options.relays ?? policy.defaultRelays;
  if (!Array.isArray(relays) || !relays.length || relays.length > 8)
    throw new Error('app-data-no-relays: choose a storage relay in host Network settings.');
  dataIdentifier(policy.scope, options.collection, 'check');
  // Validate the declaration through the same wire contract used by readers/hosts.
  decodeDataRecord({
    kind: APP_DATA_KIND,
    tags: dataTags(policy.scope, options.collection, 'check', options.schema, options.version),
    content: JSON.stringify({
      schema: options.schema,
      version: options.version,
      title: 'Check',
      previous: null,
      deleted: false,
      data: null,
    }),
  });

  const decode = (event: DataEvent): AppRecord<T> => {
    const { scope, collection, id, body } = decodeDataRecord(event);
    if (
      body.schema !== options.schema ||
      body.version !== options.version ||
      collection !== options.collection
    )
      throw new Error(
        'app-data-incompatible: this record uses another collection or schema version.',
      );
    return {
      id,
      author: event.pubkey,
      scope,
      collection,
      title: body.title,
      revision: event.id,
      createdAt: event.created_at,
      deleted: body.deleted,
      data: body.deleted ? null : options.validate(body.data),
      event,
    };
  };
  const query = async (filters: Record<string, unknown>[]) => {
    const result = await host.outbox.query(filters, { relays, timeoutMs: 8000 });
    if (result.error) throw new Error(result.error);
    return result;
  };
  const newest = (events: DataEvent[]) =>
    events.sort((a, b) => b.created_at - a.created_at || a.id.localeCompare(b.id));

  return {
    policy,
    relays,
    /** At most 100 records/page. until is inclusive; deduplicate revisions between pages. */
    async list(input: { limit?: number; until?: number; scope?: string } = {}) {
      const scope = input.scope ?? policy.scope;
      dataIdentifier(scope, options.collection, 'check');
      const limit = input.limit ?? 40;
      if (
        !Number.isSafeInteger(limit) ||
        limit < 1 ||
        limit > 100 ||
        (input.until !== undefined && (!Number.isSafeInteger(input.until) || input.until < 0))
      )
        throw new Error('app-data-invalid-query: limit must be 1–100 and until a Unix timestamp.');
      // Do not filter version/title/deleted: an incompatible replacement must hide its older value.
      const result = await query([
        {
          kinds: [APP_DATA_KIND],
          '#s': [scope],
          '#c': [options.collection],
          '#L': [APP_DATA_PROFILE],
          limit,
          ...(input.until === undefined ? {} : { until: input.until }),
        },
      ]);
      const heads = new Map<string, DataEvent>();
      for (const { event } of result.events) {
        const d = event.tags.find((t) => t[0] === 'd')?.[1];
        if (
          event.kind !== APP_DATA_KIND ||
          !d?.startsWith(`${APP_DATA_PROFILE}:${scope}:${options.collection}:`)
        )
          continue;
        const key = `${event.pubkey}:${d}`;
        const old = heads.get(key);
        if (!old || newest([old, event])[0] === event) heads.set(key, event);
      }
      const events = newest([...heads.values()]).slice(0, limit);
      const records: AppRecord<T>[] = [];
      let invalid = 0;
      for (const event of events) {
        try {
          const record = decode(event);
          if (!record.deleted) records.push(record);
        } catch {
          invalid++;
        }
      }
      return {
        records,
        incomplete: !!result.incomplete,
        invalid,
        // Not a guaranteed global cursor. Same-second collisions require narrower queries.
        nextUntil: events.length >= limit ? events.at(-1)!.created_at : null,
      };
    },
    async get(author: string, id: string, scope = policy.scope) {
      if (!/^[a-f0-9]{64}$/.test(author))
        throw new Error('app-data-invalid-author: expected a public key.');
      const d = dataIdentifier(scope, options.collection, id);
      const result = await query([
        { kinds: [APP_DATA_KIND], authors: [author], '#d': [d], limit: 1 },
      ]);
      const event = newest(
        result.events
          .map((r) => r.event)
          .filter(
            (e) =>
              e.kind === APP_DATA_KIND &&
              e.pubkey === author &&
              e.tags.some((t) => t[0] === 'd' && t[1] === d),
          ),
      )[0];
      return { record: event ? decode(event) : null, incomplete: !!result.incomplete };
    },
    /** Keep this change object for Retry: it always sends the same event template. */
    async prepare(input: {
      id: string;
      title: string;
      data?: T;
      base: AppRecord<T> | null;
      deleted?: boolean;
    }) {
      const author = await host.identity.getPublicKey();
      if (!/^[a-f0-9]{64}$/.test(author))
        throw new Error('not-signed-in: connect a viewer identity to publish.');
      const { base } = input;
      if (
        base &&
        (base.author !== author ||
          base.scope !== policy.scope ||
          base.collection !== options.collection ||
          base.id !== input.id)
      )
        throw new Error(
          'app-data-owner-mismatch: copy this creation to a new ID to make it your own.',
        );
      const body: DataBody = {
        schema: options.schema,
        version: options.version,
        title: input.title,
        previous: base?.revision ?? null,
        deleted: input.deleted ?? false,
        data: null,
      };
      if (!body.deleted) {
        const data = options.validate(input.data);
        validateDataJson(data);
        body.data = data;
      }
      const template: DataTemplate = {
        kind: APP_DATA_KIND,
        created_at: Math.max(Math.floor(Date.now() / 1000), (base?.createdAt ?? 0) + 1),
        tags: dataTags(policy.scope, options.collection, input.id, options.schema, options.version),
        content: JSON.stringify(body),
      };
      decodeDataRecord(template);
      if (
        new TextEncoder().encode(template.content).length >
        Math.min(policy.maxContentBytes, APP_DATA_MAX_BYTES)
      )
        throw new Error(
          'app-data-too-large: store the large payload on Blossom and publish its URL/hash.',
        );
      return {
        template: structuredClone(template),
        async publish() {
          if ((await host.identity.getPublicKey()) !== author)
            throw new Error(
              'app-data-identity-changed: prepare the change again with the selected identity.',
            );
          const result = await host.outbox.publish(structuredClone(template), {
            relays,
            toOutbox: false,
          });
          if (!result.ok || !result.event)
            throw new Error(result.error ?? 'app-data-publish-failed: no signed record returned.');
          if (
            result.event.pubkey !== author ||
            result.event.kind !== template.kind ||
            result.event.created_at !== template.created_at ||
            result.event.content !== template.content ||
            JSON.stringify(result.event.tags) !== JSON.stringify(template.tags)
          )
            throw new Error('app-data-invalid-result: host returned a different record.');
          return decode(result.event);
        },
      };
    },
  };
}
