import { relatedAssetHtml } from '../packages/assets/src/related';
import { regularFile } from '../packages/publish/src/project';
import { MAX_ARTIFACT_BYTES } from '../packages/protocol/src';
import { projectEnvironment as environment, runProjectCommand as command } from './project-process';
import {
  readBuildRecipe,
  buildWithRecipe,
  setupRust,
  watchRecipe,
  sourceStamp,
} from './rust-build';
import { DiagnosticError, ToolOutput } from '../packages/diagnostics/src';
import { validateAssets } from '../packages/assets/src';
import { chmod, lstat, mkdir, mkdtemp, readlink, rename, rm, symlink } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { createRequire } from 'node:module';
import pins from '../vendor/toolchain.json';
import { AccountError } from '../packages/identity/src/signer';
import { backendProject } from './backend';
import { selectNodeToolchain } from './toolchain-platform';
import { packagedBy } from './distribution';

export const toolchainCache = () =>
  resolve(
    process.env.SPACE_TOOLCHAIN_CACHE ||
      join(
        process.env.XDG_CACHE_HOME ||
          (process.platform === 'darwin'
            ? join(homedir(), 'Library/Caches')
            : join(homedir(), '.cache')),
        'napplet-space/toolchains',
      ),
  );

async function download(url: string, target: string, digest: string, signal?: AbortSignal) {
  const response = await fetch(url, {
    redirect: 'error',
    signal: AbortSignal.any([AbortSignal.timeout(180000), ...(signal ? [signal] : [])]),
  }).catch((cause) => {
    throw new DiagnosticError('TOOLCHAIN_DOWNLOAD', 'Could not download the project toolchain.', {
      operation: 'download project toolchain',
      target: url,
      cause,
    });
  });
  if (!response.ok || !response.body) {
    await response.body?.cancel();
    throw new DiagnosticError('TOOLCHAIN_DOWNLOAD', 'Toolchain download failed.', {
      operation: 'download project toolchain',
      target: url,
      status: response.status,
      recovery: 'Check connectivity and the download service, then retry soyli setup.',
    });
  }
  const chunks: Uint8Array[] = [];
  let size = 0;
  for await (const bytes of response.body) {
    size += bytes.length;
    if (size > 100 * 1024 * 1024) throw new Error('Toolchain download exceeds limit');
    chunks.push(bytes);
  }
  const bytes = Buffer.concat(chunks);
  const valid = digest.startsWith('sha512-')
    ? `sha512-${new Bun.CryptoHasher('sha512').update(bytes).digest('base64')}` === digest
    : new Bun.CryptoHasher('sha256').update(bytes).digest('hex') === digest;
  if (!valid)
    throw new AccountError(
      'TOOLCHAIN_CHECKSUM',
      'Downloaded toolchain did not match its release checksum. Nothing was installed.',
    );
  await Bun.write(target, bytes);
}

/**
 * Packagers (e.g. Nix) can supply the pinned Node and pnpm instead of runtime
 * downloads. Both must be set; the Node version is still checked before use.
 */
async function providedToolchain() {
  const nodeBin = process.env.SOYLI_NODE,
    pnpm = process.env.SOYLI_PNPM;
  if (!nodeBin && !pnpm) return undefined;
  const recovery =
    'Set both SOYLI_NODE (Node binary) and SOYLI_PNPM (pnpm.cjs) to absolute paths, or unset both to use the managed toolchain.';
  if (!nodeBin || !pnpm || !isAbsolute(nodeBin) || !isAbsolute(pnpm))
    throw new DiagnosticError(
      'TOOLCHAIN_PROVIDED',
      'The provided project toolchain is incomplete.',
      {
        operation: 'resolve provided project toolchain',
        recovery,
      },
    );
  for (const path of [nodeBin, pnpm]) {
    const stat = await lstat(path).catch((cause) => {
      throw new DiagnosticError('TOOLCHAIN_PROVIDED', 'A provided toolchain file is missing.', {
        operation: 'resolve provided project toolchain',
        target: path,
        recovery,
        cause,
      });
    });
    if (stat.isDirectory())
      throw new DiagnosticError('TOOLCHAIN_PROVIDED', 'A provided toolchain path is a directory.', {
        operation: 'resolve provided project toolchain',
        target: path,
        recovery,
      });
  }
  return { nodeBin, pnpm };
}

let preparing: Promise<Awaited<ReturnType<typeof prepare>>> | undefined;
async function prepare(signal?: AbortSignal) {
  const platform = `${process.platform}-${process.arch}`;
  const macVersion =
    process.platform === 'darwin'
      ? (
          await command(
            ['/usr/bin/sw_vers', '-productVersion'],
            process.cwd(),
            environment(),
            signal,
            true,
          )
        ).trim()
      : undefined;
  const selected = selectNodeToolchain(process.platform, process.arch, macVersion);
  const node = selected.archive;
  if (!node)
    throw new AccountError(
      'TOOLCHAIN_PLATFORM',
      'The project toolchain supports macOS and glibc Linux on ARM64/x64.',
    );
  const root = toolchainCache();
  await mkdir(root, { recursive: true, mode: 0o700 });
  const nodeRoot = join(root, node.directory),
    pnpmRoot = join(root, `pnpm-${pins.pnpm.version}`);
  const provided = await providedToolchain();
  const nodeBin = provided?.nodeBin ?? join(nodeRoot, 'bin/node'),
    pnpm = provided?.pnpm ?? join(pnpmRoot, 'package/bin/pnpm.cjs');
  const baseEnv = { ...environment(), PATH: '/usr/bin:/bin' };
  async function ensure(
    destination: string,
    executable: string,
    url: string,
    digest: string,
    prefix: string,
  ) {
    const current = await lstat(executable).catch(() => null);
    if (current?.isFile() && !current.isSymbolicLink()) return;
    if (await lstat(destination).catch(() => null))
      throw new AccountError(
        'TOOLCHAIN_CACHE',
        `Incomplete toolchain cache at ${destination}; move it aside and retry setup.`,
      );
    const stage = await mkdtemp(join(root, '.download-'));
    try {
      process.stderr.write(`Preparing ${prefix} (cached for future projects)…\n`);
      const archive = join(stage, 'archive.tar.gz');
      await download(url, archive, digest, signal);
      const entries = (
        await command(['/usr/bin/tar', '-tzf', archive], stage, baseEnv, signal, true)
      )
        .trim()
        .split('\n');
      if (
        entries.some(
          (path) =>
            !path.startsWith(prefix + '/') ||
            path.split('/').some((part) => part === '..' || part === '.'),
        )
      )
        throw new Error('Unexpected toolchain archive path');
      await command(['/usr/bin/tar', '-xzf', archive, '-C', stage], stage, baseEnv, signal);
      if (prefix === 'package') {
        await rm(archive);
        try {
          await rename(stage, destination);
        } catch (error) {
          if (!(await Bun.file(executable).exists())) throw error;
        }
      } else {
        try {
          await rename(join(stage, prefix), destination);
        } catch (error) {
          if (!(await Bun.file(executable).exists())) throw error;
        }
      }
    } finally {
      await rm(stage, { recursive: true, force: true });
    }
  }
  if (!provided) {
    await ensure(nodeRoot, nodeBin, node.url, node.sha256, node.directory);
    await ensure(pnpmRoot, pnpm, pins.pnpm.url, pins.pnpm.integrity, 'package');
  }
  const bin = join(
    root,
    `bin-${selected.version}-${pins.pnpm.version}-${platform}${provided ? '-provided' : ''}`,
  );
  await mkdir(bin, { recursive: true });
  const pnpmLink = join(bin, 'pnpm');
  let linked = await lstat(pnpmLink).catch(() => null);
  // A provided toolchain can move (e.g. a new Nix store path); keep the link current.
  if (linked && provided && (await readlink(pnpmLink).catch(() => undefined)) !== pnpm) {
    await rm(pnpmLink, { force: true });
    linked = null;
  }
  if (!linked) await symlink(pnpm, pnpmLink);
  if (!provided && ((await lstat(pnpm)).mode & 0o111) !== 0o111) await chmod(pnpm, 0o755);
  const env = {
    ...environment(),
    PATH: `${dirname(nodeBin)}:${bin}:${process.env.PATH || '/usr/bin:/bin'}`,
    PNPM_HOME: bin,
    COREPACK_ENABLE_PROJECT_SPEC: '0',
    PLAYWRIGHT_BROWSERS_PATH: process.env.PLAYWRIGHT_BROWSERS_PATH || join(root, 'browsers'),
  };
  if (
    (await command([nodeBin, '--version'], root, env, signal, true)).trim() !==
    `v${selected.version}`
  )
    throw provided
      ? new DiagnosticError(
          'TOOLCHAIN_VERSION',
          `The provided Node runtime is not the pinned v${selected.version}.`,
          {
            operation: 'check provided project toolchain',
            target: nodeBin,
            recovery: `Point SOYLI_NODE at Node v${selected.version}, or unset SOYLI_NODE and SOYLI_PNPM to use the managed toolchain.`,
          },
        )
      : new AccountError('TOOLCHAIN_VERSION', 'Unexpected cached Node version.');
  return { nodeBin, pnpm, env };
}

function prepared(signal?: AbortSignal) {
  return (preparing ??= prepare(signal).catch((error) => {
    preparing = undefined;
    throw error;
  }));
}

/** The pinned runtime also runs bundled Node tools; never use a project/global Node. */
export async function managedNode(signal?: AbortSignal) {
  return (await prepared(signal)).nodeBin;
}

export async function projectTool(directory: string, args: string[], signal?: AbortSignal) {
  await backendProject(directory);
  const tools = await prepared(signal);
  const operation =
    args[0] === 'install'
      ? 'install project dependencies'
      : args[0] === 'run' && args[1] === 'build'
        ? 'build napplet'
        : 'run project command';
  return command(
    [tools.nodeBin, tools.pnpm, ...args],
    resolve(directory),
    tools.env,
    signal,
    false,
    operation,
  );
}

export async function setupProject(directory: string, signal?: AbortSignal) {
  await backendProject(directory);
  const recipe = await readBuildRecipe(directory);
  if (recipe?.kind === 'rust') return setupRust(directory, recipe, signal);
  if (recipe?.kind === 'command') return;
  const pkg = await Bun.file(join(directory, 'package.json')).json();
  if (pkg.packageManager !== `pnpm@${pins.pnpm.version}`)
    throw new AccountError(
      'PROJECT_TOOLCHAIN',
      `This CLI supports the upstream pnpm@${pins.pnpm.version} pin. Use your chosen package manager explicitly for a different toolchain.`,
    );
  await projectTool(directory, ['install', '--frozen-lockfile', '--ignore-scripts'], signal);
}

export async function buildProject(directory: string, signal?: AbortSignal) {
  const managed = await validateAssets(directory);
  await backendProject(directory);
  const recipe = await readBuildRecipe(directory);
  if (recipe) await buildWithRecipe(directory, recipe, signal);
  else {
    if (!(await Bun.file(join(directory, 'node_modules/.modules.yaml')).exists()))
      await setupProject(directory, signal);
    await projectTool(directory, ['run', 'build'], signal);
  }
  const config = await Bun.file(join(directory, 'napplet.json')).json();
  // Legacy index.html is editable source; inspection prepares it in memory.
  if (config.entry === 'dist/index.html') {
    const original = await regularFile(directory, config.entry, MAX_ARTIFACT_BYTES);
    const html = await relatedAssetHtml(original, managed);
    if (html.length > MAX_ARTIFACT_BYTES)
      throw new DiagnosticError(
        'ARTIFACT_LIMIT',
        'The HTML including related asset links exceeds 25 MiB.',
        {
          operation: 'prepare built artifact',
          target: config.entry,
          recovery: 'Reduce embedded assets, then run soyli build again.',
        },
      );
    await Bun.write(join(directory, config.entry), html);
  }
}

// Ask the project's own driver in a fresh Node process. Its registry selects the
// revision and platform-specific executable paths; the bundled CLI driver can
// differ, and importing either registry in-process would cache its environment.
const conformanceBrowserProbe = String.raw`
const {createRequire} = require('node:module');
const {dirname, join} = require('node:path');
const {accessSync, constants, existsSync} = require('node:fs');
const playwright = process.argv[1];
const r = createRequire(playwright);
const core = dirname(r.resolve('playwright-core/package.json'));
const coreRequire = createRequire(join(core, 'package.json'));
const registry = existsSync(join(core, 'lib/coreBundle.js'))
  ? coreRequire('./lib/coreBundle.js').registry.registry
  : coreRequire('./lib/server/registry/index.js').registry;
const metadata = coreRequire('./browsers.json');
console.log(JSON.stringify({
  version: r(playwright).version,
  browsers: ['chromium-headless-shell', 'ffmpeg'].map(name => {
    const executable = registry.findExecutable(name);
    const path = executable && executable.executablePath();
    let installed = false;
    if (path) try { accessSync(path, constants.X_OK); installed = true; } catch {}
    return {name, path, revision: metadata.browsers.find(browser => browser.name === name)?.revision, installed};
  }),
}));
`;

export async function installConformanceBrowser(directory: string, signal?: AbortSignal) {
  const tools = await prepared(signal);
  const projectRequire = createRequire(join(resolve(directory), 'package.json'));
  const conformanceRequire = createRequire(
    projectRequire.resolve('@napplet/conformance-cli/package.json'),
  );
  const playwright = conformanceRequire.resolve('playwright/package.json');
  const inspect = async () =>
    JSON.parse(
      await command(
        [tools.nodeBin, '-e', conformanceBrowserProbe, playwright],
        directory,
        tools.env,
        signal,
        true,
        'inspect project conformance browser',
      ),
    ) as {
      version: string;
      browsers: Array<{ name: string; path?: string; revision?: string; installed: boolean }>;
    };
  let required = await inspect();
  if (required.browsers.every((browser) => browser.installed)) return;
  const missing = () => required.browsers.filter((browser) => !browser.installed);
  const failure = (managed: boolean) =>
    new DiagnosticError(
      'CONFORMANCE_BROWSER',
      `Compatible browsers for the project's Playwright ${required.version} are missing.`,
      {
        operation: 'prepare conformance browser',
        tool: 'Playwright',
        target: missing()[0]?.path || tools.env.PLAYWRIGHT_BROWSERS_PATH,
        detail: missing()
          .map(
            (browser) =>
              `${browser.name} revision ${browser.revision || 'unknown'}: ${browser.path || 'no executable for this platform'}`,
          )
          .join('\n'),
        recovery: managed
          ? 'Update the Nix flake/package and rebuild, align the project Playwright version, or set PLAYWRIGHT_BROWSERS_PATH to an existing compatible browser installation. No browser installer was run.'
          : 'Inspect the project Playwright installation and browser cache, then retry soyli run test:conformance.',
      },
    );
  // Nix owns these browsers. Even an otherwise successful Playwright installer
  // writes lock and .links metadata, which cannot live in the read-only store.
  if (packagedBy === 'nix') throw failure(true);
  await command(
    [tools.nodeBin, join(dirname(playwright), 'cli.js'), 'install', '--only-shell', 'chromium'],
    directory,
    tools.env,
    signal,
    false,
    'install project conformance browser',
  );
  required = await inspect();
  if (missing().length) throw failure(false);
}

/** Watch source through Vite's actual single-file plugin; keep host preview separate. */
export async function watchProject(directory: string, signal: AbortSignal) {
  const recipe = await readBuildRecipe(directory);
  const before = recipe ? await sourceStamp(directory, recipe) : undefined;
  await buildProject(directory, signal);
  if (recipe) return watchRecipe(directory, recipe, signal, before);
  const tools = await preparing!;
  const child = Bun.spawn([tools.nodeBin, tools.pnpm, 'exec', 'vite', 'build', '--watch'], {
    cwd: directory,
    env: tools.env,
    stdin: 'ignore',
    stdout: 'pipe',
    stderr: 'pipe',
    detached: true,
  });
  let forceTimer: ReturnType<typeof setTimeout> | undefined;
  const kill = (kind: NodeJS.Signals) => {
    try {
      process.kill(-child.pid, kind);
    } catch {
      child.kill(kind);
    }
  };
  const stop = () => {
    kill('SIGTERM');
    forceTimer ??= setTimeout(() => kill('SIGKILL'), 500);
  };
  signal.addEventListener('abort', stop, { once: true });
  let ready!: () => void;
  const firstBuild = new Promise<void>((resolve) => {
    ready = resolve;
  });
  let output = '';
  const stdoutLog = new ToolOutput((text) => process.stderr.write(text));
  const stderrLog = new ToolOutput((text) => process.stderr.write(text));
  const failure = (message: string) =>
    new DiagnosticError('BUILD_WATCH', message, {
      operation: 'watch project builds',
      tool: 'Vite',
      exitCode: child.exitCode ?? undefined,
      detail: stderrLog.text || stdoutLog.text,
      recovery: 'Fix the reported build error and restart soyli dev.',
    });
  const drain = async (stream: ReadableStream<Uint8Array>, log: ToolOutput) => {
    for await (const bytes of stream) {
      log.push(bytes);
      // Vite's pinned watch reporter emits this after the single-file plugin completes.
      output = (output + new TextDecoder().decode(bytes)).slice(-4096);
      if (/built in \d+ms/.test(output)) ready();
    }
    log.finish();
  };
  const finished = Promise.all([
    child.exited,
    drain(child.stdout, stdoutLog),
    drain(child.stderr, stderrLog),
  ]).finally(() => {
    signal.removeEventListener('abort', stop);
    clearTimeout(forceTimer);
  });
  let startupTimer: ReturnType<typeof setTimeout> | undefined;
  try {
    if (signal.aborted) stop();
    await Promise.race([
      firstBuild,
      finished.then(() => {
        throw failure('The Vite watcher stopped before its first build.');
      }),
      new Promise<never>((_, reject) => {
        startupTimer = setTimeout(
          () => reject(failure('Timed out waiting for the first Vite build.')),
          60000,
        );
      }),
    ]);
  } catch (error) {
    stop();
    await finished;
    throw error;
  } finally {
    clearTimeout(startupTimer);
  }
  return {
    stop: async () => {
      stop();
      await finished;
      clearTimeout(forceTimer);
    },
    exited: finished,
    failure: () => failure('The Vite build watcher stopped.'),
  };
}
