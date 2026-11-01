/** Optional Web Audio coordinated through the pinned NAP-MEDIA contract.
 * Pass the SDK's `media` wrapper only when window.napplet?.media exists.
 * All audible branches MUST connect to output, never directly to destination. */
export interface AudioMediaClient {
  createSession(options: {
    owner: 'napplet';
    metadata: { title: string; mediaType: 'audio' };
    capabilities: ('play' | 'pause' | 'stop' | 'volume')[];
  }): Promise<{ owner?: string; sessionId?: string; error?: string }>;
  onCommand(
    id: string,
    handler: (action: string, value?: number | boolean) => void,
  ): { close(): void };
  reportState(
    id: string,
    state: { status: 'playing' | 'paused' | 'stopped'; volume: number },
  ): void;
  destroySession(id: string): void;
}

export class CoordinatedAudio {
  context?: AudioContext;
  output?: GainNode;
  private session = '';
  private pending = false;
  private blocked = false;
  private disposed = false;
  private muted = false;
  private volume = 1;
  private stopped = false;
  private listener?: { close(): void };
  constructor(
    private media: AudioMediaClient | undefined,
    private title: string,
    private options: { createContext?: () => AudioContext; onChange?: () => void } = {},
  ) {}

  /** Call from a user gesture. Ordinary game ticks cannot reverse a host pause. */
  activate(): boolean {
    if (!this.media || this.disposed || this.blocked) return false;
    try {
      if (!this.context) {
        this.context = this.options.createContext?.() ?? new AudioContext();
        this.output = this.context.createGain();
        this.output.gain.value = 0; // No output before the shell grants a session.
        this.output.connect(this.context.destination);
        this.context.onstatechange = () => this.report();
      }
      if (!this.session && !this.pending) {
        this.pending = true;
        void this.register();
      }
      if (this.context.state === 'suspended') void this.resume();
      return this.audible;
    } catch {
      this.dispose();
      return false;
    }
  }

  get audible(): boolean {
    return (
      !!this.session &&
      !this.disposed &&
      !this.blocked &&
      !this.muted &&
      this.context?.state === 'running'
    );
  }
  setMuted(value: boolean): void {
    this.muted = value;
    this.applyGain();
    this.report();
  }
  private applyGain(): void {
    if (this.output) this.output.gain.value = this.audible ? this.volume : 0;
  }
  private report(): void {
    this.applyGain();
    this.options.onChange?.();
    if (!this.session || this.disposed) return;
    try {
      this.media!.reportState(this.session, {
        status: this.audible ? 'playing' : this.stopped ? 'stopped' : 'paused',
        volume: this.muted ? 0 : this.volume,
      });
    } catch {
      this.dispose();
    }
  }
  private async resume(): Promise<void> {
    try {
      await this.context?.resume();
      this.report();
    } catch {
      this.applyGain();
    }
  }
  private async register(): Promise<void> {
    try {
      const result = await this.media!.createSession({
        owner: 'napplet',
        metadata: { title: this.title, mediaType: 'audio' },
        capabilities: ['play', 'pause', 'stop', 'volume'],
      });
      if (this.disposed) {
        if (result.sessionId) this.media!.destroySession(result.sessionId);
        return;
      }
      if (result.error || !result.sessionId || result.owner !== 'napplet') {
        if (result.sessionId) this.media!.destroySession(result.sessionId);
        this.dispose();
        return;
      }
      this.session = result.sessionId;
      this.listener = this.media!.onCommand(this.session, (action, value) => {
        if (this.disposed) return;
        if (action === 'pause' || action === 'stop') {
          this.blocked = true;
          this.stopped = action === 'stop';
          this.applyGain(); // Silence immediately, even while resume/suspend settles.
          void this.context
            ?.suspend()
            .then(() => this.report())
            .catch(() => {});
        } else if (action === 'play') {
          this.blocked = false;
          this.stopped = false;
          void this.resume();
        } else if (action === 'volume' && typeof value === 'number' && Number.isFinite(value)) {
          this.volume = Math.max(0, Math.min(1, value));
        }
        this.report();
      });
      this.report();
    } catch {
      this.dispose();
    } finally {
      this.pending = false;
    }
  }
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.applyGain();
    try {
      this.listener?.close();
    } catch {
      /* Host already gone. */
    }
    if (this.context) {
      this.context.onstatechange = null;
      void this.context.close().catch(() => {});
    }
    if (this.session) {
      try {
        this.media!.destroySession(this.session);
      } catch {
        /* Host already gone. */
      }
    }
    this.session = '';
  }
}
