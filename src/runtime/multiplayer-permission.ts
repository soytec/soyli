export type MultiplayerPermission = 'ask' | 'allow' | 'block';
const key = 'napplet:multiplayer-permission:v1';
const changed = 'napplet:multiplayer-permission-changed';
// Storage may be unavailable in a private/restricted browser. Keep an explicit
// choice for this page's lifetime, without claiming it survives a reload.
let temporary: MultiplayerPermission | undefined;

export function multiplayerPermission(): MultiplayerPermission {
  if (temporary !== undefined) return temporary;
  try {
    const value = localStorage.getItem(key);
    return value === 'allow' || value === 'block' ? value : 'ask';
  } catch {
    return 'ask';
  }
}

/** Host UI only. Never expose this setting through napplet.storage or messages. */
export function saveMultiplayerPermission(value: MultiplayerPermission) {
  let persisted = true;
  try {
    if (value === 'ask') localStorage.removeItem(key);
    else localStorage.setItem(key, value);
    temporary = undefined;
  } catch {
    temporary = value;
    persisted = false;
  }
  window.dispatchEvent(new Event(changed));
  return persisted;
}

export function subscribeMultiplayerPermission(listener: () => void) {
  const storage = (event: StorageEvent) => {
    if (event.key !== null && event.key !== key) return;
    temporary = undefined;
    listener();
  };
  window.addEventListener(changed, listener);
  window.addEventListener('storage', storage);
  return () => {
    window.removeEventListener(changed, listener);
    window.removeEventListener('storage', storage);
  };
}
