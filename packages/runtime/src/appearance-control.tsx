import { useSyncExternalStore } from 'react';
import { Monitor, Moon, Sun } from 'lucide-react';
import { appearance, type Appearance } from './appearance';

const next: Record<Appearance, Appearance> = { light: 'dark', dark: 'auto', auto: 'light' };
const names = { light: 'Light', dark: 'Dark', auto: 'Auto' };
const serverPreference = (): Appearance => 'auto';

export function AppearanceControl() {
  const mode = useSyncExternalStore(appearance.subscribe, appearance.preference, serverPreference);
  const Icon = mode === 'auto' ? Monitor : mode === 'dark' ? Moon : Sun;
  const label = `Appearance: ${names[mode]}. Switch to ${names[next[mode]]}.`;
  return (
    <button
      type="button"
      className="appearance-control"
      data-tone="gold"
      title={label}
      aria-label={label}
      onClick={() => appearance.set(next[mode])}
    >
      <Icon size={19} aria-hidden="true" />
    </button>
  );
}
