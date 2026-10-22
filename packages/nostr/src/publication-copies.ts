import { z } from 'zod';
import ipaddr from 'ipaddr.js';
import type { Filter } from 'nostr-tools';
import { DiagnosticError, diagnose, type Diagnostic } from '../../diagnostics/src';
import { verifiedEvent, type SignedEvent } from '../../protocol/src';
import discoveryRelays from '../discovery-relays.json';

export const MAX_RELAY_URL = 256;
export const MAX_OUTBOX_RELAYS = 8;
export const MAX_KNOWN_COPY_RELAYS = 128;
export const OPTIONAL_COPY_BUDGET_MS = 8000;
const COPY_CONCURRENCY = 4;
type Network = 'public' | 'local';
type Targets = { relay: string; mirrors: string[] };

/** Apply the persisted bound to the canonical URL, including percent encoding. */
export function checkedEndpoint(value: string, network: Network, relay = false, site = false) {
  const u = new URL(value);
  const loopback = ['127.0.0.1', '[::1]', ...(site ? ['localhost'] : [])].includes(u.hostname);
  const literal = u.hostname.replace(/^\[|\]$/g, '');
  const privateHost =
    u.hostname === 'localhost' ||
    u.hostname.endsWith('.localhost') ||
    u.hostname.endsWith('.local') ||
    (ipaddr.isValid(literal) && ipaddr.process(literal).range() !== 'unicast');
  const normalized = relay ? u.href : u.origin;
  if (
    normalized.length > MAX_RELAY_URL ||
    u.username ||
    u.password ||
    u.hash ||
    u.search ||
    (!relay && u.pathname !== '/') ||
    (network === 'local'
      ? !loopback || u.protocol !== (relay ? 'ws:' : 'http:')
      : u.protocol !== (relay ? 'wss:' : 'https:') || privateHost)
  )
    throw new Error('Endpoint is outside the publication policy or canonical URL length limit.');
  return normalized;
}

export const diagnosticSchema = z
  .object({
    code: z.string().max(80),
    message: z.string().max(2000),
    operation: z.string().max(160),
    recovery: z.string().max(2000),
    details: z.array(z.string().max(2000)).max(8).optional(),
    stage: z.string().max(40).optional(),
    retryable: z.boolean(),
  })
  .strict();
export const copyErrorSchema = z
  .object({
    eventId: z.string().regex(/^[a-f0-9]{64}$/),
    eventKind: z.number().int().nonnegative(),
    attemptedAt: z.number().int().nonnegative(),
    diagnostic: diagnosticSchema,
  })
  .strict();
export const outboxSchema = z
  .object({
    checkedAt: z.number().int().nonnegative(),
    source: z.enum(['nip65', 'none', 'unavailable']),
    eventId: z
      .string()
      .regex(/^[a-f0-9]{64}$/)
      .optional(),
    relays: z.array(z.string().max(MAX_RELAY_URL)).max(MAX_OUTBOX_RELAYS),
    ignored: z.number().int().nonnegative(),
    lookupError: diagnosticSchema.optional(),
    copies: z.record(z.string(), z.boolean()),
    errors: z.record(z.string(), copyErrorSchema),
  })
  .strict();
export const copyHistorySchema = z.array(z.string().max(MAX_RELAY_URL)).max(MAX_KNOWN_COPY_RELAYS);
export type CopyState = {
  mirrors: Record<string, boolean>;
  mirrorErrors?: Record<string, z.infer<typeof copyErrorSchema>>;
  outbox?: z.infer<typeof outboxSchema>;
  outboxHistory?: string[];
};
export type OutboxLookup = {
  source: 'nip65' | 'none' | 'unavailable';
  eventId?: string;
  relays: string[];
  ignored: number;
  error?: Diagnostic;
};
export type CopyIO = {
  read(url: string, filter: Filter, timeoutMs?: number): Promise<SignedEvent[]>;
  ensure(url: string, event: SignedEvent): Promise<void>;
  close(): void;
};

/** An aborted optional phase stops awaiting work and never starts a later write. */
export function untilAborted<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) {
    void work.catch(() => {});
    return Promise.reject(signal.reason);
  }
  return new Promise((resolve, reject) => {
    const abort = () => {
      signal.removeEventListener('abort', abort);
      reject(signal.reason);
    };
    signal.addEventListener('abort', abort, { once: true });
    work.then(
      (value) => {
        signal.removeEventListener('abort', abort);
        resolve(value);
      },
      (error) => {
        signal.removeEventListener('abort', abort);
        reject(error);
      },
    );
  });
}

export async function resolveOutbox(
  read: CopyIO['read'],
  pubkey: string,
  targets: Targets,
  network: Network,
  timeoutMs = 4000,
): Promise<OutboxLookup> {
  const urls = [
    ...new Set(
      [
        targets.relay,
        ...targets.mirrors,
        ...(network === 'public' ? [...discoveryRelays, 'wss://purplepag.es'] : []),
      ].flatMap((url) => {
        try {
          return [checkedEndpoint(url, network, true)];
        } catch {
          return [];
        }
      }),
    ),
  ];
  const settled = await Promise.allSettled(
    urls.map((url) => read(url, { kinds: [10002], authors: [pubkey], limit: 4 }, timeoutMs)),
  );
  const failures: Error[] = [];
  let latest: SignedEvent | undefined;
  settled.forEach((outcome, i) => {
    if (outcome.status === 'rejected')
      failures.push(
        new DiagnosticError('RELAY_READ', 'Relay list query failed.', {
          target: urls[i],
          cause: outcome.reason,
        }),
      );
    else
      for (const input of outcome.value) {
        try {
          const event = verifiedEvent(input);
          if (
            event.pubkey === pubkey &&
            event.kind === 10002 &&
            (!latest ||
              event.created_at > latest.created_at ||
              (event.created_at === latest.created_at && event.id < latest.id))
          )
            latest = event;
        } catch {
          /* A relay list must have a valid signature. */
        }
      }
  });
  const found = latest as SignedEvent | undefined;
  if (!found) {
    const error = failures.length
      ? diagnose(
          new DiagnosticError(
            'OUTBOX_LOOKUP',
            failures.length === urls.length
              ? 'Could not read the creator relay list (NIP-65) from any lookup relay.'
              : `No creator relay list (NIP-65) was found; ${failures.length} of ${urls.length} lookup relays failed.`,
            {
              operation: 'look up creator outbox relays',
              recovery:
                'The primary publication is unaffected. Retry the unchanged publication to repair optional copies.',
              cause: new AggregateError(failures, 'Relay list lookups failed.'),
            },
          ),
        )
      : undefined;
    return {
      source: failures.length === urls.length ? 'unavailable' : 'none',
      relays: [],
      ignored: 0,
      ...(error ? { error } : {}),
    };
  }
  const covered = new Set(
    [targets.relay, ...targets.mirrors].map((url) => checkedEndpoint(url, network, true)),
  );
  const relays = new Set<string>();
  let ignored = 0;
  for (const tag of found.tags) {
    if (tag[0] !== 'r' || typeof tag[1] !== 'string' || (tag[2] && tag[2] !== 'write')) continue;
    let url: string;
    try {
      url = checkedEndpoint(tag[1], network, true);
    } catch {
      ignored++;
      continue;
    }
    if (covered.has(url) || relays.has(url)) continue;
    if (relays.size >= MAX_OUTBOX_RELAYS) ignored++;
    else relays.add(url);
  }
  return { source: 'nip65', eventId: found.id, relays: [...relays], ignored };
}

/** Shared by publication and manifest-only migration. Save destinations before writes. */
export async function copyPublication(options: {
  pubkey: string;
  targets: Targets;
  network: Network;
  events: SignedEvent[];
  state: CopyState;
  io: (signal: AbortSignal) => CopyIO;
  save: () => Promise<void>;
  signal?: AbortSignal;
  timeoutMs?: number;
  progress?: (stage: string) => void;
  copyMirrors?: boolean;
}) {
  const controller = new AbortController();
  const expired = new DiagnosticError(
    'OPTIONAL_COPY_TIMEOUT',
    'The optional copy phase reached its time limit.',
    {
      recovery:
        'The primary release is complete. Retry the unchanged publication to repair optional copies.',
    },
  );
  const timer = setTimeout(
    () => controller.abort(expired),
    options.timeoutMs ?? OPTIONAL_COPY_BUDGET_MS,
  );
  const cancel = () =>
    controller.abort(
      new DiagnosticError('OPTIONAL_COPY_CANCELLED', 'Optional copies were cancelled.'),
    );
  options.signal?.addEventListener('abort', cancel, { once: true });
  if (options.signal?.aborted) cancel();
  const signal = controller.signal,
    io = options.io(signal),
    state = options.state;
  const close = () => io.close();
  signal.addEventListener('abort', close, { once: true });
  // Serialize atomic receipt writes while independent destinations run concurrently.
  let saved: Promise<void> = Promise.resolve();
  const save = () => {
    saved = saved.then(options.save);
    return saved;
  };
  const recovery =
    'The primary publication is unaffected. Retry the unchanged publication to repair copies of the same signed events.';
  try {
    options.progress?.('outbox');
    let lookup: OutboxLookup;
    try {
      signal.throwIfAborted();
      lookup = await untilAborted(
        resolveOutbox(
          (url, filter, timeout) => {
            signal.throwIfAborted();
            return untilAborted(io.read(url, filter, timeout), signal);
          },
          options.pubkey,
          options.targets,
          options.network,
        ),
        signal,
      );
    } catch (cause) {
      lookup = {
        source: 'unavailable',
        relays: [],
        ignored: 0,
        error: diagnose(cause, 'look up creator outbox relays'),
      };
    }
    // Older PR journals retain at least their last attempted list; never discard it on retry.
    const history = [...new Set([...(state.outboxHistory ?? []), ...(state.outbox?.relays ?? [])])];
    const selected: string[] = [];
    for (const relay of lookup.relays) {
      if (!history.includes(relay)) {
        if (history.length >= MAX_KNOWN_COPY_RELAYS) {
          lookup.ignored++;
          continue;
        }
        history.push(relay);
      }
      selected.push(relay);
    }
    state.outboxHistory = history;
    state.outbox = outboxSchema.parse({
      checkedAt: Date.now(),
      source: lookup.source,
      ...(lookup.eventId ? { eventId: lookup.eventId } : {}),
      relays: selected,
      ignored: lookup.ignored,
      ...(lookup.error
        ? { lookupError: { ...lookup.error, retryable: lookup.error.retryable ?? true } }
        : {}),
      copies: {},
      errors: {},
    });
    await save(); // All potential partial copies remain known even after a crash.
    const tasks = [
      ...(options.copyMirrors === false ? [] : options.targets.mirrors).map((url) => ({
        url,
        outbox: false,
      })),
      ...selected.map((url) => ({ url, outbox: true })),
    ];
    let cursor = 0;
    await Promise.all(
      Array.from({ length: Math.min(COPY_CONCURRENCY, tasks.length) }, async () => {
        while (cursor < tasks.length) {
          const task = tasks[cursor++];
          options.progress?.(task.outbox ? 'outbox' : 'mirror');
          let event = options.events[0];
          let failure: z.infer<typeof copyErrorSchema> | undefined;
          try {
            for (const next of options.events) {
              event = next;
              signal.throwIfAborted();
              await untilAborted(io.ensure(task.url, event), signal);
            }
          } catch (cause) {
            const diagnostic = diagnose(
              cause,
              task.outbox ? 'publish to creator outbox relay' : 'publish optional mirror',
            );
            failure = {
              eventId: event.id,
              eventKind: event.kind,
              attemptedAt: Date.now(),
              diagnostic: { ...diagnostic, retryable: true, recovery },
            };
          }
          if (task.outbox) {
            state.outbox!.copies[task.url] = !failure;
            if (failure) state.outbox!.errors[task.url] = failure;
          } else {
            state.mirrors[task.url] = !failure;
            if (failure) {
              state.mirrorErrors ??= {};
              state.mirrorErrors[task.url] = failure;
            } else if (state.mirrorErrors) delete state.mirrorErrors[task.url];
          }
          await save();
        }
      }),
    );
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener('abort', cancel);
    signal.removeEventListener('abort', close);
    io.close();
  }
}

/** Includes attempts, not only successful current-event receipts. */
export function publicationDestinations(jobs: (CopyState & { plan: { targets: Targets } })[]) {
  return [
    ...new Set(
      jobs.flatMap((job) => [
        job.plan.targets.relay,
        ...job.plan.targets.mirrors,
        ...(job.outboxHistory ?? []),
        ...(job.outbox?.relays ?? []),
      ]),
    ),
  ];
}
