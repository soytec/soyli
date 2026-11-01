import { expect, test } from 'bun:test';
import { SHELL_PRELUDE } from './prelude';

test('SHELL supports reflects injected domains immediately, never the environment hint', async () => {
  let receive: (event: any) => void = () => {};
  const sent: unknown[] = [];
  const parent = { postMessage: (message: unknown) => sent.push(message) };
  const window: any = {
    parent,
    napplet: { identity: {}, storage: {}, absent: null },
    addEventListener: (_: string, listener: typeof receive) => {
      receive = listener;
    },
  };
  new Function('window', SHELL_PRELUDE)(window);
  const shell = window.napplet.shell;
  expect(shell.supports('identity')).toBe(true);
  expect(shell.supports('storage')).toBe(true);
  expect(shell.supports('shell')).toBe(true);
  for (const domain of ['media', 'absent', '__proto__', 'constructor', 'toString'])
    expect(shell.supports(domain)).toBe(false);
  expect(sent).toEqual([{ type: 'shell.ready' }]);
  const environments: unknown[] = [];
  shell.onReady((value: unknown) => environments.push(value));
  receive({ source: {}, data: { type: 'shell.init', capabilities: { domains: ['media'] } } });
  expect(environments).toEqual([]);
  const init = { type: 'shell.init', capabilities: { domains: ['media'] }, services: [] };
  receive({ source: parent, data: init });
  expect(await shell.ready()).toBe(init);
  expect(shell.supports('identity')).toBe(true);
  expect(shell.supports('media')).toBe(false);
  receive({ source: parent, data: { type: 'shell.init', capabilities: { domains: [] } } });
  expect(environments).toEqual([init]);
});
