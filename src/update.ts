import { lstat, readFile, readlink, realpath } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import {
  diagnose,
  DiagnosticError,
  formatDiagnostic,
  ToolOutput,
} from '../packages/diagnostics/src';
import { packagedBy, standalone, version } from './distribution';
import installer from '../support/install.sh' with { type: 'text' };

export const releaseRepository = 'soytec/napplet-soy';
const previousReleaseRepository = 'zeSchlausKwab/napplet-soy';
// Repository IDs survive ownership transfers without an API redirect. Keep the
// update channel tied to this repository until soyLI is extracted separately.
const releaseRepositoryId = 1370998066;
export const releasesUrl = `https://github.com/${releaseRepository}/releases`;
export const stableVersion = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const platforms = ['darwin-arm64', 'darwin-x64', 'linux-arm64', 'linux-x64'];

export function compareVersions(left: string, right: string) {
  if (!stableVersion.test(left) || !stableVersion.test(right))
    throw new DiagnosticError('UPDATE_VERSION', 'Expected a stable major.minor.patch version.');
  const a = left.split('.').map(BigInt),
    b = right.split('.').map(BigInt);
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] > b[i] ? 1 : -1;
  return 0;
}

function releaseEndpoint() {
  // Loopback override exercises the real entrypoint without contacting GitHub in tests.
  const override = process.env.SOYLI_RELEASE_API;
  if (!override)
    return `https://api.github.com/repositories/${releaseRepositoryId}/releases/latest`;
  const url = new URL(override);
  if (
    url.protocol !== 'http:' ||
    !['127.0.0.1', '[::1]', 'localhost'].includes(url.hostname) ||
    url.username ||
    url.password
  )
    throw new DiagnosticError(
      'UPDATE_SOURCE',
      'SOYLI_RELEASE_API is restricted to loopback test servers.',
    );
  return url.href;
}

export function parseRelease(data: unknown, platform = `${process.platform}-${process.arch}`) {
  if (!platforms.includes(platform))
    throw new DiagnosticError(
      'UPDATE_PLATFORM',
      'soyLI releases support macOS and glibc Linux on ARM64 or x86-64.',
    );
  const release = data as {
    tag_name?: unknown;
    draft?: unknown;
    prerelease?: unknown;
    assets?: unknown;
    html_url?: unknown;
  } | null;
  const latest =
    typeof release?.tag_name === 'string' ? release.tag_name.replace(/^soyli-v/, '') : '';
  if (
    !release ||
    release.draft !== false ||
    release.prerelease !== false ||
    release.tag_name !== `soyli-v${latest}` ||
    !stableVersion.test(latest)
  )
    throw new DiagnosticError('UPDATE_RELEASE', 'GitHub did not return a stable soyLI release.');
  const names = [`soyli-${platform}.tar.gz`, `soyli-${platform}.tar.gz.sha256`];
  if (
    !Array.isArray(release.assets) ||
    names.some(
      (name) =>
        !(release.assets as { name?: string; state?: string; size?: number }[]).some(
          (asset) =>
            asset?.name === name &&
            asset.state === 'uploaded' &&
            typeof asset.size === 'number' &&
            asset.size > 0,
        ),
    )
  )
    throw new DiagnosticError(
      'UPDATE_ASSETS',
      `Release ${latest} is missing the archive or checksum for ${platform}.`,
    );
  const url = `${releasesUrl}/tag/soyli-v${latest}`;
  const previousUrl = `https://github.com/${previousReleaseRepository}/releases/tag/soyli-v${latest}`;
  // Display the pre-transfer location while it is still canonical. Never use
  // arbitrary metadata URLs as installer sources or recovery links.
  return { version: latest, url: release.html_url === previousUrl ? previousUrl : url };
}

export async function latestRelease(signal?: AbortSignal) {
  const target = releaseEndpoint();
  try {
    const response = await fetch(target, {
      headers: { Accept: 'application/vnd.github+json', 'User-Agent': `soyli/${version}` },
      signal: AbortSignal.any([AbortSignal.timeout(5000), ...(signal ? [signal] : [])]),
      redirect: 'error',
    });
    if (!response.ok) {
      await response.body?.cancel();
      throw new DiagnosticError('UPDATE_HTTP', 'Could not check GitHub releases.', {
        status: response.status,
        detail:
          response.status === 404
            ? 'No published stable release was found.'
            : response.status === 403 || response.status === 429
              ? 'GitHub may be rate limiting this connection. Retry later.'
              : undefined,
      });
    }
    // Bound streamed metadata, including responses without Content-Length.
    const reader = response.body?.getReader();
    if (!reader) throw new Error('Release response was empty.');
    let text = '',
      bytes = 0;
    const decoder = new TextDecoder();
    try {
      while (true) {
        const chunk = await reader.read();
        if (chunk.done) break;
        bytes += chunk.value.byteLength;
        if (bytes > 1024 * 1024) throw new Error('Release metadata exceeded 1 MiB.');
        text += decoder.decode(chunk.value, { stream: true });
      }
      text += decoder.decode();
      return parseRelease(JSON.parse(text));
    } finally {
      await reader.cancel().catch(() => {});
    }
  } catch (cause) {
    throw new DiagnosticError('UPDATE_CHECK', 'Could not determine the latest soyLI version.', {
      target,
      cause,
      operation: 'check soyLI release',
      recovery:
        'Check connectivity and retry soyli doctor or soyli update. The installed CLI is unchanged.',
    });
  }
}

export async function releaseCheck(signal?: AbortSignal) {
  try {
    const latest = await latestRelease(signal);
    const comparison = stableVersion.test(version)
      ? compareVersions(version, latest.version)
      : undefined;
    return {
      status:
        comparison === undefined
          ? 'development'
          : comparison < 0
            ? 'update-available'
            : comparison > 0
              ? 'ahead'
              : 'current',
      current: version,
      latest: latest.version,
      url: latest.url,
    } as const;
  } catch (error) {
    return {
      status: 'unavailable',
      current: version,
      diagnostic: diagnose(error, 'check soyLI release'),
    } as const;
  }
}

export function describeRelease(check: Awaited<ReturnType<typeof releaseCheck>>) {
  if (check.status === 'unavailable') return `unavailable\n${formatDiagnostic(check.diagnostic)}`;
  if (check.status === 'update-available')
    return packagedBy
      ? `${check.latest} available; update soyLI through ${packagedBy}`
      : `${check.latest} available; run soyli update`;
  if (check.status === 'current') return `${check.latest} (up to date)`;
  if (check.status === 'ahead')
    return `installed ${check.current} is newer than published ${check.latest}; no downgrade`;
  return `source build; latest published ${check.latest}. Use Git to update this checkout.`;
}

async function installation() {
  if (!standalone)
    throw new DiagnosticError(
      'UPDATE_INSTALLATION',
      'This is a source checkout, not an installed soyLI executable.',
      {
        recovery:
          'Update your checkout with Git. For a managed binary installation, use the installer from GitHub Releases.',
        target: releasesUrl,
      },
    );
  if (packagedBy)
    throw new DiagnosticError(
      'UPDATE_INSTALLATION',
      `This soyLI executable is managed by ${packagedBy}.`,
      {
        target: process.execPath,
        recovery:
          packagedBy === 'nix'
            ? 'Update the flake input or package set that provides soyli (e.g. nix flake update, then rebuild or nix profile upgrade). The installed CLI is unchanged.'
            : `Update soyli with ${packagedBy}. The installed CLI is unchanged.`,
      },
    );
  const executable = await realpath(process.execPath);
  const releaseDirectory = dirname(executable);
  const releasesDirectory = dirname(releaseDirectory);
  const root = dirname(releasesDirectory);
  if (releasesDirectory !== join(root, 'releases'))
    throw new DiagnosticError(
      'UPDATE_INSTALLATION',
      'This executable is not in a managed soyLI installation.',
      {
        recovery:
          'Run the installer from GitHub Releases, or replace a manually unpacked distribution yourself (including its lib directory).',
        target: releasesUrl,
      },
    );
  const savedBin = await readFile(join(root, 'bin-dir'), 'utf8').catch((error) => {
    if (error.code === 'ENOENT') return undefined;
    throw error;
  });
  const bin = process.env.NAPPLET_BIN_DIR ?? savedBin ?? join(homedir(), '.local/bin');
  if (!isAbsolute(bin) || /[\r\n\0]/.test(bin))
    throw new DiagnosticError(
      'UPDATE_INSTALLATION',
      'The managed bin directory must be an absolute path.',
    );
  const command = join(bin, 'soyli');
  if (
    !(await lstat(command).catch(() => null))?.isSymbolicLink() ||
    (await realpath(command)) !== executable
  )
    throw new DiagnosticError(
      'UPDATE_INSTALLATION',
      'The soyli command no longer points to this running installation.',
      {
        target: command,
        recovery:
          'Run the active soyli command. For an older custom installation, set NAPPLET_BIN_DIR to its bin directory. Other commands were not replaced.',
      },
    );
  if (process.env.NAPPLET_INSTALL_DIR && (await realpath(process.env.NAPPLET_INSTALL_DIR)) !== root)
    throw new DiagnosticError(
      'UPDATE_INSTALLATION',
      'NAPPLET_INSTALL_DIR points to a different installation. Unset it or run that installation.',
    );
  // Keep the installer's original spelling (e.g. macOS /var versus /private/var).
  // Ownership is checked using real paths, while the installer recognizes its symlink prefix.
  const linkedRoot = dirname(dirname(dirname(resolve(bin, await readlink(command)))));
  if ((await realpath(linkedRoot)) !== root)
    throw new DiagnosticError(
      'UPDATE_INSTALLATION',
      'The command is not a direct link to a managed release.',
    );
  return { root: linkedRoot, bin, command };
}

export async function updateCli(signal?: AbortSignal) {
  const installed = await installation();
  const latest = await latestRelease(signal);
  const compared = compareVersions(version, latest.version);
  if (compared >= 0)
    return {
      status: compared === 0 ? 'current' : 'ahead',
      previous: version,
      version,
      url: latest.url,
      command: installed.command,
    };
  if (signal?.aborted) throw signal.reason;
  // Execute the installer shipped with this CLI, never a script from release metadata.
  const child = Bun.spawn(['/bin/sh'], {
    stdin: new Blob([installer]),
    stdout: 'pipe',
    stderr: 'pipe',
    detached: true,
    env: {
      ...process.env,
      NAPPLET_RELEASE_VERSION: latest.version,
      NAPPLET_INSTALL_DIR: installed.root,
      NAPPLET_BIN_DIR: installed.bin,
    },
  });
  const stop = () => {
    try {
      process.kill(-child.pid, 'SIGTERM');
    } catch {
      child.kill('SIGTERM');
    }
  };
  signal?.addEventListener('abort', stop, { once: true });
  const deadline = setTimeout(stop, 660000);
  const stdout = new ToolOutput((text) => process.stderr.write(text));
  const stderr = new ToolOutput((text) => process.stderr.write(text));
  const drain = async (stream: ReadableStream<Uint8Array>, log: ToolOutput) => {
    for await (const bytes of stream) log.push(bytes);
    log.finish();
  };
  try {
    const [code] = await Promise.all([
      child.exited,
      drain(child.stdout, stdout),
      drain(child.stderr, stderr),
    ]);
    if (signal?.aborted) throw signal.reason;
    if (code !== 0)
      throw new DiagnosticError('UPDATE_INSTALL', 'The soyLI installer failed.', {
        tool: 'sh/curl/tar',
        exitCode: code,
        target: latest.url,
        detail: [stderr.text, stdout.text].filter(Boolean).join('\n'),
        recovery:
          'Address the installer error and rerun soyli update. Projects and identities were not changed.',
      });
    return {
      status: 'updated',
      previous: version,
      version: latest.version,
      url: latest.url,
      command: installed.command,
    };
  } finally {
    clearTimeout(deadline);
    signal?.removeEventListener('abort', stop);
  }
}
