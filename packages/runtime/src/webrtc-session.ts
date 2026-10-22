import { z } from 'zod';
import { type NostrEvent } from 'nostr-tools';
import { verifySignature } from '../../protocol/src/verify';
import { ApplesauceRelayPool } from '@contextvm/sdk/relay';
import type { PrivateKeySigner } from '@contextvm/sdk/signer';
import { sha256 } from '../../protocol/src/artifact';
import { peerDiagnostics } from './webrtc-diagnostics';

const hex = z.string().regex(/^[a-f0-9]{64}$/);
const openSchema = z
  .object({
    scope: z.discriminatedUnion('type', [
      z.object({ type: z.literal('direct'), pubkey: hex }).strict(),
      z
        .object({
          type: z.literal('room'),
          room: z.string().min(1).max(256),
          peers: z.array(hex).max(8).optional(),
        })
        .strict(),
    ]),
    channel: z.string().min(1).max(64).default('napplet'),
    protocol: z.string().max(128).optional(),
  })
  .strict();
type Open = z.infer<typeof openSchema>;
type Peer = {
  pc: RTCPeerConnection;
  channel?: RTCDataChannel;
  nonce: string;
  chain: Promise<void>;
  answer?: string;
  offer?: string;
  started: number;
  joined: boolean;
  received: number;
  bytes: number;
  window: number;
  queued: number;
};
type Session = {
  id: string;
  request: Open;
  wire: string;
  nonce: string;
  self: string;
  state: 'connecting' | 'open' | 'closed';
  peers: Map<string, Peer>;
  seen: Set<string>;
  pool: ApplesauceRelayPool;
  timer?: ReturnType<typeof setInterval>;
  config: RTCConfiguration;
  signals: number;
  signalWindow: number;
};

/** NAP-WEBRTC. Signaling profile soy-rtc/1 is public/documented, separate from the NAP API. */
export class NappletWebrtc {
  private sessions = new Map<string, Session>();
  private alive = true;
  private permission?: Promise<boolean>;
  private opening = 0;
  constructor(
    private signer: PrivateKeySigner,
    private identity: string,
    private relays: string[],
    private send: (message: Record<string, unknown>) => void,
    private consent: () => Promise<boolean>,
    private ice: () => Promise<RTCConfiguration> = async () => ({ iceServers: [] }),
  ) {}
  private event(session: Session, event: Record<string, unknown>) {
    if (this.alive && (this.sessions.has(session.id) || event.type === 'closed'))
      this.send({ type: 'webrtc.event', event: { ...event, sessionId: session.id } });
  }
  async handle(message: Record<string, unknown>): Promise<Record<string, unknown>> {
    if (message.type === 'webrtc.open') return this.open(message.request);
    const id = z.string().max(128).parse(message.sessionId),
      session = this.sessions.get(id);
    if (message.type === 'webrtc.close') {
      this.closeSession(id, z.string().max(200).optional().parse(message.reason) ?? 'closed');
      return {};
    }
    if (!session) throw new Error('WebRTC session unavailable');
    if (message.type !== 'webrtc.send') throw new Error('Unsupported WebRTC operation');
    const payload = JSON.stringify(message.payload);
    if (payload === undefined || new TextEncoder().encode(payload).length > 16384)
      throw new Error('WebRTC payload must be JSON and at most 16 KiB');
    const channels = [...session.peers.values()]
      .map((p) => p.channel)
      .filter((c): c is RTCDataChannel => c?.readyState === 'open');
    if (!channels.length) throw new Error('WebRTC is connecting; wait for a peer joined event');
    if (channels.some((c) => c.bufferedAmount + payload.length > 262144))
      throw new Error('WebRTC backpressure; skip obsolete frames and retry later');
    for (const channel of channels) channel.send(payload);
    return {};
  }
  private async open(input: unknown) {
    const request = openSchema.parse(input);
    if (!this.alive || this.sessions.size + this.opening >= 4)
      throw new Error('WebRTC session limit reached');
    this.opening++;
    try {
      const permission = (this.permission ??= this.consent());
      const allowed = await permission;
      if (this.permission === permission) this.permission = undefined;
      if (!allowed) {
        throw new Error(
          'Peer connection denied. You can change multiplayer permission in Network settings.',
        );
      }
      if (!this.alive) throw new Error('Player closed');
      const self = await this.signer.getPublicKey();
      if (request.scope.type === 'direct' && request.scope.pubkey === self)
        throw new Error('Cannot connect to yourself');
      const scope =
        request.scope.type === 'room'
          ? ['room', request.scope.room]
          : ['direct', ...[self, request.scope.pubkey].sort()];
      const wire = await sha256(
        JSON.stringify([
          'soy-rtc/1',
          this.identity,
          scope,
          request.channel,
          request.protocol ?? '',
        ]),
      );
      if ([...this.sessions.values()].some((s) => s.wire === wire))
        throw new Error('This WebRTC scope is already open');
      const config = await this.ice();
      if (!this.alive) throw new Error('Player closed');
      const session: Session = {
        id: crypto.randomUUID(),
        request,
        wire,
        nonce: crypto.randomUUID(),
        self,
        state: 'connecting',
        peers: new Map(),
        seen: new Set(),
        pool: new ApplesauceRelayPool(this.relays, {
          publishOptions: { timeout: 3000, retries: 0 },
        }),
        config,
        signals: 0,
        signalWindow: Date.now(),
      };
      this.sessions.set(session.id, session);
      // Reply before emitting events; all work is owned by the session's lifecycle.
      setTimeout(() => {
        if (this.sessions.has(session.id))
          void this.start(session).catch(() =>
            this.closeSession(session.id, 'Signaling unavailable'),
          );
      }, 0);
      return { session: { id: session.id, ...request, state: session.state } };
    } finally {
      this.opening--;
    }
  }
  /** Diagnostic UI lives in the host; this is not an extra NAP operation. */
  diagnostics() {
    return Promise.all(
      [...this.sessions.values()].flatMap((session) =>
        [...session.peers].map(([key, peer]) =>
          peerDiagnostics(session.id, key, peer.pc, peer.channel),
        ),
      ),
    );
  }
  private allowed(s: Session, key: string) {
    return (
      key !== s.self &&
      (s.request.scope.type === 'direct'
        ? s.request.scope.pubkey === key
        : !s.request.scope.peers || s.request.scope.peers.includes(key))
    );
  }
  private async publish(s: Session, message: Record<string, unknown>, recipient?: string) {
    if (!this.sessions.has(s.id)) return;
    const raw = JSON.stringify({ v: 'soy-rtc/1', wire: s.wire, nonce: s.nonce, ...message });
    const content = recipient ? await this.signer.nip44.encrypt(recipient, raw) : raw;
    const event = await this.signer.signEvent({
      pubkey: s.self,
      kind: 25050,
      created_at: Math.floor(Date.now() / 1000),
      tags: [
        ['d', s.wire],
        ...(recipient ? [['p', recipient]] : []),
        ['expiration', String(Math.floor(Date.now() / 1000) + 60)],
      ],
      content,
    });
    if (!this.sessions.has(s.id)) return;
    await s.pool.publish(event, { abortSignal: AbortSignal.timeout(4000) });
  }
  private async start(s: Session) {
    await s.pool.connect();
    if (!this.sessions.has(s.id)) {
      await s.pool.disconnect();
      return;
    }
    await s.pool.subscribe(
      [{ kinds: [25050], '#d': [s.wire], since: Math.floor(Date.now() / 1000) - 10 }],
      (event) => {
        void this.receive(s, event).catch(() => {});
      },
    );
    if (!this.sessions.has(s.id)) {
      await s.pool.disconnect();
      return;
    }
    const hello = () => {
      if (!this.sessions.has(s.id)) return;
      void this.publish(s, { type: 'hello' }).catch(() => {});
      for (const [key, peer] of s.peers) {
        if (!peer.joined && Date.now() - peer.started > 45000) {
          this.closeSession(s.id, 'Peer connection timed out; retry or check TURN configuration');
          return;
        }
        if (peer.offer && !peer.pc.remoteDescription)
          void this.publish(s, { type: 'offer', to: peer.nonce, sdp: peer.offer }, key).catch(
            () => {},
          );
      }
    };
    hello();
    s.timer = setInterval(hello, 2000);
  }
  private async receive(s: Session, event: NostrEvent) {
    if (Date.now() - s.signalWindow >= 1000) {
      s.signalWindow = Date.now();
      s.signals = 0;
    }
    if (++s.signals > 32) return;
    if (
      !this.sessions.has(s.id) ||
      !this.allowed(s, event.pubkey) ||
      event.content.length > 64000 ||
      Math.abs(Date.now() / 1000 - event.created_at) > 60 ||
      s.seen.has(event.id) ||
      !verifySignature(event)
    )
      return;
    if (s.seen.size >= 2048) s.seen.delete(s.seen.values().next().value!);
    s.seen.add(event.id);
    const recipient = event.tags.find((t) => t[0] === 'p')?.[1];
    if (recipient && recipient !== s.self) return;
    const body = JSON.parse(
      recipient ? await this.signer.nip44.decrypt(event.pubkey, event.content) : event.content,
    );
    if (!this.sessions.has(s.id)) return;
    if (
      body.v !== 'soy-rtc/1' ||
      body.wire !== s.wire ||
      typeof body.nonce !== 'string' ||
      body.nonce.length > 64
    )
      return;
    if (!recipient && body.type !== 'hello') return;
    if (recipient && body.to !== s.nonce) return;
    let peer = s.peers.get(event.pubkey);
    if (body.type === 'hello') {
      if (peer && peer.nonce !== body.nonce) {
        this.removePeer(s, event.pubkey);
        peer = undefined;
      }
      if (!peer) {
        if (s.peers.size >= 8) return;
        peer = this.peer(s, event.pubkey, body.nonce);
        s.peers.set(event.pubkey, peer);
        // Repeat our presence in response only to a new peer (no hello feedback loop).
        void this.publish(s, { type: 'hello' }).catch(() => {});
        if (s.self < event.pubkey) {
          const p = peer;
          p.chain = p.chain
            .then(async () => {
              if (!this.sessions.has(s.id) || s.peers.get(event.pubkey) !== p) return;
              this.channel(
                s,
                event.pubkey,
                p,
                p.pc.createDataChannel(s.request.channel, { ordered: true }),
              );
              await p.pc.setLocalDescription(await p.pc.createOffer());
              await this.gather(p.pc);
              p.offer = p.pc.localDescription!.sdp;
              await this.publish(s, { type: 'offer', to: p.nonce, sdp: p.offer }, event.pubkey);
            })
            .catch(() => this.removePeer(s, event.pubkey));
        }
      }
      return;
    }
    if (!peer || body.nonce !== peer.nonce) return;
    const p = peer;
    if (p.queued >= 4) return;
    p.queued++;
    p.chain = p.chain
      .then(async () => {
        if (!this.sessions.has(s.id) || s.peers.get(event.pubkey) !== p) return;
        if (typeof body.sdp !== 'string' || body.sdp.length > 32000) return;
        if (body.type === 'offer' && event.pubkey < s.self) {
          if (!p.answer) {
            await p.pc.setRemoteDescription({ type: 'offer', sdp: body.sdp });
            await p.pc.setLocalDescription(await p.pc.createAnswer());
            await this.gather(p.pc);
            p.answer = p.pc.localDescription!.sdp;
          }
          await this.publish(s, { type: 'answer', to: p.nonce, sdp: p.answer }, event.pubkey);
        } else if (body.type === 'answer' && s.self < event.pubkey && !p.pc.remoteDescription) {
          await p.pc.setRemoteDescription({ type: 'answer', sdp: body.sdp });
        }
      })
      .catch(() => this.removePeer(s, event.pubkey))
      .finally(() => {
        p.queued--;
      });
  }
  private peer(s: Session, key: string, nonce: string): Peer {
    const pc = new RTCPeerConnection(s.config);
    const peer: Peer = {
      pc,
      nonce,
      chain: Promise.resolve(),
      started: Date.now(),
      joined: false,
      received: 0,
      bytes: 0,
      window: Date.now(),
      queued: 0,
    };
    pc.ondatachannel = (event) => this.channel(s, key, peer, event.channel);
    pc.onconnectionstatechange = () => {
      if (pc.connectionState === 'failed')
        this.closeSession(
          s.id,
          'Peer connection failed; reopen the session to refresh connectivity',
        );
      else if (pc.connectionState === 'closed') this.removePeer(s, key);
    };
    return peer;
  }
  private channel(s: Session, key: string, p: Peer, channel: RTCDataChannel) {
    if (p.channel || channel.label !== s.request.channel) {
      channel.close();
      return;
    }
    p.channel = channel;
    channel.onopen = () => {
      p.joined = true;
      if (s.state !== 'open') {
        s.state = 'open';
        this.event(s, { type: 'state', state: 'open' });
      }
      this.event(s, { type: 'peer', pubkey: key, state: 'joined' });
    };
    channel.onclose = () => this.removePeer(s, key);
    channel.onmessage = (event) => {
      if (typeof event.data !== 'string') return;
      if (Date.now() - p.window > 1000) {
        p.window = Date.now();
        p.received = 0;
        p.bytes = 0;
      }
      const bytes = new TextEncoder().encode(event.data).length;
      p.bytes += bytes;
      if (++p.received > 240 || p.bytes > 524288 || bytes > 16384) {
        this.removePeer(s, key);
        return;
      }
      try {
        this.event(s, { type: 'message', from: key, payload: JSON.parse(event.data) });
      } catch {}
    };
  }
  private gather(pc: RTCPeerConnection) {
    if (pc.iceGatheringState === 'complete') return Promise.resolve();
    return new Promise<void>((resolve) => {
      const done = () => {
        clearTimeout(timer);
        pc.removeEventListener('icegatheringstatechange', changed);
        resolve();
      };
      const changed = () => {
        if (pc.iceGatheringState === 'complete') done();
      };
      const timer = setTimeout(done, 8000);
      pc.addEventListener('icegatheringstatechange', changed);
    });
  }
  private removePeer(s: Session, key: string) {
    const peer = s.peers.get(key);
    if (!peer) return;
    s.peers.delete(key);
    peer.pc.onconnectionstatechange = null;
    if (peer.channel) {
      peer.channel.onclose = null;
      peer.channel.close();
    }
    peer.pc.close();
    if (peer.joined) this.event(s, { type: 'peer', pubkey: key, state: 'left' });
    if (![...s.peers.values()].some((p) => p.joined) && s.state === 'open') {
      s.state = 'connecting';
      this.event(s, { type: 'state', state: 'connecting' });
    }
  }
  private closeSession(id: string, reason: string) {
    const session = this.sessions.get(id);
    if (!session) return;
    this.sessions.delete(id);
    clearInterval(session.timer);
    for (const key of session.peers.keys()) this.removePeer(session, key);
    void session.pool.disconnect();
    session.state = 'closed';
    this.event(session, { type: 'closed', reason });
  }
  close(reason = 'Player closed') {
    for (const id of this.sessions.keys()) this.closeSession(id, reason);
    this.alive = false;
  }
}
