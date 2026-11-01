import { PrivateKeySigner } from 'applesauce-signers/signers/private-key-signer';
import { NostrConnectSigner } from 'applesauce-signers/signers/nostr-connect-signer';
import { RelayPool } from 'applesauce-relay';
import { createDefer } from 'applesauce-core/promise';
import { from, lastValueFrom } from 'rxjs';
import type { EventTemplate, NostrEvent } from 'nostr-tools';
import { bytesToHex, hexToBytes } from '@noble/hashes/utils.js';
import { verifiedEvent, type SignedEvent } from '../../protocol/src';
import { studioSigningKinds } from './studio-channel';

export type Network = 'public' | 'local';
export class AccountError extends Error {
  constructor(
    public code: string,
    message: string,
  ) {
    super(message);
  }
}
export const publishingKinds = [5, 30617, 30618, 24242, 32267, 35129, 15129, 5129];
// Shell wallet only; these permissions are never granted to a napplet iframe.
export const walletSigningKinds = [17375, 7375, 7376, 10019, 9321, 22242];
// Viewer-authorized COMMON/LISTS, scoped public app data, Blossom auth and shell actions.
export const websiteKinds = [
  0,
  1,
  3,
  5,
  7,
  1111,
  1984,
  9734,
  10000,
  10001,
  10002,
  10003,
  10006,
  10007,
  10015,
  10063,
  27235,
  30000,
  30002,
  30003,
  30015,
  30078,
  35858,
  // Explicit Studio publication/contribution consent; not an iframe permission.
  ...studioSigningKinds,
  ...walletSigningKinds,
];
export const defaultSignerRelays = ['wss://relay.napplet.soy'];
// A client connection budget, not a NIP-46 protocol limit. Keep saved sessions
// and both connection directions on the same policy.
export const MAX_SIGNER_RELAYS = 8;
export type SignerOptions = {
  expectedPubkey?: string;
  timeoutMs?: number;
  signal?: AbortSignal;
  onAuth?: (url: string) => Promise<void>;
  kinds?: number[];
  name?: string | ((clientPubkey: string) => string);
  url?: string;
};
export type PairingOptions = SignerOptions & {
  onPairing: (uri: string) => void | Promise<void>;
};
export function signerRelays(values: string[], network: Network) {
  const relays = [...new Set(values)];
  if (!relays.length || relays.length > MAX_SIGNER_RELAYS)
    throw new AccountError(
      'INVALID_RELAY',
      `Use 1–${MAX_SIGNER_RELAYS} distinct signer relays; received ${relays.length}.`,
    );
  for (const relay of relays) {
    let r: URL;
    try {
      r = new URL(relay);
    } catch {
      throw new AccountError('INVALID_RELAY', 'Invalid signer relay URL.');
    }
    if (
      relay.length > 400 ||
      r.username ||
      r.password ||
      r.hash ||
      (network === 'local'
        ? r.protocol !== 'ws:' || !['127.0.0.1', '[::1]'].includes(r.hostname)
        : r.protocol !== 'wss:')
    )
      throw new AccountError(
        'INVALID_RELAY',
        'Use WSS signer relays (literal-loopback WS in local mode).',
      );
  }
  return relays;
}
export type RemoteCredential = {
  type: 'remote';
  clientKey: string;
  remote: string;
  relays: string[];
  secret?: string;
};
export type Credential = { type: 'local'; key: string } | RemoteCredential;
export type CreatorSigner = {
  getPublicKey(): Promise<string>;
  signEvent(event: EventTemplate): Promise<SignedEvent>;
  close(): Promise<void>;
  nip44?: {
    encrypt(pubkey: string, plaintext: string): Promise<string>;
    decrypt(pubkey: string, ciphertext: string): Promise<string>;
  };
};
export function checkPubkey(pubkey: string, network: Network) {
  if (!/^[a-f0-9]{64}$/.test(pubkey))
    throw new AccountError('INVALID_IDENTITY', 'Invalid creator public key.');
  if (
    network === 'public' &&
    pubkey === '79be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798'
  )
    throw new AccountError(
      'FIXTURE_IDENTITY',
      'The bundled fixture identity cannot be used as a public creator.',
    );
  return pubkey;
}
export function bunkerCredential(uri: string, network: Network): RemoteCredential {
  try {
    if (uri.length > 4096)
      throw new AccountError(
        'INVALID_BUNKER',
        'The bunker link exceeds the 4096-character input limit.',
      );
    const url = new URL(uri);
    if (
      url.protocol !== 'bunker:' ||
      url.username ||
      url.password ||
      url.port ||
      url.hash ||
      !['', '/'].includes(url.pathname)
    )
      throw new AccountError(
        'INVALID_BUNKER',
        'Expected bunker://<signer-pubkey>?relay=<WSS URL>&secret=<optional secret>, without credentials, port, fragment or an extra path.',
      );
    if (
      [...url.searchParams.keys()].some((key) => !['relay', 'secret'].includes(key)) ||
      url.searchParams.getAll('secret').length > 1
    )
      throw new AccountError(
        'INVALID_BUNKER',
        'A bunker link accepts relay parameters and at most one secret parameter.',
      );
    const remote = checkPubkey(url.hostname, 'local');
    const relays = signerRelays(url.searchParams.getAll('relay'), network);
    const secret = url.searchParams.get('secret') ?? undefined;
    if (secret && secret.length > 256)
      throw new AccountError(
        'INVALID_BUNKER',
        'The bunker secret exceeds the supported 256-character limit.',
      );
    const key = new PrivateKeySigner();
    const clientKey = bytesToHex(key.key);
    key.key.fill(0);
    return { type: 'remote', remote, relays, secret, clientKey };
  } catch (error) {
    throw new AccountError(
      'INVALID_BUNKER',
      // Only our own safe validation messages may cross the credential boundary;
      // URL/parser exceptions can contain the supplied link and its secret.
      error instanceof AccountError
        ? error.message
        : 'Could not parse the bunker connection link. Paste the complete bunker:// link at the hidden prompt.',
    );
  }
}

// The pinned SDK does not reject outstanding RPC promises on close. Keep their
// lifetime inside one CLI operation, and suppress its debug logging of RPC params.
class Session extends NostrConnectSigner {
  private ended = false;
  constructor(options: ConstructorParameters<typeof NostrConnectSigner>[0]) {
    super(options);
    // v7 loggers are read-only; swap in a silent one so RPC params never reach a sink.
    const silent = Object.assign(() => {}, {
      namespace: this.log.namespace,
      enabled: false,
      extend: () => silent,
    });
    this.log = silent;
  }
  /** SDK 6.2.2 lacks the fourth NIP-46 connect parameter. Keep its encryption,
   * response dispatch, authorization challenges and close/cancellation registry. */
  async connectNamed(
    secret: string | undefined,
    permissions: string[],
    metadata?: { name: string; url: string },
  ) {
    if (!metadata) return this.connect(secret, permissions);
    if (!this.remote) throw new AccountError('INVALID_SIGNER', 'Missing remote signer public key.');
    await this.open();
    const id = crypto.randomUUID(),
      response = createDefer<string>();
    response.catch(() => {});
    this.requests.set(id, response);
    try {
      const content = await this.signer.nip44!.encrypt(
        this.remote,
        JSON.stringify({
          id,
          method: 'connect',
          params: [this.remote, secret ?? '', permissions.join(','), JSON.stringify(metadata)],
        }),
      );
      const event = await this.createRequestEvent(content);
      const publishing = this.publishMethod(this.relays, event);
      await lastValueFrom(from(publishing), { defaultValue: undefined });
      const ack = await response;
      this.isConnected = true;
      return ack;
    } catch (error) {
      this.isConnected = false;
      throw error;
    } finally {
      this.requests.delete(id);
    }
  }
  override async handleEvent(event: NostrEvent) {
    if (
      this.ended ||
      event.kind !== 24133 ||
      !event.tags.some((t) => t[0] === 'p' && t[1] === this.clientPubkey)
    )
      return;
    // NIP-46 requires the secret for client-initiated pairing. The SDK also
    // accepts a bare ack, which would let any relay observer claim the session.
    if (!this.remote) {
      try {
        if (!this.verifyEvent(event)) return;
        const response = JSON.parse(
          await (event.content.includes('?iv=')
            ? this.signer.nip04!.decrypt(event.pubkey, event.content)
            : this.signer.nip44!.decrypt(event.pubkey, event.content)),
        );
        if (this.ended || response.error || response.result !== this.connectSecret) return;
      } catch {
        return;
      }
    }
    if (!this.ended) await super.handleEvent(event);
  }
  override async close() {
    this.ended = true;
    for (const request of this.requests.values()) {
      request.catch(() => {});
      request.reject(new AccountError('SIGNER_CLOSED', 'Signer session closed.'));
    }
    this.requests.clear();
    this.auths.clear();
    await super.close();
  }
}
export async function openCredential(
  credential: Credential,
  network: Network,
  options: SignerOptions = {},
): Promise<CreatorSigner> {
  return (await openSession(credential, network, options)).signer;
}
export async function pairCredential(relays: string[], network: Network, options: PairingOptions) {
  signerRelays(relays, network);
  const key = new PrivateKeySigner();
  const clientKey = bytesToHex(key.key);
  key.key.fill(0);
  const result = await openSession({ type: 'pairing', clientKey, relays }, network, options);
  return { signer: result.signer, credential: result.credential! };
}
async function openSession(
  credential: Credential | { type: 'pairing'; clientKey: string; relays: string[] },
  network: Network,
  options: SignerOptions | PairingOptions,
) {
  const kinds = [...(options.kinds ?? publishingKinds)];
  const keyHex = credential.type === 'local' ? credential.key : credential.clientKey;
  if (!/^[a-f0-9]{64}$/.test(keyHex))
    throw new AccountError('INVALID_CREDENTIAL', 'Stored signer credential is invalid.');
  const local = new PrivateKeySigner(hexToBytes(keyHex));
  let closed = false;
  let remote: Session | undefined;
  let pool: RelayPool | undefined;
  const close = async () => {
    if (closed) return;
    closed = true;
    await remote?.close();
    pool?.close();
    local.key.fill(0);
  };
  const bounded = async <T>(operation: () => Promise<T>): Promise<T> => {
    if (closed || options.signal?.aborted) {
      await close();
      throw new AccountError('SIGNER_CLOSED', 'Signer session closed or cancelled.');
    }
    let timer: ReturnType<typeof setTimeout>;
    let abort: () => void;
    try {
      return await Promise.race([
        operation(),
        new Promise<never>((_, reject) => {
          abort = () => reject(new AccountError('SIGNER_CANCELLED', 'Signer request cancelled.'));
          options.signal?.addEventListener('abort', abort, { once: true });
          timer = setTimeout(
            () =>
              reject(
                new AccountError(
                  'SIGNER_TIMEOUT',
                  'Remote signer did not respond. Unlock it and retry.',
                ),
              ),
            options.timeoutMs ?? 60000,
          );
        }),
      ]);
    } catch (error) {
      await close();
      if (error instanceof AccountError) throw error;
      // Remote errors and SDK diagnostics may contain connection secrets.
      throw new AccountError(
        'SIGNER_REFUSED',
        'Signer rejected the request or could not connect. Check its permissions and retry.',
      );
    } finally {
      clearTimeout(timer!);
      options.signal?.removeEventListener('abort', abort!);
    }
  };
  try {
    let pubkey: string;
    if (credential.type === 'local') pubkey = await local.getPublicKey();
    else {
      // Revalidate stored endpoints as well as newly pasted links.
      signerRelays(credential.relays, network);
      if (credential.type === 'remote') checkPubkey(credential.remote, 'local');
      pool = new RelayPool();
      remote = new Session({
        signer: local,
        remote: credential.type === 'remote' ? credential.remote : undefined,
        connectSecret: bytesToHex(crypto.getRandomValues(new Uint8Array(24))),
        relays: credential.relays,
        subscriptionMethod: (relays, filters) => pool!.subscription(relays, filters),
        publishMethod: async (relays, event) => {
          if (closed) throw new AccountError('SIGNER_CLOSED', 'Signer session closed.');
          // Fan out to every hint, but don't hold an already received signer
          // response behind a silent relay's ACK deadline. Promise.any consumes
          // late rejections; the pool still owns and closes all attempts.
          await Promise.any(
            relays.map(async (relay) => {
              const result = await pool!
                .relay(relay)
                .publish(event, { timeout: 5000, retries: false });
              if (!result.ok)
                throw new AccountError('SIGNER_RELAY', 'A signing relay refused the request.');
            }),
          );
        },
        onAuth: async (url) => {
          if (/[\u0000-\u001f\u007f]/.test(url))
            throw new AccountError('SIGNER_AUTH', 'Signer supplied an invalid authorization URL.');
          const parsed = new URL(url);
          if (
            !options.onAuth ||
            parsed.username ||
            parsed.password ||
            (parsed.protocol !== 'https:' &&
              !(
                network === 'local' &&
                parsed.protocol === 'http:' &&
                ['127.0.0.1', '[::1]'].includes(parsed.hostname)
              ))
          )
            throw new AccountError(
              'SIGNER_AUTH',
              'Remote signer requires authorization in its own application.',
            );
          await options.onAuth(parsed.href);
        },
      });
      const name =
        typeof options.name === 'function' ? options.name(remote.clientPubkey) : options.name;
      const metadata = name ? { name, url: options.url ?? 'https://napplet.soy' } : undefined;
      const permissions = [
        'get_public_key',
        ...NostrConnectSigner.buildSigningPermissions(kinds),
        ...(kinds.includes(17375) ? ['nip44_encrypt', 'nip44_decrypt'] : []),
      ];
      if (credential.type === 'pairing') {
        const pairing = options as PairingOptions;
        await bounded(async () => {
          await remote!.open();
          const waiting = remote!.waitForSigner();
          waiting.catch(() => {});
          await pairing.onPairing(
            remote!.getNostrConnectURI({
              name: name ?? 'Napplet Space',
              url: pairing.url ?? 'https://napplet.soy',
              permissions,
            }),
          );
          await waiting;
        });
      } else {
        const ack = await bounded(() =>
          remote!.connectNamed(credential.secret, permissions, metadata),
        );
        if (ack !== 'ack' && ack !== credential.secret)
          throw new AccountError(
            'INVALID_SIGNER',
            'Remote signer returned an invalid connection acknowledgement.',
          );
      }
      // Never confuse the bunker transport identity with the actual user's key.
      pubkey = await bounded(() => remote!.getPublicKey());
    }
    checkPubkey(pubkey, network);
    if (options.expectedPubkey && options.expectedPubkey !== pubkey)
      throw new AccountError(
        'IDENTITY_CHANGED',
        'The signer now represents a different creator. Connect that account explicitly.',
      );
    const signer: CreatorSigner = {
      nip44: {
        encrypt: (peer, text) => bounded(() => (remote ?? local).nip44!.encrypt(peer, text)),
        decrypt: (peer, text) => bounded(() => (remote ?? local).nip44!.decrypt(peer, text)),
      },
      getPublicKey: async () => {
        if (closed) throw new AccountError('SIGNER_CLOSED', 'Signer session closed.');
        return pubkey;
      },
      signEvent: async (event) => {
        if (!kinds.includes(event.kind))
          throw new AccountError(
            'SIGNING_SCOPE',
            'This event kind is outside the permissions for this session.',
          );
        const template = structuredClone({
          kind: event.kind,
          created_at: event.created_at,
          content: event.content,
          tags: event.tags,
        });
        const expected = JSON.stringify(template);
        return bounded(async () => {
          const result = verifiedEvent(await (remote ?? local).signEvent(template));
          if (
            result.pubkey !== pubkey ||
            JSON.stringify({
              kind: result.kind,
              created_at: result.created_at,
              content: result.content,
              tags: result.tags,
            }) !== expected
          )
            throw new AccountError(
              'SIGNER_CHANGED_EVENT',
              'Signer changed the requested event. Nothing was published.',
            );
          return result;
        });
      },
      close,
    };
    return {
      signer,
      credential: remote
        ? {
            type: 'remote' as const,
            clientKey: keyHex,
            remote: remote.remote!,
            relays: [...remote.relays],
          }
        : undefined,
    };
  } catch (error) {
    await close();
    throw error;
  }
}
