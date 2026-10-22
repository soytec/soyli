import { config } from '@napplet/sdk';
import { runtimeHasDomain } from './domain-availability.js';
import settingsSchema from '../config.schema.json';

// The upstream Vite plugin embeds config.schema.json into the signed build.
// Config is optional here: the stylesheet also supplies these defaults.
// These size settings belong to the capability demo. When replacing its UI,
// change/remove them and the schema together so they don't override your design.
if (runtimeHasDomain('config')) {
  void (async () => {
    // Some hosts consume the embedded schema; others need standard registration.
    // Do not replace a schema that the host already supplied.
    if (!config.schema) {
      await config.registerSchema(settingsSchema as Parameters<typeof config.registerSchema>[0]);
    }
    const subscription = config.subscribe((values) => {
      const root = document.documentElement.style;
      const textSize = typeof values.textSize === 'number' ? values.textSize : 13;
      const controlSize = typeof values.controlSize === 'number' ? values.controlSize : 28;
      root.fontSize = `${textSize}px`;
      root.setProperty('--control-h', `${controlSize}px`);
      root.setProperty('--napplet-text-selection', values.selectText === true ? 'text' : 'none');
    });
    window.addEventListener('pagehide', () => subscription.close(), { once: true });
  })().catch(() => {
    // Optional operations may be unavailable even when a host exposes the domain.
    // Keep stylesheet defaults so this example still works in a limited host.
  });
}
