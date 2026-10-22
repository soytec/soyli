import { dirname, join } from 'node:path';
import { realpathSync } from 'node:fs';
import { createRequire } from 'node:module';
import { release as kernelRelease } from 'node:os';
import { AccountError } from '../packages/identity/src/signer';
import release from '../distribution/version.json';

declare const NAPPLET_STANDALONE: boolean | undefined;
declare const NAPPLET_CLI_VERSION: string | undefined;
declare const NAPPLET_DISTRIBUTION: string | undefined;
export const standalone = typeof NAPPLET_STANDALONE !== 'undefined' && NAPPLET_STANDALONE;
/** Package manager that owns this binary (e.g. "nix"); it, not soyli update, upgrades it. */
export const packagedBy =
  typeof NAPPLET_DISTRIBUTION === 'undefined' || !NAPPLET_DISTRIBUTION
    ? undefined
    : NAPPLET_DISTRIBUTION;
export const version =
  typeof NAPPLET_CLI_VERSION === 'undefined' ? `${release.version}-dev` : NAPPLET_CLI_VERSION;
// A package wrapper (nix/package.nix) may prepend libraries for soyli's own loader;
// the loader has already read them, so hand child processes the caller's value.
// Bun.spawn without `env` uses the startup environment: pass hostEnvironment().
if (standalone && process.env.SOYLI_HOST_LD_LIBRARY_PATH !== undefined) {
  if (process.env.SOYLI_HOST_LD_LIBRARY_PATH)
    process.env.LD_LIBRARY_PATH = process.env.SOYLI_HOST_LD_LIBRARY_PATH;
  else delete process.env.LD_LIBRARY_PATH;
  delete process.env.SOYLI_HOST_LD_LIBRARY_PATH;
}
/** Environment for user-facing child programs (openers, git, coturn). */
export const hostEnvironment = () => ({ ...process.env });
export const commandName = standalone ? 'soyli' : 'bun run soyli';

export function browserProfile(platform = process.platform, kernel = kernelRelease()) {
  if (platform === 'darwin') {
    // Darwin 21 = Monterey, 22 = Ventura. The current Playwright registry has
    // no Chromium downloads for either; use a matching driver, not just an old binary.
    const major = Number(kernel.split('.')[0]);
    if (!Number.isInteger(major) || major < 21)
      throw new AccountError(
        'BROWSER_OS',
        'soyLI browser checks and captures require macOS 12 or newer. Project editing does not require this browser.',
      );
    if (major < 23) return 'mac-compat';
  }
  return 'current';
}

export function playwrightDirectory(profile: 'current' | 'mac-compat' = browserProfile()) {
  const name = profile === 'mac-compat' ? 'playwright-core-mac-compat' : 'playwright-core';
  if (standalone) return join(dirname(realpathSync(process.execPath)), 'lib', name);
  if (profile === 'mac-compat')
    return dirname(Bun.resolveSync(`${name}/package.json`, import.meta.dir));
  // Follow direct dependencies: test -> playwright -> playwright-core. Resolving
  // core from the test package can find a hoisted compatibility alias instead,
  // as happens in Bun 1.3.8's installation layout on the deployment server.
  const testRequire = createRequire(
    Bun.resolveSync('@playwright/test/package.json', import.meta.dir),
  );
  const playwrightRequire = createRequire(
    realpathSync(testRequire.resolve('playwright/package.json')),
  );
  return dirname(playwrightRequire.resolve('playwright-core/package.json'));
}
