import type { ThemeSource } from './appearance';
import { blossomBytes, downloadBytes, readBytes } from '../../client/src/bytes';
import { resourceMime } from '../../client/src/resource-mime';
import { MAX_RESOURCE_BYTES } from '../../client/src/resource-limits';
import { z } from 'zod';
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import { redactDiagnostic } from '../../diagnostics/src';
import { HOST_REQUESTS, RUNTIME_DOMAINS } from './capabilities';
import { scopedStorage } from './storage';
import { NappletFiles, type ExportFile, type FilePick } from './filesystem';
import { NappletActions } from './action-session';
import { NappletUploads } from './upload-session';
import { NappletAppData, appDataPolicy } from './app-data-session';
import { APP_DATA_KIND } from '../../app-data/src/app-data-contract';
import { NappletOutbox } from './outbox-session';
import { NappletMapPublication, isMapPublication } from './map-publication-session';
import { intentMessageBytes, type IntentWorkspace } from './intent-session';
import type { HostSign } from './action-contracts';
import { PlaybackNostr } from '../../nostr/src/playback';
import { WorkQueue } from './work-queue';
import { NappletKeys } from './keys-session';
import { NappletConfig } from './config-session';
import { NappletMedia } from './media-session';
import { NappletBackend, transportSigner } from './backend-session';
import { NappletWebrtc } from './webrtc-session';
import { rtcConfiguration, type BackendProvider } from '../../multiplayer/src/client';
import {
  multiplayerPermission,
  saveMultiplayerPermission,
  subscribeMultiplayerPermission,
} from './multiplayer-permission';

export type HostPrompt = {
  kind: 'link' | 'save' | 'media' | 'network' | 'multiplayer' | 'files' | 'action' | 'upload';
  picker?: FilePick;
  selectFiles?: (files: File[]) => void;
  value: string;
  answer: (accepted: boolean) => void;
  dismiss: () => void;
};
export type HostOptions = {
  /** Trusted shell catalog/lifecycle broker; the frame cannot supply these values. */
  intent?: { workspace: IntentWorkspace; catalogId: string };
  frame: HTMLIFrameElement;
  identity: string;
  manifestId: string;
  relays: string[];
  actionRelays?: string[];
  /** Trusted host disclosure policy, never supplied by the sandbox. */
  outboxPolicy?: { discloseRelayHints?: boolean };
  servers?: string[];
  uploadServers?: string[];
  sign?: HostSign;
  title?: string;
  localServers?: string[];
  pubkey: string | null;
  prompt: (prompt: HostPrompt | null) => void;
  files: (files: ExportFile[]) => void;
  declaration?: { schema?: unknown; error?: string };
  configuration?: (config: NappletConfig | null) => void;
  media?: (media: NappletMedia | null) => void;
  backend?: BackendProvider;
  /** Trusted local preview's configured napplet scope; never supplied by the frame. */
  backendIdentity?: string;
  backendAliases?: BackendProvider[];
  theme?: ThemeSource;
  /** Narrow shell shortcut; only invoked for a focused, interactive frame. */
  escape?: () => void;
};
const envelope = z
  .object({
    type: z
      .string()
      .regex(/^[a-z]+\.[A-Za-z]+(?:\.[A-Za-z]+)?$/)
      .max(80),
    id: z.string().max(128).optional(),
  })
  .passthrough();

/** A single frame session. Caller supplies verified identity; messages cannot change it. */
export function attachNappletHost(options: HostOptions) {
  const source = options.frame.contentWindow;
  const dataPolicy = appDataPolicy(options.identity, options.actionRelays ?? options.relays);
  let alive = true,
    environmentSent = false,
    calls = 0,
    windowStart = Date.now();
  // Frame budgets and concurrency survive account changes.
  const resourceQueue = new WorkQueue(4, 16);
  let resourceCalls = 0,
    resourceBytes = 0;
  const send = (message: Record<string, unknown>) => {
    if (alive) source?.postMessage(message, '*');
  };
  const intentEndpoint = options.intent?.workspace.attach(options.intent.catalogId, send);
  // The verified frame outlives account scopes. Each request captures its scope;
  // retiring it settles promises and prevents delayed results reaching a new user.
  const createAccount = (pubkey: string | null) => {
    let active = true;
    const requests = new Set<(error: Error) => void>();
    const sendScoped = (message: Record<string, unknown>) => {
      if (active) send(message);
    };
    let answer: ((accepted: boolean) => void) | undefined;
    let promptKind: HostPrompt['kind'] | undefined;
    const lifetime = new AbortController();
    const resources = new Map<string, AbortController>();
    let backend: NappletBackend | undefined, webrtc: NappletWebrtc | undefined;
    const nostr = new PlaybackNostr(
      [...new Set([...options.relays, ...(options.actionRelays ?? [])])],
      sendScoped,
      () => pubkey,
      undefined,
      options.outboxPolicy,
    );
    const files = new NappletFiles(sendScoped, (value) => {
      if (active && alive) options.files(value);
    });
    const store = scopedStorage(
      localStorage,
      `${options.identity}:${pubkey ?? 'guest'}`,
      crypto.randomUUID(),
    );
    const choose = (
      kind: HostPrompt['kind'],
      value: string,
      actions: {
        accept?: () => void;
        decide?: (accepted: boolean) => void;
        signal?: AbortSignal;
        picker?: FilePick;
        selectFiles?: (files: File[]) => void;
      } = {},
    ) =>
      new Promise<boolean>((resolve) => {
        if (answer || !alive || !active || actions.signal?.aborted) {
          resolve(false);
          return;
        }
        const timer = setTimeout(() => complete(false), 25000);
        const complete = (accepted: boolean, explicit = false) => {
          if (answer !== complete) return;
          clearTimeout(timer);
          actions.signal?.removeEventListener('abort', abort);
          answer = undefined;
          promptKind = undefined;
          options.prompt(null);
          if (alive && active) {
            if (explicit) actions.decide?.(accepted);
            if (accepted) actions.accept?.();
          }
          resolve(alive && active && accepted);
        };
        const abort = () => complete(false);
        actions.signal?.addEventListener('abort', abort, { once: true });
        answer = complete;
        promptKind = kind;
        options.prompt({
          kind,
          value,
          picker: actions.picker,
          selectFiles: actions.selectFiles
            ? (files) => {
                if (answer !== complete || !alive || !active || actions.signal?.aborted) return;
                actions.selectFiles!(files);
                complete(true);
              }
            : undefined,
          answer: (accepted) => complete(accepted, true),
          dismiss: () => complete(false),
        });
      });
    const consent = (kind: 'action' | 'upload', value: string, signal: AbortSignal) =>
      choose(kind, `${options.title ?? 'This napplet'} requests:\n${value}`, { signal });
    const actions = new NappletActions({
      pubkey,
      sign: options.sign,
      relays: options.actionRelays ?? options.relays,
      signal: lifetime.signal,
      consent: (value, signal) => consent('action', value, signal),
    });
    const publicationPlan = async (key: string, routing: unknown, signal: AbortSignal) => {
      signal.throwIfAborted();
      const relays = await nostr.planner.publication(key, routing, 2000, signal);
      signal.throwIfAborted();
      return relays;
    };
    const outbox = new NappletOutbox({
      pubkey,
      sign: options.sign,
      signal: lifetime.signal,
      plan: publicationPlan,
      consent: (value, signal) => consent('action', `${options.identity}\n${value}`, signal),
      onPublished: (event) => {
        nostr.events.ingest(event);
      },
    });
    const publications = new Map<
      string,
      { fingerprint: string; result: Promise<Record<string, unknown>> }
    >();
    let publicationBytes = 0;
    const publish = (message: Record<string, unknown>) => {
      const dispatch = () => {
        if (isMapPublication(message)) return maps.handle(message);
        if ((message.event as { kind?: unknown } | undefined)?.kind === APP_DATA_KIND)
          return appData.handle(message);
        if (message.type === 'outbox.publish') return outbox.handle(message);
        return Promise.resolve({
          ok: false,
          error: 'publish-denied: general template signing requires OUTBOX and viewer consent.',
        });
      };
      if (message.type !== 'outbox.publish') return dispatch();
      const id = String(message.id ?? '');
      if (!id) return Promise.resolve({ ok: false, error: 'invalid-request-id' });
      const encoded = new TextEncoder().encode(JSON.stringify([message.event, message.options]));
      const fingerprint = bytesToHex(sha256(encoded));
      const previous = publications.get(id);
      if (previous)
        return previous.fingerprint === fingerprint
          ? previous.result
          : Promise.resolve({
              ok: false,
              error: 'request-id-reused: use a fresh request ID for a different publication.',
            });
      const reservation = encoded.length * 2 + 8192;
      if (publications.size >= 256 || publicationBytes + reservation > 16 * 1024 * 1024)
        return Promise.resolve({
          ok: false,
          error: 'publication-limit: reopen the player before making more publication requests.',
        });
      publicationBytes += reservation;
      const result = dispatch();
      publications.set(id, { fingerprint, result });
      return result;
    };
    const appData = new NappletAppData({
      policy: dataPolicy,
      pubkey,
      sign: options.sign,
      signal: lifetime.signal,
      consent: (value, signal) => consent('action', value, signal),
      plan: publicationPlan,
    });
    const maps = new NappletMapPublication({
      pubkey,
      sign: options.sign,
      relays: options.actionRelays ?? options.relays,
      signal: lifetime.signal,
      consent: (value, signal) => consent('action', value, signal),
      plan: publicationPlan,
    });
    const uploads = new NappletUploads({
      pubkey,
      sign: options.sign,
      servers: options.uploadServers ?? [],
      localServers: options.localServers,
      signal: lifetime.signal,
      send: sendScoped,
      consent: (value, signal) => consent('upload', value, signal),
    });
    const chooseFiles = async (picker: FilePick) => {
      let selected: File[] = [];
      await choose(
        'files',
        `${options.title ?? 'This napplet'} wants a ${picker.directory ? 'folder' : 'file'} copy. Only what you select will be shared. Originals stay unchanged.\n${picker.description ?? ''}`,
        {
          picker,
          selectFiles: (files) => {
            selected = files;
          },
          signal: lifetime.signal,
        },
      );
      return selected;
    };
    const media = new NappletMedia({
      manifest: options.manifestId,
      send: sendScoped,
      activate: (label, play) => {
        const previous = answer;
        void choose('media', label, { accept: play });
        const own = answer !== previous ? answer : undefined;
        return () => own?.(false);
      },
    });
    options.media?.(media);
    const resource = async (input: unknown, signal: AbortSignal) => {
      const request = z
        .object({
          url: z.string().max(4096),
          servers: z.array(z.string().max(2048)).max(8).optional(),
        })
        .strict()
        .parse(input);
      if (++resourceCalls > 60 || resourceBytes >= 128 * 1024 * 1024)
        throw new Error('quota-exceeded');
      return resourceQueue.run(signal, async () => {
        const digest = /^blossom:sha256:([a-f0-9]{64})$/.exec(request.url)?.[1];
        const servers = [...new Set([...(request.servers ?? []), ...(options.servers ?? [])])];
        const bytes = digest
          ? await blossomBytes(digest, servers, signal, MAX_RESOURCE_BYTES, options.localServers)
          : request.url.startsWith('data:')
            ? await readBytes(await fetch(request.url, { signal }), MAX_RESOURCE_BYTES)
            : await downloadBytes(request.url, signal, MAX_RESOURCE_BYTES, options.localServers);
        const blob = new Blob([new Uint8Array(bytes)], { type: resourceMime(bytes, !!digest) });
        resourceBytes += blob.size;
        if (blob.size > MAX_RESOURCE_BYTES || resourceBytes > 128 * 1024 * 1024)
          throw new Error('quota-exceeded');
        return { blob, mime: blob.type };
      });
    };
    const handle = async (message: Record<string, unknown>) => {
      const type = String(message.type),
        [domain, action] = type.split('.');
      if (domain === 'cvm' || domain === 'webrtc') {
        const signerScope = `${options.identity.replace(/:[a-f0-9]{64}$/, '')}:${pubkey ?? 'guest'}`;
        backend ??= new NappletBackend(
          transportSigner(sessionStorage, signerScope),
          options.relays,
          options.backend,
          sendScoped,
          (label) => choose('network', label),
          options.backendAliases,
          {
            identity: options.backendIdentity ?? options.identity,
            pubkey,
            sign: options.sign,
            signal: lifetime.signal,
            consent: (label) => choose('network', label),
          },
        );
        if (domain === 'cvm') return backend.handle(message);
        webrtc ??= new NappletWebrtc(
          backend.signer,
          options.identity.replace(/:[a-f0-9]{64}$/, ''),
          options.backend?.relays ?? options.relays,
          sendScoped,
          async () => {
            const permission = multiplayerPermission();
            if (permission !== 'ask') return permission === 'allow';
            return choose(
              'multiplayer',
              'Let napplets connect to other players? Direct connections can share your IP address with peers. Your choice is remembered for all napplets in this browser on this site. You can change it in Network settings.',
              {
                decide: (accepted) => {
                  saveMultiplayerPermission(accepted ? 'allow' : 'block');
                },
              },
            );
          },
          async () => {
            if (!options.backend) return { iceServers: [] };
            const result = await (await backend!.connection(options.backend)).tool('soy_ice');
            return rtcConfiguration(
              result,
              options.relays.some(
                (url) => url.startsWith('ws://127.0.0.1:') || url.startsWith('ws://[::1]:'),
              ),
            );
          },
        );
        return webrtc.handle(message);
      }
      if (domain === 'storage') return store(message);
      if (domain === 'fs')
        return files.handle(message, (name) => choose('save', name), chooseFiles, lifetime.signal);
      if (domain === 'identity') return nostr.identity(action);
      if (domain === 'intent')
        return intentEndpoint
          ? intentEndpoint.handle(message)
          : { result: { ok: false, error: 'No intent workspace is available in this surface.' } };
      if (type === 'outbox.publish' || type === 'relay.publish') {
        return publish(message);
      }
      if (domain === 'relay' || domain === 'outbox') return nostr.handle(message);
      if (domain === 'upload') return uploads.handle(message);
      if (
        domain === 'lists' ||
        ['common.follow', 'common.unfollow', 'common.react', 'common.report'].includes(type)
      )
        return actions.handle(message);
      if (domain === 'common') return nostr.common(message);
      if (type === 'theme.get')
        return {
          theme: options.theme?.get() ?? {
            title: 'napplet.soy',
            colors: { background: '#f5f1e4', text: '#1e261c', primary: '#28573d' },
          },
        };
      if (type === 'link.open') {
        const url = new URL(z.string().max(4096).parse(message.url));
        if (url.protocol !== 'https:' || url.username || url.password) return { status: 'denied' };
        return { status: (await choose('link', url.href)) ? 'opened' : 'denied' };
      }
      if (type === 'resource.info')
        return {
          info: {
            schemes: ['data', 'https', 'blossom'].map((scheme) => ({ scheme, enabled: true })),
            maxBytes: 10 * 1024 * 1024,
            maxUrls: 16,
            maxServers: 8,
          },
        };
      if (type === 'resource.bytes' || type === 'resource.bytesMany') {
        const id = String(message.id);
        if (resources.has(id) || resources.size >= 16) throw new Error('quota-exceeded');
        const controller = new AbortController();
        resources.set(id, controller);
        const signal = AbortSignal.any([controller.signal, lifetime.signal]);
        try {
          if (type === 'resource.bytes')
            return await resource(
              { url: message.url, ...(message.servers ? { servers: message.servers } : {}) },
              signal,
            );
          const inputs = z
            .array(
              z
                .object({
                  url: z.string().max(4096),
                  servers: z.array(z.string().max(2048)).max(8).optional(),
                })
                .strict(),
            )
            .min(1)
            .max(16)
            .parse(message.requests);
          // Sequential bulk delivery avoids multiplying the per-frame concurrent request cap.
          const items = [];
          for (const input of inputs) {
            try {
              items.push({ ok: true, url: input.url, ...(await resource(input, signal)) });
            } catch (error) {
              items.push({
                ok: false,
                url: input.url,
                error: error instanceof Error ? error.message : 'network-error',
              });
            }
          }
          return { items };
        } finally {
          resources.delete(id);
        }
      }
      throw new Error('Unsupported operation');
    };
    return {
      pubkey,
      requests,
      handle,
      media,
      diagnostics: () => webrtc?.diagnostics() ?? Promise.resolve([]),
      send: sendScoped,
      cancel: (id: string) => resources.get(id)?.abort(),
      resetBudget: () => {
        resourceCalls = 0;
      },
      multiplayerChanged: () => {
        const allowed = multiplayerPermission() === 'allow';
        if (promptKind === 'multiplayer') answer?.(allowed);
        if (!allowed) {
          webrtc?.close('Multiplayer permission changed');
          webrtc = undefined;
        }
      },
      close: (reason: string) => {
        for (const fail of requests) fail(new Error(reason));
        requests.clear();
        answer?.(false);
        media.close();
        backend?.close();
        webrtc?.close();
        // close() synchronously notifies live subscriptions; late query completions
        // are suppressed once this scope becomes inactive below.
        nostr.close();
        actions.close();
        appData.close();
        maps.close();
        outbox.close();
        publications.clear();
        active = false;
        lifetime.abort();
        resources.clear();
      },
    };
  };
  let account = createAccount(options.pubkey);
  const unsubscribePermission = subscribeMultiplayerPermission(() => {
    account.multiplayerChanged();
  });
  const config = new NappletConfig({
    storage: localStorage,
    identity: options.identity,
    pubkey: options.pubkey,
    declaration: options.declaration,
    send,
    focused: () => document.activeElement === options.frame,
  });
  options.configuration?.(config);
  const keys = new NappletKeys({
    send,
    focused: () =>
      document.hasFocus() &&
      document.activeElement === options.frame &&
      !options.frame.closest('[inert]'),
    escape: options.escape,
  });
  let configCalls = 0,
    configWindow = Date.now();
  let mediaCalls = 0,
    mediaWindow = Date.now();
  let mediaReports = 0,
    mediaReportWindow = Date.now();
  let rtcCalls = 0,
    rtcBytes = 0,
    rtcWindow = Date.now();
  const listener = (event: MessageEvent) => {
    if (!alive || event.source !== source || event.origin !== 'null') return;
    const parsed = envelope.safeParse(event.data);
    if (!parsed.success) return;
    const message = parsed.data;
    if (message.type === 'shell.ready') {
      if (environmentSent) return;
      environmentSent = true;
      send({
        type: 'shell.init',
        capabilities: {
          domains: RUNTIME_DOMAINS.filter((domain) => domain !== 'intent' || !!intentEndpoint),
          appData: dataPolicy,
        },
        services: [],
      });
      config.ready();
      intentEndpoint?.ready();
      keys.ready();
      return;
    }
    if (message.type.startsWith('keys.') && HOST_REQUESTS.has(message.type)) {
      keys.handle(message);
      return;
    }
    if (
      [
        'media.session.create',
        'media.session.update',
        'media.session.destroy',
        'media.command',
        'media.state',
        'media.capabilities',
      ].includes(message.type)
    ) {
      // Playback reports cannot consume the command/lifecycle budget and prevent
      // pause, destruction or creation of a replacement session.
      if (message.type === 'media.state') {
        if (Date.now() - mediaReportWindow >= 1000) {
          mediaReportWindow = Date.now();
          mediaReports = 0;
        }
        if (++mediaReports > 120) return;
      } else {
        if (Date.now() - mediaWindow >= 60000) {
          mediaWindow = Date.now();
          mediaCalls = 0;
        }
        if (++mediaCalls > 360) {
          if (message.type === 'media.session.create' && message.id)
            send({
              type: 'media.session.create.result',
              id: message.id,
              error: 'session limit exceeded',
            });
          return;
        }
      }
      try {
        if (JSON.stringify(message).length <= 16384) account.media.handle(message);
      } catch {
        /* Invalid input has no authority. */
      }
      return;
    }
    if (message.type.startsWith('config.') && HOST_REQUESTS.has(message.type)) {
      if (Date.now() - configWindow >= 60000) {
        configWindow = Date.now();
        configCalls = 0;
      }
      if (++configCalls > 120) return;
      try {
        if (JSON.stringify(message).length <= 70000) config.handle(message);
      } catch {
        /* Invalid structured data has no authority. */
      }
      return;
    }
    // Sender authority was bound before the iframe could execute. SHELL is an
    // optional environment exchange, not an authorization or readiness gate.
    if (!message.id || !HOST_REQUESTS.has(message.type)) return;
    const scope = account;
    // NAP-IDENTITY requires this basic snapshot to succeed without an error
    // field, even when asynchronous services have exhausted their quota.
    if (message.type === 'identity.getPublicKey') {
      send({ type: 'identity.getPublicKey.result', id: message.id, pubkey: scope.pubkey ?? '' });
      return;
    }
    if (message.type === 'resource.cancel') {
      scope.cancel(message.id);
      return;
    }
    if (Date.now() - windowStart >= 60000) {
      windowStart = Date.now();
      calls = 0;
      scope.resetBudget();
    }
    const lifecycle = /^(?:outbox|relay)\.(?:subscribe|close)$/.test(message.type);
    const failure = (error: unknown) => {
      const detail = redactDiagnostic(
        error instanceof z.ZodError
          ? 'Invalid request'
          : error instanceof Error
            ? error.message
            : 'Request failed',
        1600,
      );
      if (lifecycle) {
        if (typeof message.subId === 'string' && message.subId.length <= 128)
          scope.send({
            type: `${message.type.split('.')[0]}.closed`,
            subId: message.subId,
            reason: detail,
          });
        return;
      }
      if (message.type.startsWith('intent.')) {
        scope.send({
          type: `${message.type}.result`,
          id: message.id,
          ...(message.type === 'intent.invoke'
            ? { result: { ok: false, error: detail } }
            : { error: detail }),
        });
        return;
      }
      if (message.type.startsWith('resource.'))
        scope.send({
          type: `${message.type}.error`,
          id: message.id,
          error: [
            'quota-exceeded',
            'too-large',
            'unsupported-scheme',
            'blocked-by-policy',
            'timeout',
            'network-error',
          ].includes(detail)
            ? detail
            : 'blocked-by-policy',
          message: detail,
        });
      else {
        scope.send({
          type: `${message.type}.result`,
          id: message.id,
          ok: false,
          error:
            message.type.startsWith('fs.') && error instanceof z.ZodError ? 'invalid-data' : detail,
        });
        if (message.type.endsWith('.subscribe'))
          scope.send({
            type: `${message.type.split('.')[0]}.closed`,
            subId: message.subId,
            reason: detail,
          });
      }
    };
    let size: number;
    const intent = message.type.startsWith('intent.');
    try {
      // INTENT payloads use structured clone, not JSON. Apply the same bounded
      // accounting as the broker before dispatch, including unknown fields.
      size = intent ? intentMessageBytes(message) : JSON.stringify(message).length;
    } catch (error) {
      if (intent) failure(error);
      return;
    }
    if (!intent && size > 360000) return;
    const realtime = message.type === 'webrtc.send';
    if (Date.now() - rtcWindow >= 1000) {
      rtcWindow = Date.now();
      rtcCalls = 0;
      rtcBytes = 0;
    }
    if (
      (realtime ? ++rtcCalls > 120 || (rtcBytes += size) > 524288 : ++calls > 600) ||
      scope.requests.size >= 32
    ) {
      failure(new Error('Request quota exceeded'));
      return;
    }
    scope.requests.add(failure);
    void scope
      .handle(message)
      .then((result) => {
        // RELAY/OUTBOX subscribe and close are lifecycle operations. Their
        // contracts define event/closed pushes, not synthetic *.result messages.
        if (!lifecycle) scope.send({ type: `${message.type}.result`, id: message.id, ...result });
      })
      .catch(failure)
      .finally(() => scope.requests.delete(failure));
  };
  const unsubscribeTheme = options.theme?.subscribe(() => {
    send({ type: 'theme.changed', theme: options.theme!.get() });
  });
  window.addEventListener('message', listener);
  return {
    diagnostics: () => (alive ? account.diagnostics() : Promise.resolve([])),
    updateIdentity(pubkey: string | null) {
      if (!alive || account.pubkey === pubkey) return;
      account.close('Identity changed');
      options.files([]);
      account = createAccount(pubkey);
      send({ type: 'identity.changed', pubkey: pubkey ?? '' });
      config.updateIdentity(pubkey);
    },
    close() {
      if (!alive) return;
      alive = false;
      intentEndpoint?.close();
      unsubscribePermission();
      unsubscribeTheme?.();
      window.removeEventListener('message', listener);
      account.close('Player closed');
      config.close();
      keys.close();
      options.configuration?.(null);
      options.media?.(null);
      options.files([]);
    },
  };
}
