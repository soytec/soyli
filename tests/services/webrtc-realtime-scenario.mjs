export default async ({ players, check, network }) => {
  const [a, b, c] = players;
  for (const p of players) {
    await p.page.evaluate(() => {
      const Native = RTCPeerConnection;
      window.rtcChannels = [];
      window.rtcConnections = [];
      window.RTCPeerConnection = class extends Native {
        constructor(config) {
          super(config);
          window.rtcConnections.push(this);
          this.addEventListener('datachannel', (e) => window.rtcChannels.push(e.channel));
        }
        createDataChannel(...args) {
          const ch = super.createDataChannel(...args);
          window.rtcChannels.push(ch);
          return ch;
        }
      };
    });
    await p.frame.evaluate(() => {
      window.events = [];
      window.napplet.webrtc.onEvent((e) =>
        window.events.push({ ...e, observed: performance.now() }),
      );
    });
  }
  const actors = await Promise.all(
    players.map((p) =>
      p.frame.evaluate(
        async () =>
          (await window.napplet.cvm.registry.call('soy.rooms.v1', 'soy_session', {}))
            .structuredContent.actor,
      ),
    ),
  );
  const room = crypto.randomUUID();
  const open = (p, channel, delivery = {}) =>
    p.frame.evaluate(
      async ({ room, channel, delivery }) => {
        const result = await window.napplet.webrtc.open({
          scope: { type: 'room', room },
          channel,
          ...delivery,
        });
        window[channel] = result.session.id;
        return result.session;
      },
      { room, channel, delivery },
    );
  const joined = (p, session, count) =>
    p.frame.waitForFunction(
      ({ session, count }) =>
        window.events.filter(
          (e) => e.sessionId === window[session] && e.type === 'peer' && e.state === 'joined',
        ).length >= count,
      { session, count },
      { timeout: 30000 },
    );
  const send = (p, channel, payload) =>
    p.frame.evaluate(
      ({ channel, payload }) => window.napplet.webrtc.send(window[channel], payload),
      { channel, payload },
    );
  const bytes = (p, channel, value) =>
    p.frame.evaluate(
      ({ channel, value }) => window.napplet.webrtc.sendBytes(window[channel], value),
      { channel, value },
    );
  const seen = (p, channel, type, value) =>
    p.frame.waitForFunction(
      ({ channel, type, value }) =>
        window.events.some(
          (e) =>
            e.sessionId === window[channel] &&
            e.type === type &&
            (type === 'bytes' ? e.bytes === value : e.payload?.marker === value),
        ),
      { channel, type, value },
    );
  const fallback = await open(a, 'unsupported-delivery', { ordered: false, maxRetransmits: 65536 });
  check(
    'unsupported native delivery opens with its actual reliable fallback',
    fallback.ordered === true && fallback.maxRetransmits === undefined,
  );
  await a.frame.evaluate((id) => window.napplet.webrtc.close(id), fallback.id);
  const initial = await Promise.all([open(a, 'control'), open(b, 'control')]);
  check(
    'existing JSON opens report reliable ordered delivery and byte limit',
    initial.every(
      (s) => s.ordered === true && s.maxRetransmits === undefined && s.maxPayloadBytes === 16384,
    ),
  );
  await Promise.all([joined(a, 'control', 1), joined(b, 'control', 1)]);
  await send(a, 'control', { marker: 'json', from: 'spoof' });
  await seen(b, 'control', 'message', 'json');
  check(
    'sender is authenticated transport key, never payload identity',
    await b.frame.evaluate(
      (key) =>
        window.events.find((e) => e.type === 'message' && e.payload?.marker === 'json').from ===
        key,
      actors[0],
    ),
  );
  await bytes(a, 'control', 'AP+A');
  await seen(b, 'control', 'bytes', 'AP+A');
  await bytes(b, 'control', '');
  await seen(a, 'control', 'bytes', '');
  for (const value of ['AB==', 'AA', '_w==', 'AA==\n', btoa('x'.repeat(16385))]) {
    const error = await bytes(a, 'control', value).then(
      () => '',
      (e) => e.message,
    );
    check('reject malformed/oversized binary ' + value.slice(0, 12), !!error);
  }
  await open(c, 'control');
  await Promise.all([joined(a, 'control', 2), joined(c, 'control', 2)]);
  await send(a, 'control', { marker: 'broadcast' });
  await Promise.all([
    seen(b, 'control', 'message', 'broadcast'),
    seen(c, 'control', 'message', 'broadcast'),
  ]);
  check('late room join receives broadcasts', true);
  await a.page.evaluate(() => {
    for (const ch of window.rtcChannels.filter((c) => c.label === 'control'))
      Object.defineProperty(ch, 'bufferedAmount', { configurable: true, get: () => 262144 });
  });
  const full = await send(a, 'control', { marker: 'must-not-send' }).then(
    () => '',
    (e) => e.message,
  );
  check('full broadcast fails before any payload is queued', full.includes('QUEUE_FULL'));
  await a.page.evaluate(() => {
    for (const ch of window.rtcChannels) delete ch.bufferedAmount;
  });
  await a.page.waitForTimeout(100);
  check(
    'queue rejection delivered nothing to either peer',
    (
      await Promise.all(
        [b, c].map((p) =>
          p.frame.evaluate(() => !window.events.some((e) => e.payload?.marker === 'must-not-send')),
        ),
      )
    ).every(Boolean),
  );
  const actual = await Promise.all([
    open(a, 'state', { ordered: false, maxRetransmits: 0 }),
    open(b, 'state', { ordered: false, maxRetransmits: 0 }),
  ]);
  await Promise.all([joined(a, 'state', 1), joined(b, 'state', 1)]);
  check(
    'transient settings match the actual data channel',
    actual.every((s) => s.ordered === false && s.maxRetransmits === 0) &&
      (await a.page.evaluate(() =>
        window.rtcChannels
          .filter((c) => c.label === 'state')
          .every((c) => !c.ordered && c.maxRetransmits === 0),
      )),
  );
  await open(c, 'state');
  await c.page.waitForTimeout(2500);
  check(
    'incompatible late peer cannot silently downgrade the room',
    await c.frame.evaluate(
      () =>
        !window.events.some(
          (e) => e.sessionId === window.state && e.type === 'peer' && e.state === 'joined',
        ),
    ),
  );
  await c.frame.evaluate(() => window.napplet.webrtc.close(window.state));
  await open(c, 'state', { ordered: false, maxRetransmits: 0 });
  await joined(c, 'state', 2);
  await network({ latencyMs: 100, jitterMs: 95, lossRatio: 0.25, retransmitMs: 250 });
  for (let i = 0; i < 40; i++) {
    await send(a, 'state', { marker: 'transient', seq: i });
    if (i % 10 === 0) await send(a, 'control', { marker: 'reliable-' + i });
    await a.page.waitForTimeout(10);
  }
  await seen(b, 'control', 'message', 'reliable-30');
  await a.page.waitForTimeout(600);
  const seq = await b.frame.evaluate(() =>
    window.events.filter((e) => e.payload?.marker === 'transient').map((e) => e.payload.seq),
  );
  check('simulated loss drops transient updates', seq.length > 0 && seq.length < 40);
  check(
    'unordered updates really reorder',
    seq.some((n, i) => i > 0 && n < seq[i - 1]),
  );
  check('reliable control survives alongside transient loss', true);
  await network({ latencyMs: 0, jitterMs: 0, lossRatio: 0 });
  // Fail one native connection. The other peer and room remain usable.
  await b.page.evaluate(() => {
    const pc = window.rtcConnections.find((p) => p.connectionState === 'connected');
    Object.defineProperty(pc, 'connectionState', { get: () => 'failed' });
    pc.dispatchEvent(new Event('connectionstatechange'));
  });
  await b.frame.evaluate(() => window.napplet.webrtc.close(window.control, 'Leaving'));
  await send(a, 'control', { marker: 'healthy-room' });
  await seen(c, 'control', 'message', 'healthy-room');
  check(
    'one failed/departing peer does not close a healthy room',
    await a.frame.evaluate(
      () => !window.events.some((e) => e.sessionId === window.control && e.type === 'closed'),
    ),
  );
  await open(b, 'control');
  await joined(b, 'control', 2);
  await send(b, 'control', { marker: 'rejoined' });
  await seen(c, 'control', 'message', 'rejoined');
  const stats = await a.frame.evaluate(() => window.events.filter((e) => e.type === 'stats'));
  check(
    'statistics are advisory RTT without invented loss or network secrets',
    stats.length > 0 &&
      stats.every(
        (e) =>
          typeof e.rttMs === 'number' &&
          e.rttMs >= 0 &&
          Object.keys(e).every((k) =>
            ['type', 'sessionId', 'pubkey', 'rttMs', 'observed'].includes(k),
          ),
      ),
  );
  const previousStats = new Map();
  check(
    'statistics stay below one emission per second per peer',
    stats.every((e) => {
      const key = e.sessionId + ':' + e.pubkey,
        previous = previousStats.get(key);
      previousStats.set(key, e.observed);
      // Permit event-loop/IPC delivery jitter while checking the one-second cadence.
      return previous === undefined || e.observed - previous >= 950;
    }),
  );
  const settings = await a.page.context().newPage();
  await settings.goto(a.page.url());
  await settings.evaluate(() => localStorage.setItem('napplet:multiplayer-permission:v1', 'block'));
  await a.frame.waitForFunction(() =>
    window.events.some((e) => e.type === 'closed' && e.sessionId === window.control),
  );
  const denied = await open(a, 'denied').then(
    () => '',
    (e) => e.message,
  );
  check(
    'revocation tears down sessions and denies new work',
    denied.toLowerCase().includes('denied'),
  );
  await settings.close();
};
