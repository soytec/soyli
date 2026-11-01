import { expect, test } from 'bun:test';

// A separate process keeps Playwright's platform/registry cache out of other tests.
// Exercise the shipped registry: a guessed executable path alone does not prove
// that Playwright actually publishes a browser for this OS.
async function inspect(platform: string, kernel: string, host: string, arch = 'x64') {
  const child = Bun.spawn(
    [
      process.execPath,
      '--no-env-file',
      '-e',
      `
      import { mock } from 'bun:test';
      import * as os from 'node:os';
      import { createRequire } from 'node:module';
      mock.module('node:os', () => ({ ...os, release: () => ${JSON.stringify(kernel)} }));
      Object.defineProperty(process, 'platform', { value: ${JSON.stringify(platform)} });
      Object.defineProperty(process, 'arch', { value: ${JSON.stringify(arch)} });
      const { playwrightDirectory } = await import('../distribution.ts');
      const directory = playwrightDirectory();
      const require = createRequire(directory + '/index.js');
      const registry = require('./lib/coreBundle.js').registry.registry;
      const executables = ['chromium-headless-shell', 'chromium', 'ffmpeg'].map(name => {
        const executable = registry.findExecutable(name);
        return { name, urls: executable.downloadURLs, path: executable.executablePath() };
      });
      console.log(JSON.stringify({ version: require('./package.json').version, executables }));
    `,
    ],
    {
      cwd: import.meta.dir,
      env: { PATH: process.env.PATH, PLAYWRIGHT_HOST_PLATFORM_OVERRIDE: host },
      stdout: 'pipe',
      stderr: 'pipe',
    },
  );
  const [code, output, error] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  expect(code, error).toBe(0);
  return JSON.parse(output);
}

test('Monterey and Ventura select downloadable matching browser, headed capture and encoder', async () => {
  for (const [kernel, host] of [
    ['21.6.0', 'mac12'],
    ['22.6.0', 'mac13'],
  ]) {
    for (const arch of ['x64', 'arm64']) {
      const result = await inspect(
        'darwin',
        kernel!,
        host! + (arch === 'arm64' ? '-arm64' : ''),
        arch,
      );
      for (const executable of result.executables) {
        expect(executable.urls.length, `${host}: ${executable.name}`).toBeGreaterThan(0);
        expect(executable.path).toBeTruthy();
      }
      expect(result.version).toBe('1.61.1');
    }
  }
});

test('current Macs and Linux keep the current Playwright browser', async () => {
  for (const [platform, kernel, host] of [
    ['darwin', '23.6.0', 'mac14'],
    ['linux', '6.8.0', 'ubuntu24.04-x64'],
  ]) {
    const result = await inspect(platform!, kernel!, host!);
    expect(result.version).toBe('1.63.0');
    for (const executable of result.executables) expect(executable.urls.length).toBeGreaterThan(0);
  }
});
