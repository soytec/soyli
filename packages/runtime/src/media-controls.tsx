import { useSyncExternalStore } from 'react';
import { Pause, Play, Square, Volume2 } from 'lucide-react';
import type { NappletMedia } from './media-session';

export function MediaControls({ media }: { media: NappletMedia }) {
  const sessions = useSyncExternalStore(media.subscribe, media.getSnapshot, media.getSnapshot);
  if (!sessions.length) return null;
  return (
    <div className="nap-media-controls">
      <style>{`.nap-media-controls{display:grid;gap:8px;color:inherit;font:13px system-ui;min-width:0;width:100%}.nap-media-session{display:flex;flex-wrap:wrap;align-items:center;gap:8px;padding:8px 0}.nap-media-label{flex:1 1 100px;min-width:0}.nap-media-label strong{display:block;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:260px}.nap-media-label small{display:block;font-size:12px;line-height:1.4;max-width:280px}.nap-media-session button{display:inline-flex;align-items:center;justify-content:center;min-width:44px;min-height:44px;border:1px solid currentColor;border-radius:8px;background:transparent;color:inherit;cursor:pointer}.nap-media-session label{display:flex;align-items:center;gap:6px;min-height:44px}.nap-media-session input{width:75px;accent-color:var(--primary, #72ac98)}.nap-media-session svg{width:17px;height:17px}`}</style>
      {sessions.map((s) => (
        <div className="nap-media-session" key={s.id}>
          <div className="nap-media-label">
            <strong>{s.title}</strong>
            <small role={s.error ? 'status' : undefined}>{s.error || s.status}</small>
          </div>
          <button
            type="button"
            aria-label={`${s.status === 'playing' || s.status === 'buffering' ? 'Pause' : 'Play'} audio: ${s.title}`}
            onClick={() =>
              media.command(
                s.id,
                s.status === 'playing' || s.status === 'buffering' ? 'pause' : 'play',
              )
            }
          >
            {s.status === 'playing' || s.status === 'buffering' ? <Pause /> : <Play />}
          </button>
          <button
            type="button"
            aria-label={`Stop audio: ${s.title}`}
            onClick={() => media.command(s.id, 'stop')}
          >
            <Square />
          </button>
          <label>
            <Volume2 />
            <input
              aria-label={`Audio volume: ${s.title}`}
              type="range"
              min="0"
              max="1"
              step="0.05"
              value={s.volume}
              onChange={(e) => media.command(s.id, 'volume', Number(e.target.value))}
            />
          </label>
        </div>
      ))}
    </div>
  );
}
