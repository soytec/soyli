import { RUNTIME_DOMAINS } from './capabilities';
import { validateConfigSchema } from './config-schema';

/** NAP-SHELL supplements the pinned upstream domain shim, which does not yet provide it. */
export const SHELL_PRELUDE = `
(() => {
  let environment;
  const listeners = new Set();
  let resolveReady;
  const ready = new Promise(resolve => { resolveReady = resolve; });
  window.addEventListener('message', event => {
    if (event.source !== window.parent || event.data?.type !== 'shell.init' || environment) return;
    environment = Object.freeze(event.data);
    resolveReady(environment);
    for (const listener of listeners) { try { listener(environment); } catch {} }
    listeners.clear();
  });
  window.napplet.shell = Object.freeze({
    ready: () => ready,
    supports: domain => !!environment?.capabilities?.domains?.includes(domain),
    get services() { return environment?.services || []; },
    onReady: handler => {
      if (environment) queueMicrotask(() => handler(environment));
      else listeners.add(handler);
      return { close: () => listeners.delete(handler) };
    },
  });
  window.parent.postMessage({type: 'shell.ready'}, '*');
})();`;

/** The same pinned upstream shim and mandatory shell bootstrap in every host. */
export function nappletPrelude(shim: string, declaration?: { schema?: unknown }) {
  let schema = null;
  try {
    if (declaration?.schema !== undefined) schema = validateConfigSchema(declaration.schema);
  } catch {
    /* Host reports the declaration error. */
  }
  // The pinned shim tracks runtime registrations. Supply its missing static schema
  // snapshot before creator scripts, using the same validated, signed build metadata.
  // No additional wire messages or app-owned bootstrap are required.
  const config = `(() => {
    const api = window.napplet.config;
    const declared = ${JSON.stringify(schema)};
    window.napplet.config = Object.freeze({
      ...api,
      registerSchema: (schema, version) => api.registerSchema(structuredClone(schema), version),
      get schema() { return structuredClone(api.schema ?? declared); },
      onSchemaError: callback => {
        const unsubscribe = api.onSchemaError(callback);
        unsubscribe.close = unsubscribe;
        return unsubscribe;
      },
    });
  })();`;
  return `${shim}\nglobalThis.NappletShimPrelude.install(${JSON.stringify({ domains: RUNTIME_DOMAINS.filter((d) => d !== 'shell') })});\n${config}\n${SHELL_PRELUDE}`;
}
