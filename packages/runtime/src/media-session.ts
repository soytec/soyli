import { resourceUrl } from '../../client/src/bytes';
import { z } from 'zod';

const metadataSchema = z.object({
  title: z.string().max(200).optional(),
  artist: z.string().max(200).optional(),
  album: z.string().max(200).optional(),
  mediaType: z.enum(['audio', 'video']).optional(),
  duration: z.number().nonnegative().finite().optional(),
  artwork: z.unknown().optional(),
});
const mediaAction = z.enum(['play', 'pause', 'stop', 'next', 'prev', 'seek', 'volume']);
const capabilitiesSchema = z.array(mediaAction).max(7);
const stateSchema = z.object({
  status: z.enum(['playing', 'paused', 'stopped', 'buffering']),
  position: z.number().finite().nonnegative().optional(),
  duration: z.number().finite().nonnegative().optional(),
  volume: z.number().finite().min(0).max(1).optional(),
});
const createSchema = z.object({
  id: z.string().min(1).max(128),
  owner: z.enum(['shell', 'napplet']),
  source: z
    .object({ url: z.string().max(4096).optional(), mimeType: z.string().max(100).optional() })
    .passthrough()
    .optional(),
  metadata: metadataSchema.optional(),
  autoplay: z.boolean().optional(),
  live: z.boolean().optional(),
  capabilities: capabilitiesSchema.optional(),
});
const actions = ['play', 'pause', 'stop', 'volume'];
type Status = 'playing' | 'paused' | 'stopped' | 'buffering';
export type AudioView = {
  id: string;
  title: string;
  status: Status;
  volume: number;
  actions: string[];
  error?: string;
};
type SessionBase = AudioView & {
  cleanup: () => void;
  pause: () => void;
};
type ShellSession = SessionBase & {
  owner: 'shell';
  audio: HTMLAudioElement;
  source: string;
  live: boolean;
  revision: number;
  cancelPrompt?: () => void;
};
type NappletSession = SessionBase & { owner: 'napplet' };
type Session = ShellSession | NappletSession;
let focused: { pause: () => void } | undefined;

/** NAP-MEDIA sessions. Playback state belongs to its declared owner; IDs are frame/account scoped. */
export class NappletMedia {
  private sessions = new Map<string, Session>();
  private pending = new Set<string>();
  private alive = true;
  private lifetime = new AbortController();
  private listeners = new Set<() => void>();
  private snapshot: AudioView[] = [];
  constructor(
    private options: {
      manifest: string;
      send: (message: Record<string, unknown>) => void;
      activate: (label: string, play: () => void) => (() => void) | void;
      audio?: () => HTMLAudioElement;
      fetch?: typeof fetch;
    },
  ) {}
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
  getSnapshot = () => this.snapshot;
  private changed() {
    this.snapshot = [...this.sessions.values()].map(
      ({ id, title, status, volume, actions, error }) => ({
        id,
        title,
        status,
        volume,
        actions: [...actions],
        error,
      }),
    );
    this.listeners.forEach((fn) => fn());
  }
  private sendState(session: ShellSession) {
    if (!this.alive || !this.sessions.has(session.id)) return;
    session.volume = session.audio.volume;
    this.options.send({
      type: 'media.state',
      sessionId: session.id,
      status: session.status,
      position: Number.isFinite(session.audio.currentTime) ? session.audio.currentTime : 0,
      ...(!session.live && Number.isFinite(session.audio.duration)
        ? { duration: session.audio.duration }
        : {}),
      volume: session.volume,
    });
    this.changed();
  }
  private controls(session: Session) {
    this.options.send({
      type: 'media.controls',
      sessionId: session.id,
      controls: actions.filter((action) => session.actions.includes(action)),
    });
  }
  private focus(session: Session) {
    if (focused && focused !== session) focused.pause();
    focused = session;
  }
  private async create(message: Record<string, unknown>) {
    const id = message.id;
    if (typeof id !== 'string' || !id || id.length > 128 || this.pending.has(id)) return;
    const result = (value: Record<string, unknown>) => {
      if (this.alive) this.options.send({ type: 'media.session.create.result', id, ...value });
    };
    if (this.sessions.size + this.pending.size >= 4) {
      result({ error: 'session limit exceeded' });
      return;
    }
    this.pending.add(id);
    try {
      const input = createSchema.parse(message);
      if (input.owner === 'napplet') {
        // Source/context are advisory. Never construct a media element or fetch
        // a source on behalf of a napplet-owned session.
        const session: NappletSession = {
          owner: 'napplet',
          id: crypto.randomUUID(),
          title: input.metadata?.title || 'Audio',
          status: 'stopped',
          volume: 1,
          actions: [...new Set(input.capabilities ?? [])],
          cleanup: () => {},
          pause: () =>
            this.command(session.id, session.actions.includes('pause') ? 'pause' : 'stop'),
        };
        this.sessions.set(session.id, session);
        result({ sessionId: session.id, owner: 'napplet' });
        setTimeout(() => {
          if (!this.alive || !this.sessions.has(session.id)) return;
          this.controls(session);
          if (input.autoplay) this.command(session.id, 'play');
        }, 0);
        this.changed();
        return;
      }
      if (!input.source) throw new Error('missing source');
      if (!input.source.url) throw new Error('unsupported source');
      const url = resourceUrl(input.source.url);
      if (url.protocol !== 'https:' || url.username || url.password || url.hash)
        throw new Error('source blocked');
      if (
        input.metadata?.mediaType === 'video' ||
        (input.source.mimeType && !input.source.mimeType.startsWith('audio/'))
      )
        throw new Error('unsupported source');
      const audio = (this.options.audio ?? (() => new Audio()))();
      audio.preload = 'none';
      audio.src = url.href;
      const session: ShellSession = {
        owner: 'shell',
        id: crypto.randomUUID(),
        title: input.metadata?.title || 'Audio',
        audio,
        source: url.href,
        live: !!input.live,
        status: 'stopped',
        volume: audio.volume,
        actions: [...actions],
        revision: 0,
        cleanup: () => {},
        pause: () => this.command(session.id, 'pause'),
      };
      const events = new AbortController();
      const state = (status: Status) => {
        if (!this.sessions.has(session.id)) return;
        session.status = status;
        if (status === 'playing') session.error = undefined;
        this.sendState(session);
      };
      audio.addEventListener('playing', () => state('playing'), { signal: events.signal });
      audio.addEventListener(
        'pause',
        () => {
          if (session.status !== 'stopped') state('paused');
        },
        { signal: events.signal },
      );
      audio.addEventListener(
        'waiting',
        () => {
          if (!audio.paused) state('buffering');
        },
        { signal: events.signal },
      );
      audio.addEventListener('ended', () => state('stopped'), { signal: events.signal });
      audio.addEventListener(
        'error',
        () => {
          session.error = 'Audio unavailable. Check the stream or retry.';
          state('stopped');
        },
        { signal: events.signal },
      );
      audio.addEventListener('volumechange', () => this.sendState(session), {
        signal: events.signal,
      });
      let lastTime = 0;
      audio.addEventListener(
        'timeupdate',
        () => {
          if (Date.now() - lastTime > 500) {
            lastTime = Date.now();
            this.sendState(session);
          }
        },
        { signal: events.signal },
      );
      session.cleanup = () => {
        session.cancelPrompt?.();
        events.abort();
        audio.pause();
        audio.removeAttribute('src');
        audio.load();
      };
      this.sessions.set(session.id, session);
      result({ sessionId: session.id, owner: 'shell' });
      // Let the correlated create promise attach listeners before the initial snapshots.
      setTimeout(() => {
        if (!this.alive || !this.sessions.has(session.id)) return;
        this.options.send({ type: 'media.capabilities', sessionId: session.id, actions });
        this.controls(session);
        this.sendState(session);
        if (input.autoplay) void this.play(session);
      }, 0);
      this.changed();
    } catch (error) {
      result({
        error:
          error instanceof z.ZodError
            ? 'invalid media request'
            : error instanceof Error
              ? error.message
              : 'media unavailable',
      });
    } finally {
      this.pending.delete(id);
    }
  }
  private async play(session: ShellSession, activated = false) {
    if (!this.alive || !this.sessions.has(session.id)) return;
    session.cancelPrompt?.();
    session.cancelPrompt = undefined;
    const revision = ++session.revision;
    this.focus(session);
    session.error = undefined;
    session.status = 'buffering';
    if (!session.audio.getAttribute('src') || session.audio.error) {
      session.audio.src = session.source;
      session.audio.load();
    }
    this.sendState(session);
    try {
      await session.audio.play();
    } catch (error) {
      if (!this.alive || !this.sessions.has(session.id) || session.revision !== revision) return;
      session.status = 'paused';
      if (error instanceof Error && error.name === 'NotAllowedError') {
        session.error = 'Press Play audio to allow sound.';
        if (!activated) {
          const cancel = this.options.activate(session.title, () => {
            if (session.revision === revision) void this.play(session, true);
          });
          if (typeof cancel === 'function') session.cancelPrompt = cancel;
        }
      } else if (!(error instanceof Error && error.name === 'AbortError')) {
        session.status = 'stopped';
        session.error = 'Audio unavailable. Check the stream or retry.';
      }
      this.sendState(session);
    }
  }
  command = (id: string, action: string, value?: unknown) => {
    const session = this.sessions.get(id);
    if (!session || !this.alive) return;
    if (!session.actions.includes(action)) return;
    if (
      action === 'volume' &&
      (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 1)
    )
      return;
    if (action === 'seek' && (typeof value !== 'number' || !Number.isFinite(value) || value < 0))
      return;
    if (session.owner === 'napplet') {
      this.options.send({
        type: 'media.command',
        sessionId: id,
        action,
        ...(['volume', 'seek'].includes(action) ? { value } : {}),
      });
      // Commands are requests. Only the playback owner may report the new state.
      return;
    }
    if (action === 'play') {
      void this.play(session);
      return;
    }
    if (action === 'volume') {
      if (typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1)
        session.audio.volume = value;
      return;
    }
    if (action !== 'pause' && action !== 'stop') return;
    session.cancelPrompt?.();
    session.cancelPrompt = undefined;
    session.revision++;
    session.status = action === 'stop' ? 'stopped' : 'paused';
    session.audio.pause();
    if (action === 'stop') {
      session.audio.removeAttribute('src');
      session.audio.load();
    }
    if (focused === session) focused = undefined;
    this.sendState(session);
  };
  handle(message: Record<string, unknown>) {
    if (!this.alive) return;
    if (message.type === 'media.session.create') {
      void this.create(message);
      return;
    }
    const session = this.sessions.get(String(message.sessionId));
    if (!session) return;
    if (message.type === 'media.command' && session.owner === 'shell')
      this.command(session.id, String(message.action), message.value);
    if (message.type === 'media.state' && session.owner === 'napplet') {
      const state = stateSchema.safeParse(message);
      if (!state.success) return;
      const playing = (status: Status) => status === 'playing' || status === 'buffering';
      if (playing(state.data.status) && !playing(session.status)) this.focus(session);
      if (!playing(state.data.status) && focused === session) focused = undefined;
      const changed =
        session.status !== state.data.status ||
        (state.data.volume !== undefined && session.volume !== state.data.volume);
      session.status = state.data.status;
      if (state.data.volume !== undefined) session.volume = state.data.volume;
      if (changed) this.changed();
    }
    if (message.type === 'media.capabilities' && session.owner === 'napplet') {
      const capabilities = capabilitiesSchema.safeParse(message.actions);
      if (!capabilities.success) return;
      session.actions = [...new Set(capabilities.data)];
      this.controls(session);
      this.changed();
    }
    if (message.type === 'media.session.update') {
      const metadata = metadataSchema.safeParse(message.metadata);
      if (metadata.success && metadata.data.title !== undefined) {
        session.title = metadata.data.title;
        this.changed();
      }
    }
    if (message.type === 'media.session.destroy') {
      this.sessions.delete(session.id);
      if (session.owner === 'shell') session.revision++;
      session.cleanup();
      if (focused === session) focused = undefined;
      this.changed();
    }
    // Reports for shell-owned sessions and commands from a napplet to its own
    // napplet-owned session never reverse the declared ownership.
  }
  close() {
    if (!this.alive) return;
    // Account retirement can leave the iframe running. Ask cooperating owners
    // to stop before their old account endpoint is revoked.
    for (const session of this.sessions.values())
      if (session.owner === 'napplet')
        this.command(session.id, session.actions.includes('stop') ? 'stop' : 'pause');
    this.alive = false;
    this.lifetime.abort();
    for (const session of this.sessions.values()) {
      if (focused === session) focused = undefined;
      session.cleanup();
    }
    this.sessions.clear();
    this.changed();
  }
}
