import { useId, useState, useSyncExternalStore } from 'react';
import {
  multiplayerPermission,
  saveMultiplayerPermission,
  subscribeMultiplayerPermission,
  type MultiplayerPermission,
} from './multiplayer-permission';

export function MultiplayerSettings() {
  const id = useId();
  const permission = useSyncExternalStore(
    subscribeMultiplayerPermission,
    multiplayerPermission,
    () => 'ask' as const,
  );
  const [temporary, setTemporary] = useState(false);
  return (
    <fieldset className="multiplayer-settings">
      <style>{`
        .multiplayer-settings{border:0;padding:0;margin:24px 0;color:inherit;font:inherit;max-width:520px}
        .multiplayer-settings legend{font-weight:600;font-size:18px}
        .multiplayer-settings p{font-size:14px;line-height:1.5;margin:10px 0}
        .multiplayer-settings label{display:grid;gap:8px;font-size:14px}
        .multiplayer-settings select{font:inherit;color:inherit;background:transparent;border:1px solid var(--border, #909681);border-radius:6px;padding:10px;width:100%;min-height:44px}
        .multiplayer-settings select:focus-visible{outline:2px solid var(--mint, #397c65);outline-offset:3px}
      `}</style>
      <legend>Multiplayer connections</legend>
      <p>
        Allow napplets to connect to other players. Direct connections can share your IP address
        with peers. This choice applies to all napplets in this browser on this site.
      </p>
      <div>
        <label htmlFor={id}>Multiplayer permission</label>
        <select
          id={id}
          value={permission}
          onChange={(event) =>
            setTemporary(!saveMultiplayerPermission(event.target.value as MultiplayerPermission))
          }
        >
          <option value="ask">Ask me</option>
          <option value="allow">Allow</option>
          <option value="block">Block</option>
        </select>
      </div>
      <p>Changes apply immediately. Choosing Ask me or Block closes active peer connections.</p>
      {temporary && <p role="status">Browser storage is unavailable. Saved for this page only.</p>}
    </fieldset>
  );
}
