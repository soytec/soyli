import { describe, expect, test } from 'bun:test';
import { CoordinatedAudio, type AudioMediaClient } from '../docs/examples/coordinated-audio';

class Context {
  state = 'running';
  destination = {};
  onstatechange: null | (() => void) = null;
  gain = { gain: { value: 1 }, connect() {} };
  createGain() {
    return this.gain;
  }
  async resume() {
    this.state = 'running';
    this.onstatechange?.();
  }
  async suspend() {
    this.state = 'suspended';
    this.onstatechange?.();
  }
  async close() {
    this.state = 'closed';
  }
}
function fixture() {
  let complete!: (value: { sessionId?: string; owner?: string; error?: string }) => void;
  let command!: (action: string, value?: number | boolean) => void;
  const states: unknown[] = [],
    destroyed: string[] = [];
  let closed = false,
    requested = 0;
  const api: AudioMediaClient = {
    createSession: () => {
      requested++;
      return new Promise((resolve) => {
        complete = resolve;
      });
    },
    onCommand: (_id, fn) => {
      command = fn;
      return {
        close() {
          closed = true;
        },
      };
    },
    reportState: (_id, state) => {
      states.push(state);
    },
    destroySession: (id) => {
      destroyed.push(id);
    },
  };
  return {
    api,
    states,
    destroyed,
    complete: (v: Parameters<typeof complete>[0]) => complete(v),
    command: (a: string, v?: number) => command(a, v),
    get closed() {
      return closed;
    },
    get requested() {
      return requested;
    },
  };
}
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
describe('optional coordinated Web Audio example', () => {
  test('no output before grant; host pause persists across gestures; volume and teardown control every bus', async () => {
    const original = globalThis.AudioContext;
    globalThis.AudioContext = Context as unknown as typeof AudioContext;
    const f = fixture(),
      audio = new CoordinatedAudio(f.api, 'Game');
    try {
      expect(audio.activate()).toBe(false);
      expect(audio.output!.gain.value).toBe(0);
      audio.activate();
      expect(f.requested).toBe(1);
      f.complete({ sessionId: 'canonical', owner: 'napplet' });
      await tick();
      expect(audio.audible).toBe(true);
      expect(audio.output!.gain.value).toBe(1);
      f.command('volume', 0.25);
      expect(audio.output!.gain.value).toBe(0.25);
      f.command('pause');
      expect(audio.output!.gain.value).toBe(0);
      await tick();
      expect(audio.context!.state).toBe('suspended');
      expect(audio.activate()).toBe(false);
      expect(audio.context!.state).toBe('suspended');
      f.command('play');
      await tick();
      expect(audio.output!.gain.value).toBe(0.25);
      audio.setMuted(true);
      expect(audio.output!.gain.value).toBe(0);
      audio.setMuted(false);
      expect(audio.output!.gain.value).toBe(0.25);
      f.command('stop');
      await tick();
      expect(audio.activate()).toBe(false);
      expect(f.states.at(-1)).toEqual({ status: 'stopped', volume: 0.25 });
      f.command('play');
      await tick();
      expect(audio.audible).toBe(true);
      audio.dispose();
      expect(audio.output!.gain.value).toBe(0);
      expect(f.destroyed).toEqual(['canonical']);
      expect(f.closed).toBe(true);
      expect(audio.activate()).toBe(false);
    } finally {
      audio.dispose();
      globalThis.AudioContext = original;
    }
  });
  test('missing/denied MEDIA stays silent and a late grant is released after disposal', async () => {
    const original = globalThis.AudioContext;
    globalThis.AudioContext = Context as unknown as typeof AudioContext;
    try {
      const absent = new CoordinatedAudio(undefined, 'Game');
      expect(absent.activate()).toBe(false);
      expect(absent.context).toBeUndefined();
      const f = fixture(),
        denied = new CoordinatedAudio(f.api, 'Game');
      denied.activate();
      f.complete({ error: 'denied' });
      await tick();
      expect(denied.output!.gain.value).toBe(0);
      expect(denied.context!.state).toBe('closed');
      expect(denied.activate()).toBe(false);
      expect(f.requested).toBe(1);
      const g = fixture(),
        late = new CoordinatedAudio(g.api, 'Game');
      late.activate();
      late.dispose();
      g.complete({ sessionId: 'late', owner: 'napplet' });
      await tick();
      expect(g.destroyed).toEqual(['late']);
      expect(g.states).toEqual([]);
      const h = fixture(),
        unsupported = new CoordinatedAudio(h.api, 'Game');
      unsupported.activate();
      h.complete({ sessionId: 'wrong-owner', owner: 'shell' });
      await tick();
      expect(h.destroyed).toEqual(['wrong-owner']);
      expect(unsupported.context!.state).toBe('closed');
      expect(unsupported.output!.gain.value).toBe(0);
    } finally {
      globalThis.AudioContext = original;
    }
  });
});
