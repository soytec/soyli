import { diagnose, DiagnosticError, formatDiagnostic } from '../packages/diagnostics/src';
import { dangerousFileKeystore } from '../packages/identity/src/accounts';
import { realpath } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { AccountError, type Network } from '../packages/identity/src/signer';
import { inspectProject, regularFile } from '../packages/publish/src/project';
import { effectiveProject } from '../packages/publish/src/binding';
import { projectSchema } from '../packages/publish/src/config';
import { browserCompatibilityNote, browserEngine, browserInstalled } from './browser';
import { checkPublication } from './publish-check';
import { previewAssets } from './preview/assets';
import { startPreviewServer } from './preview/server';
import { gitAvailable } from './prerequisites';
import { hostEnvironment, version } from './distribution';
import { releaseCheck } from './update';
import { watchProject } from './toolchain';
import { rustToolchainStatus } from './rust-build';
import { screenshotProject, recordProject } from './project-config';
import { developmentAuthor, localBackend } from './backend';
import { createWorkshop } from './workshop';

export async function preview(
  directory: string,
  port: number | undefined,
  open: boolean,
  json: boolean,
  signal: AbortSignal,
  network: Network = 'public',
) {
  const root = await realpath(directory);
  const config = await Bun.file(new URL('napplet.json', pathToFileURL(root + '/'))).json();
  let watcher: Awaited<ReturnType<typeof watchProject>> | undefined;
  let failWatch: (error: Error) => void = () => {};
  const watcherFailure = new Promise<never>((_, reject) => {
    failWatch = reject;
  });
  // Install the rejection handler before a watcher can exit during startup.
  void watcherFailure.catch(() => {});
  async function startWatcher() {
    if (signal.aborted || config.entry !== 'dist/index.html') return;
    const active = await watchProject(root, signal);
    watcher = active;
    void active.exited
      .then(() => {
        if (watcher === active && !signal.aborted) failWatch(active.failure());
      })
      .catch(failWatch);
  }
  await startWatcher();
  const workshop = createWorkshop({
    directory: root,
    network,
    signal,
    onAuth: async (url) => {
      console.log(`Approve this action with your signer: ${url}`);
    },
    pauseBuilds: async () => {
      const active = watcher;
      watcher = undefined;
      await active?.stop();
      return startWatcher;
    },
  });
  let server: ReturnType<typeof startPreviewServer> | undefined;
  let backend: Awaited<ReturnType<typeof localBackend>>;
  const stop = () => server?.stop(true);
  try {
    backend = await localBackend(root);
    const assets = await previewAssets();
    const start = (listenPort: number) =>
      startPreviewServer(pathToFileURL(root + '/'), listenPort, false, assets, {
        network,
        workshop,
        backend: backend?.provider,
        record: (settings, interactive) =>
          recordProject(
            root,
            network,
            `preview-${Date.now()}-${crypto.randomUUID().slice(0, 8)}.webm`,
            settings,
            interactive,
            signal,
          ),
        capture: (interactive) =>
          screenshotProject(
            root,
            network,
            `preview-${Date.now()}-${crypto.randomUUID().slice(0, 8)}.png`,
            interactive,
            signal,
          ),
      });
    try {
      server = start(port ?? 4173);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EADDRINUSE') throw error;
      if (port !== undefined)
        throw new AccountError(
          'PREVIEW_PORT_IN_USE',
          `Port ${port} is already in use. Stop the other preview or run soyli dev --port 0 to choose a free port.`,
        );
      server = start(0);
      if (!json) console.log('Port 4173 is already in use; using a free preview port.');
    }
    signal.addEventListener('abort', stop, { once: true });
    const response = await fetch(new URL('revision', server.url));
    if (!response.ok) {
      // This is our own loopback server's bounded, already-sanitized error response.
      const detail = await response.json().catch(() => null);
      throw new DiagnosticError('PROJECT_CONFIG', 'Cannot preview this project.', {
        operation: 'start local preview',
        status: response.status,
        detail: typeof detail?.error === 'string' ? detail.error : undefined,
        recovery: 'Correct the reported project error and restart soyli dev.',
      });
    }
    console.log(
      json
        ? JSON.stringify({ url: server.url.href })
        : `Local napplet preview: ${server.url}\nEdit ${watcher ? 'your project source' : 'index.html'}; the preview reloads after each build/save. Press Ctrl+C to stop.`,
    );
    if (open && !json) {
      const executable = Bun.which(process.platform === 'darwin' ? 'open' : 'xdg-open');
      if (executable) {
        const child = Bun.spawn([executable, server.url.href], {
          env: hostEnvironment(),
          stdin: 'ignore',
          stdout: 'ignore',
          stderr: 'ignore',
        });
        child.unref();
      }
    }
    if (!signal.aborted)
      await Promise.race([
        new Promise<void>((resolve) =>
          signal.addEventListener('abort', () => resolve(), { once: true }),
        ),
        watcherFailure,
      ]);
  } finally {
    signal.removeEventListener('abort', stop);
    stop();
    await workshop.close();
    await watcher?.stop();
    await backend?.close();
  }
}

export async function checkProject(directory: string, network: Network) {
  const root = await realpath(directory);
  const bytes = await regularFile(root, 'napplet.json', 16384);
  let config;
  try {
    config = JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    throw new AccountError('PROJECT_CONFIG', 'Invalid napplet.json.');
  }
  // Inspection needs no signer. A declared creator is only a public reference.
  const project = await effectiveProject(root, projectSchema.parse(config));
  const { plan, contents } = await inspectProject(
    root,
    network,
    project.creator?.pubkey ?? developmentAuthor,
  );
  const { profile, browser, coverage, warnings, preview } = await checkPublication(contents);
  return {
    status: 'checked',
    profile,
    browser,
    coverage,
    warnings,
    previewBytes: preview.length,
    artifactHash: plan.artifactHash,
    sourceBytes: plan.sourceBytes,
    ...(plan.requires.includes('webrtc')
      ? {
          multiplayer:
            'Gameplay not tested. Run soyli multiplayer <scenario.mjs> with guest responsiveness assertions.',
        }
      : {}),
  };
}

export async function doctor(signal?: AbortSignal, directory = process.cwd()) {
  const release = releaseCheck(signal);
  const git = await gitAvailable();
  let browser = 'not installed (downloaded on first check/publish, or run browser install)';
  try {
    if (await browserInstalled()) {
      try {
        const instance = await (
          await browserEngine()
        ).chromium.launch({ headless: true, timeout: 10000 });
        await instance.close();
        browser = 'ready';
      } catch (error) {
        browser = formatDiagnostic(diagnose(error, 'start installed Chromium'));
      }
    }
    const note = browserCompatibilityNote();
    if (note) browser += `; ${note}`;
  } catch (error) {
    browser =
      error instanceof AccountError
        ? error.message
        : formatDiagnostic(diagnose(error, 'browser diagnostics'));
  }
  const rust = await rustToolchainStatus(directory, signal);
  return {
    version,
    platform: `${process.platform}-${process.arch}`,
    release: await release,
    git: git ? 'ready' : 'missing; install Git with your OS package manager',
    browser,
    ...(rust ? { rust } : {}),
    credentials: dangerousFileKeystore()
      ? 'DANGEROUS: unencrypted owner-only files outside Git; separate account selection. Unset SOYLI_DANGEROUS_PLAINTEXT_KEYS to use the OS vault.'
      : process.platform === 'darwin'
        ? 'Local keys use login Keychain. New remote sessions use private files outside projects; Keychain is optional. account show reports storage; account storage file migrates an existing remote session.'
        : 'New remote sessions use private files outside projects, without a desktop keyring. Local keys and optional remote Keychain storage require an unlocked Secret Service and D-Bus session. account show reports storage; account storage file migrates an existing remote session.',
  };
}
