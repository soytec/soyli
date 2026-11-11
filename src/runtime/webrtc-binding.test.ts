import { test, expect } from 'bun:test';
import { runInNewContext } from 'node:vm';

async function fixture() {
  const sent: any[] = [];
  let receive!: (message: unknown) => void;
  class Port {
    onmessage?: (e: MessageEvent) => void;
    postMessage(m: unknown) {
      sent.push(m);
    }
  }
  class Channel {
    port1 = new Port();
    port2 = new Port();
    constructor() {
      receive = (m) => this.port1.onmessage?.(new MessageEvent('message', { data: m }));
    }
  }
  const listeners: ((e: unknown) => void)[] = [];
  const window: any = { parent: { postMessage(m: unknown) { sent.push(m); } },
    addEventListener(_type: string, handler: (e: unknown) => void) { listeners.push(handler); } };
  receive = message => { for (const listener of listeners) listener({source: window.parent, data: message}); };
  const shim = await Bun.file(
    Bun.resolveSync('@napplet/shim/prelude.global', import.meta.dir),
  ).text();
  runInNewContext(`${shim}\nNappletShimPrelude.install({domains:['webrtc']});`, {
    window,
    MessageChannel: Channel,
    MessagePort: Port,
    MessageEvent,
    TextEncoder,
    TextDecoder,
    crypto,
    setTimeout: (fn: () => void) => setTimeout(fn, 30),
    clearTimeout,
  });
  return { api: window.napplet.webrtc, sent, reply: receive };
}
test('actual injected binding separates JSON/bytes and never automatically resends a rejected or timed-out binary request', async () => {
  const f = await fixture(),
    events: any[] = [];
  f.api.onEvent((e: unknown) => events.push(e));
  const open = f.api.open({
    scope: { type: 'room', room: 'fixture' },
    ordered: false,
    maxRetransmits: 0,
  });
  f.reply({
    type: 'webrtc.open.result',
    id: f.sent[0].id,
    session: { id: 's', ordered: false, maxRetransmits: 0, maxPayloadBytes: 16384 },
  });
  expect((await open).session.ordered).toBe(false);
  const json = f.api.send('s', 'AA==');
  f.reply({ type: 'webrtc.send.result', id: f.sent[1].id });
  await json;
  const bytes = f.api.sendBytes('s', 'AA==');
  expect(f.sent[2]).toMatchObject({ type: 'webrtc.sendBytes', bytes: 'AA==' });
  f.reply({ type: 'webrtc.sendBytes.result', id: f.sent[2].id });
  await bytes;
  f.reply({
    type: 'webrtc.event',
    event: { type: 'message', sessionId: 's', from: 'guest', payload: 'AA==' },
  });
  f.reply({
    type: 'webrtc.event',
    event: { type: 'bytes', sessionId: 's', from: 'guest', bytes: 'AA==' },
  });
  expect(events.map((e) => e.type)).toEqual(['message', 'bytes']);
  const unsupported = f.api.sendBytes('s', 'AA==');
  f.reply({ type: 'webrtc.sendBytes.result', id: f.sent[3].id, error: 'unsupported' });
  await expect(unsupported).rejects.toThrow('unsupported');
  await expect(f.api.sendBytes('s', 'AA==')).rejects.toThrow('timed out');
  expect(f.sent.map((m) => m.type)).toEqual([
    'webrtc.open',
    'webrtc.send',
    'webrtc.sendBytes',
    'webrtc.sendBytes',
    'webrtc.sendBytes',
  ]);
});
