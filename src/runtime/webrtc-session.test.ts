import { test, expect } from 'bun:test';
import { PrivateKeySigner } from '@contextvm/sdk/signer';
import { NappletWebrtc } from './webrtc-session.ts';

function fixture() {
  const events: any[] = [];
  const rtc: any = new NappletWebrtc(
    new PrivateKeySigner(),
    'fixture',
    [],
    (m) => events.push(m),
    async () => true,
  );
  const s: any = {
    id: 's',
    request: { scope: { type: 'room', room: 'test' }, channel: 'game', ordered: true },
    wire: 'test',
    nonce: 'local',
    self: 'f'.repeat(64),
    peers: new Map(),
    seen: new Set(),
    retired: new Set(),
    state: 'open',
    config: {},
    signals: 0,
    signalWindow: Date.now(),
    sendWindow: Date.now(),
    sent: 0,
    sentBytes: 0,
    pool: { disconnect: async () => {} },
  };
  rtc.sessions.set('s', s);
  rtc.publish = async () => {};
  const peer = (key: string, binary = true) => {
    const sent: any[] = [];
    const channel: any = {
      label: 'game',
      ordered: true,
      maxRetransmits: null,
      maxPacketLifeTime: null,
      readyState: 'open',
      bufferedAmount: 0,
      send: (data: unknown) => sent.push(data),
      close() {
        this.readyState = 'closed';
      },
    };
    const p: any = {
      pc: { close() {}, connectionState: 'connected' },
      nonce: key,
      binary,
      joined: false,
      outbound: [],
      outboundBytes: 0,
      window: Date.now(),
      received: 0,
      bytes: 0,
    };
    s.peers.set(key, p);
    rtc.channel(s, key, p, channel);
    channel.onopen();
    return { p, channel, sent };
  };
  return { rtc, s, events, peer };
}
test('broadcast preflights every peer; unsupported bytes and QUEUE_FULL cannot send to any peer', async () => {
  const f = fixture(),
    a = f.peer('a'),
    b = f.peer('b', false);
  try {
    await expect(
      f.rtc.handle({ type: 'webrtc.sendBytes', sessionId: 's', bytes: 'AA==' }),
    ).rejects.toThrow('unsupported');
    expect(a.sent).toEqual([]);
    expect(b.sent).toEqual([]);
    b.p.binary = true;
    b.channel.bufferedAmount = 262144;
    await expect(
      f.rtc.handle({ type: 'webrtc.send', sessionId: 's', payload: '😀' }),
    ).rejects.toThrow('QUEUE_FULL');
    expect(a.sent).toEqual([]);
    expect(b.sent).toEqual([]);
    b.channel.bufferedAmount = 0;
    await f.rtc.handle({ type: 'webrtc.sendBytes', sessionId: 's', bytes: 'AA==' });
    expect(a.sent[0]).toEqual(new Uint8Array([0]));
    expect(b.sent).toEqual(a.sent);
    a.channel.onmessage({ data: '"AA=="' });
    a.channel.onmessage({ data: new Uint8Array([0]).buffer });
    expect(f.events.slice(-2).map((m) => m.event)).toEqual([
      { type: 'message', sessionId: 's', from: 'a', payload: 'AA==' },
      { type: 'bytes', sessionId: 's', from: 'a', bytes: 'AA==' },
    ]);
  } finally {
    f.rtc.close();
  }
});
test('peer failure discards only that queue; stale callbacks cannot deliver after departure or teardown', async () => {
  const f = fixture(),
    a = f.peer('a'),
    b = f.peer('b');
  const stale = a.channel.onmessage;
  a.channel.send = () => {
    throw new DOMException('Gone', 'InvalidStateError');
  };
  await f.rtc.handle({ type: 'webrtc.send', sessionId: 's', payload: { from: 'spoof' } });
  expect(f.s.peers.has('a')).toBe(false);
  expect(f.s.peers.has('b')).toBe(true);
  expect(b.sent).toEqual(['{"from":"spoof"}']);
  const count = f.events.length;
  stale({ data: '{"from":"a"}' });
  expect(f.events).toHaveLength(count);
  b.channel.onmessage({ data: 'x'.repeat(16385) });
  expect(f.s.peers.size).toBe(0);
  expect(f.s.state).toBe('connecting');
  f.rtc.close();
  stale({ data: '{}' });
  expect(f.events.at(-1).event.type).toBe('closed');
});
test('authenticated host hello gates legacy bytes and late-join delivery; forged identities are rejected', async () => {
  const f = fixture(),
    remote = new PrivateKeySigner(),
    key = await remote.getPublicKey();
  // No browser doubles for authentication: signatures are real Nostr signatures.
  const old = globalThis.RTCPeerConnection;
  (globalThis as any).RTCPeerConnection = class {
    close() {}
  };
  const hello = async (rt?: unknown, nonce = 'remote') =>
    remote.signEvent({
      pubkey: key,
      kind: 25050,
      created_at: Math.floor(Date.now() / 1000),
      tags: [['d', 'test']],
      content: JSON.stringify({
        v: 'soy-rtc/1',
        wire: 'test',
        nonce,
        type: 'hello',
        ...(rt ? { realtime: rt } : {}),
      }),
    });
  try {
    const event = JSON.parse(JSON.stringify(await hello()));
    await f.rtc.receive(f.s, { ...event, pubkey: 'a'.repeat(64) });
    expect(f.s.peers.size).toBe(0);
    await f.rtc.receive(f.s, event);
    expect(f.s.peers.get(key).binary).toBe(false);
    const rt = {
      profile: 'soy-rtc/realtime-1',
      bytes: true,
      ordered: false,
      maxRetransmits: 0,
      maxPayloadBytes: 16384,
    };
    await f.rtc.receive(f.s, await hello(rt, 'incompatible'));
    expect(f.s.peers.get(key).nonce).toBe('remote');
    await f.rtc.receive(f.s, await hello({ ...rt, ordered: true, maxRetransmits: null }, 'new'));
    expect(f.s.peers.get(key).binary).toBe(true);
    // A replay with a new event ID still cannot restore a retired incarnation.
    f.s.seen.clear();
    await f.rtc.receive(f.s, event);
    expect(f.s.peers.get(key).nonce).toBe('new');
  } finally {
    f.rtc.close();
    globalThis.RTCPeerConnection = old;
  }
});

test('a retired negotiation failure cannot remove the replacement peer incarnation', () => {
  const f = fixture(),
    old = f.peer('a');
  f.rtc.removePeer(f.s, 'a', old.p);
  const current = f.peer('a');
  f.rtc.removePeer(f.s, 'a', old.p);
  expect(f.s.peers.get('a')).toBe(current.p);
  expect(current.channel.readyState).toBe('open');
  f.rtc.close();
});
