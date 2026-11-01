import { expect, test } from 'bun:test';
import { NappletMedia } from './media-session';

class FakeAudio extends EventTarget {
  src = '';
  preload = '';
  volume = 1;
  currentTime = 0;
  duration = Infinity;
  error = null;
  paused = true;
  denied = false;
  loads = 0;
  play() {
    if (this.denied) return Promise.reject(new DOMException('Gesture required', 'NotAllowedError'));
    this.paused = false;
    this.dispatchEvent(new Event('playing'));
    return Promise.resolve();
  }
  pause() {
    this.paused = true;
    this.dispatchEvent(new Event('pause'));
  }
  load() {
    this.loads++;
  }
  removeAttribute() {
    this.src = '';
  }
  getAttribute() {
    return this.src;
  }
}
function fixture() {
  const messages: any[] = [],
    players: FakeAudio[] = [],
    requests: { url: string; method: string }[] = [];
  let activate: (() => void) | undefined;
  const host = new NappletMedia({
    manifest: 'a'.repeat(64),
    send: (m) => messages.push(m),
    activate: (_, play) => {
      activate = play;
    },
    audio: () => {
      const a = new FakeAudio();
      players.push(a);
      return a as unknown as HTMLAudioElement;
    },
    fetch: (async (url: string, options: RequestInit) => {
      requests.push({ url, method: options.method! });
      return Response.json({ url: `/api/media?token=${crypto.randomUUID()}` });
    }) as typeof fetch,
  });
  const create = async (overrides: Record<string, unknown> = {}) => {
    const id = crypto.randomUUID();
    host.handle({
      type: 'media.session.create',
      id,
      owner: 'shell',
      live: true,
      source: { url: 'https://audio.example/live.mp3', mimeType: 'audio/mpeg' },
      ...overrides,
    });
    for (let i = 0; i < 50 && !messages.some((m) => m.id === id); i++) await Bun.sleep(1);
    return messages.find((m) => m.id === id);
  };
  return { host, messages, players, requests, create, activate: () => activate?.() };
}
test('canonical media sessions play, pause, stop and clean up without trusting frame state', async () => {
  const f = fixture();
  try {
    const result = await f.create({ sessionId: 'creator-hint' });
    expect(result.owner).toBe('shell');
    expect(result.sessionId).not.toBe('creator-hint');
    const id = result.sessionId;
    await Bun.sleep(5);
    expect(f.messages.find((m) => m.type === 'media.capabilities').actions).toEqual([
      'play',
      'pause',
      'stop',
      'volume',
    ]);
    f.host.handle({ type: 'media.command', sessionId: 'creator-hint', action: 'play' });
    expect(f.players[0].paused).toBe(true);
    f.host.handle({ type: 'media.command', sessionId: id, action: 'play' });
    expect(f.host.getSnapshot()[0].status).toBe('playing');
    f.host.handle({ type: 'media.state', sessionId: id, status: 'stopped' });
    expect(f.host.getSnapshot()[0].status).toBe('playing');
    f.host.command(id, 'volume', 0.4);
    f.host.command(id, 'volume', 99);
    expect(f.players[0].volume).toBe(0.4);
    f.host.command(id, 'seek', 30);
    expect(f.players[0].currentTime).toBe(0);
    f.host.command(id, 'pause');
    expect(f.players[0].paused).toBe(true);
    f.host.command(id, 'play');
    f.host.command(id, 'stop');
    expect(f.players[0].src).toBe('');
    f.host.command(id, 'play');
    expect(f.players[0].src).toBe('https://audio.example/live.mp3');
    f.host.handle({ type: 'media.session.destroy', sessionId: id });
    expect(f.host.getSnapshot()).toEqual([]);
    expect(f.players[0].src).toBe('');
    expect(f.requests).toHaveLength(0);
  } finally {
    f.host.close();
  }
});
test('missing/unsupported sources, owner modes and excessive sessions return correlated errors', async () => {
  const f = fixture();
  try {
    for (const override of [
      { owner: undefined },
      { owner: 'invalid' },
      { source: undefined },
      { source: { url: 'http://audio.example' } },
      { metadata: { mediaType: 'video' } },
    ])
      expect((await f.create(override)).error).toBeString();
    expect(f.requests).toHaveLength(0);
    for (let i = 0; i < 4; i++) expect((await f.create()).sessionId).toBeString();
    expect((await f.create()).error).toBe('session limit exceeded');
  } finally {
    f.host.close();
  }
});

test('napplet-owned sessions report state and capabilities without granting source fetch authority', async () => {
  const f = fixture();
  try {
    const result = await f.create({
      owner: 'napplet',
      source: { url: 'http://127.0.0.1/private' },
      metadata: { title: 'Game sounds' },
      capabilities: ['pause', 'play', 'volume'],
    });
    expect(result.owner).toBe('napplet');
    expect(result.sessionId).toBeString();
    const id = result.sessionId;
    await Bun.sleep(5);
    expect(f.players).toEqual([]);
    expect(f.requests).toEqual([]);
    expect(f.messages.find((m) => m.type === 'media.controls')?.controls).toEqual([
      'play',
      'pause',
      'volume',
    ]);
    f.host.handle({ type: 'media.state', sessionId: id, status: 'playing', volume: 0.6 });
    expect(f.host.getSnapshot()[0]).toMatchObject({ status: 'playing', volume: 0.6 });
    const count = f.messages.length;
    f.host.handle({ type: 'media.command', sessionId: id, action: 'pause' });
    expect(f.messages).toHaveLength(count); // A napplet cannot impersonate its controller.
    f.host.command(id, 'volume', 2);
    f.host.command(id, 'stop'); // Not advertised.
    expect(f.messages).toHaveLength(count);
    f.host.command(id, 'pause');
    expect(f.messages.at(-1)).toEqual({ type: 'media.command', sessionId: id, action: 'pause' });
    expect(f.host.getSnapshot()[0].status).toBe('playing'); // Wait for owner acknowledgement.
    f.host.handle({ type: 'media.state', sessionId: id, status: 'paused', volume: 2 });
    expect(f.host.getSnapshot()[0].status).toBe('playing');
    f.host.handle({ type: 'media.state', sessionId: id, status: 'paused', volume: 0.6 });
    f.host.handle({ type: 'media.capabilities', sessionId: id, actions: ['play'] });
    expect(f.host.getSnapshot()[0]).toMatchObject({ status: 'paused', actions: ['play'] });
    expect(f.messages.at(-1)).toEqual({
      type: 'media.controls',
      sessionId: id,
      controls: ['play'],
    });
    f.host.handle({ type: 'media.session.destroy', sessionId: id });
    const afterDestroy = f.messages.length;
    f.host.handle({ type: 'media.state', sessionId: id, status: 'playing' });
    f.host.command(id, 'play');
    expect(f.host.getSnapshot()).toEqual([]);
    expect(f.messages).toHaveLength(afterDestroy);
  } finally {
    f.host.close();
  }
});

test('audio focus crosses frame and owner boundaries; closing requests stop before retiring the endpoint', async () => {
  const first = fixture(),
    second = fixture();
  try {
    const a = (
      await first.create({
        owner: 'napplet',
        source: undefined,
        capabilities: ['play', 'pause', 'stop'],
      })
    ).sessionId;
    const b = (await second.create()).sessionId;
    expect(a).toBeString();
    first.host.handle({ type: 'media.state', sessionId: a, status: 'playing' });
    second.host.command(b, 'play');
    expect(first.messages.at(-1)).toEqual({ type: 'media.command', sessionId: a, action: 'pause' });
    first.host.handle({ type: 'media.state', sessionId: a, status: 'paused' });
    first.host.handle({ type: 'media.state', sessionId: a, status: 'playing' });
    expect(second.players[0].paused).toBe(true);
    first.host.close();
    expect(first.messages.at(-1)).toEqual({ type: 'media.command', sessionId: a, action: 'stop' });
    const count = first.messages.length;
    first.host.handle({ type: 'media.state', sessionId: a, status: 'playing' });
    first.host.close();
    expect(first.messages).toHaveLength(count);
    expect(first.host.getSnapshot()).toEqual([]);
  } finally {
    first.host.close();
    second.host.close();
  }
});
test('browser gesture denial is recoverable, focus pauses other sessions and stale gestures do nothing', async () => {
  const f = fixture();
  try {
    const first = (await f.create()).sessionId,
      second = (await f.create()).sessionId;
    f.players[0].denied = true;
    f.host.command(first, 'play');
    await Bun.sleep(1);
    expect(f.host.getSnapshot()[0].error).toContain('Play audio');
    f.players[0].denied = false;
    f.activate();
    expect(f.players[0].paused).toBe(false);
    f.host.command(second, 'play');
    expect(f.players[0].paused).toBe(true);
    f.players[0].denied = true;
    f.host.command(first, 'play');
    await Bun.sleep(1);
    f.host.close();
    f.players[0].denied = false;
    f.activate();
    expect(f.players.every((p) => p.paused && !p.src)).toBe(true);
    expect(f.host.getSnapshot()).toEqual([]);
  } finally {
    f.host.close();
  }
});
