import { diagnose, formatDiagnostic, redactDiagnostic } from '../packages/diagnostics/src';
import { mkdtemp, mkdir, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { Browser, Frame, Page } from '@playwright/test';
import { z } from 'zod';
import { AccountError } from '../packages/identity/src/signer';
import { MAX_ARTIFACT_BYTES, sha256 } from '../packages/protocol/src/artifact';
import { projectSchema } from '../packages/publish/src/config';
import { regularFile } from '../packages/publish/src/project';
import type { PeerDiagnostics } from '../packages/runtime/src/webrtc-diagnostics';
import { localBackend } from './backend';
import { localModule } from './dynamic-backend';
import { materializePreview } from './frozen-preview';
import { effectiveProject } from '../packages/publish/src/binding';
import { validateAssets, ASSET_LOCK } from '../packages/assets/src';
import { browserEngine, installBrowser } from './browser';
import { hostEnvironment, version } from './distribution';
import { installNetworkLab, networkConditions, type NetworkConditions } from './network-lab';
import { previewAssets } from './preview/assets';
import { startPreviewServer } from './preview/server';
import { connectTestIdentity, approveTestBackendAccount } from './test-identity';

export const multiplayerOptions = networkConditions.extend({
  players: z.number().int().min(2).max(8).default(2),
  timeoutMs: z.number().int().min(1000).max(300000).default(60000),
  turnBinary: z.string().min(1).optional(),
});
export type MultiplayerPlayer = { page: Page; frame: Frame };
export type MultiplayerScenario = {
  players: MultiplayerPlayer[];
  signal: AbortSignal;
  check: (name: string, condition: boolean) => void;
  measure: (name: string, milliseconds: number, maximum: number) => void;
  network: (conditions: Partial<NetworkConditions>) => Promise<void>;
  diagnostics: () => Promise<PeerDiagnostics[][]>;
  connectIdentity: (player: MultiplayerPlayer) => Promise<{ pubkey: string }>;
  approveBackendAccount: (player: MultiplayerPlayer, module: string) => Promise<void>;
};
type Check = { name: string; passed: boolean; milliseconds?: number; maximum?: number };

async function deadline<T>(task: Promise<T>, milliseconds: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  try {
    return await Promise.race([
      task,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('Final diagnostics timed out')), milliseconds);
      }),
    ]);
  } finally {
    clearTimeout(timer!);
  }
}

async function startTestTurn(directory: string, binary: string) {
  const reservation = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: () => new Response('') });
  const port = reservation.port!;
  reservation.stop(true);
  const secret = crypto.randomUUID();
  const config = join(directory, 'turn.conf');
  await Bun.write(
    config,
    `listening-ip=127.0.0.1\nrelay-ip=127.0.0.1\nlistening-port=${port}\nrealm=soyli-test\n` +
      `use-auth-secret\nstatic-auth-secret=${secret}\nno-tls\nno-dtls\nno-cli\nallow-loopback-peers\n` +
      `no-multicast-peers\nlog-file=stdout\npidfile=${directory}/turn.pid\n`,
    { mode: 0o600 },
  );
  const process = Bun.spawn([binary, '-c', config], {
    env: hostEnvironment(),
    stdout: Bun.file(join(directory, 'turn.log')),
    stderr: 'ignore',
  });
  await Bun.sleep(500);
  if (process.exitCode !== null)
    throw new Error('Local coturn exited during startup. Check --turn-binary.');
  return {
    process,
    connectivity: {
      turnUrls: [`turn:127.0.0.1:${port}?transport=udp`],
      turnSecret: secret,
      relayOnly: true,
    },
  };
}

/** Runs a creator-owned test against frozen build bytes and a disposable local backend. */
export async function testMultiplayer(
  directory: string,
  scenarioPath: string,
  input: z.input<typeof multiplayerOptions> = {},
  signal = new AbortController().signal,
) {
  const options = multiplayerOptions.parse(input);
  const root = await realpath(directory);
  const scenarioFile = await realpath(resolve(root, scenarioPath));
  const relativePath = relative(root, scenarioFile);
  if (
    relativePath === '..' ||
    relativePath.startsWith('../') ||
    isAbsolute(relativePath) ||
    !/\.(mjs|js|ts|mts)$/.test(scenarioFile)
  )
    throw new AccountError('USAGE', 'Choose a local .mjs or .ts scenario inside the project.');
  const config = await effectiveProject(
    root,
    projectSchema.parse(
      JSON.parse(new TextDecoder().decode(await regularFile(root, 'napplet.json', 16384))),
    ),
  );
  if (!config.backend)
    throw new AccountError('PROJECT_CONFIG', 'Run soyli backend init before testing multiplayer.');
  const artifact = await regularFile(root, config.entry, MAX_ARTIFACT_BYTES);
  const contents = new Map<string, Uint8Array>([
    [
      'napplet.json',
      new TextEncoder().encode(JSON.stringify({ ...config, entry: 'index.html', relays: [] })),
    ],
    ['index.html', artifact],
  ]);
  for (const path of config.backend.modules ?? []) {
    const module = await localModule(root, path);
    for (const [file, text] of Object.entries(module.files))
      contents.set(file, new TextEncoder().encode(text));
  }
  const assets = await validateAssets(root);
  if (assets.assets.length) {
    contents.set(ASSET_LOCK, await regularFile(root, ASSET_LOCK, 1024 * 1024));
    for (const asset of assets.assets)
      contents.set(asset.path, await regularFile(root, asset.path, asset.bytes));
  }
  // Cache acquisition has its own deadline and must not consume a short scenario budget.
  signal.throwIfAborted();
  await installBrowser();
  signal.throwIfAborted();
  const directoryCopy = await mkdtemp(join(tmpdir(), 'soy-multiplayer-'));
  const reportPath = join(root, '.napplet-space/multiplayer/latest.json');
  const started = Date.now();
  const checks: Check[] = [],
    errors: string[] = [],
    warnings: string[] = [];
  let browser: Browser | undefined;
  let server: ReturnType<typeof startPreviewServer> | undefined;
  let backend: Awaited<ReturnType<typeof localBackend>>;
  let turn: Awaited<ReturnType<typeof startTestTurn>> | undefined;
  let players: MultiplayerPlayer[] = [];
  let routes: PeerDiagnostics[][] = [];
  let simulated: unknown[] = [];
  let failure: string | undefined;
  let conditions = networkConditions.parse(optionsToNetwork(options));
  const lifetime = new AbortController();
  const combined = AbortSignal.any([signal, lifetime.signal]);
  const abort = () => {
    void browser?.close().catch(() => {});
  };
  combined.addEventListener('abort', abort, { once: true });
  const timer = setTimeout(
    () => lifetime.abort(new Error('Multiplayer scenario timed out')),
    options.timeoutMs,
  );
  const readDiagnostics = () =>
    Promise.all(
      players.map(({ page }) =>
        page.evaluate(() =>
          (
            window as unknown as { soyliPreview: { diagnostics: () => Promise<PeerDiagnostics[]> } }
          ).soyliPreview.diagnostics(),
        ),
      ),
    );
  try {
    await materializePreview(directoryCopy, contents);
    if (options.turnBinary) turn = await startTestTurn(directoryCopy, options.turnBinary);
    backend = await localBackend(directoryCopy, turn?.connectivity);
    combined.throwIfAborted();
    server = startPreviewServer(
      pathToFileURL(directoryCopy + '/'),
      0,
      false,
      await previewAssets(),
      { network: 'local', backend: backend!.provider },
    );
    combined.throwIfAborted();
    browser = await (
      await browserEngine()
    ).chromium.launch({
      headless: true,
      args: [
        '--allow-loopback-in-peer-connection',
        '--disable-features=WebRtcHideLocalIpsWithMdns',
        '--disable-background-timer-throttling',
        '--disable-renderer-backgrounding',
        '--disable-backgrounding-occluded-windows',
      ],
    });
    combined.throwIfAborted();
    const instance = browser;
    const url = server.url.href;
    players = await Promise.all(
      Array.from({ length: options.players }, async (_, index) => {
        const context = await instance.newContext({ viewport: { width: 960, height: 740 } });
        await context.addInitScript(installNetworkLab, {
          ...conditions,
          seed: Math.min(2147483647, conditions.seed + index),
        });
        await context.addInitScript(() => {
          if (window.parent === window)
            localStorage.setItem('napplet:multiplayer-permission:v1', 'allow');
        });
        const page = await context.newPage();
        page.on('pageerror', (error) =>
          errors.push(redactDiagnostic(`Player ${index + 1}: ${error.message}`)),
        );
        page.setDefaultTimeout(Math.min(15000, options.timeoutMs));
        await page.goto(url);
        await page.locator('#stage iframe').waitFor();
        const frame = page.frames().find((frame) => frame.parentFrame())!;
        await frame.waitForFunction(() => !!(window as unknown as { napplet?: unknown }).napplet);
        return { page, frame };
      }),
    );
    combined.throwIfAborted();
    const abortable = async <T>(task: Promise<T>) => {
      combined.throwIfAborted();
      let rejectAbort: () => void = () => {};
      const cancelled = new Promise<never>((_, reject) => {
        rejectAbort = () => reject(combined.reason);
        combined.addEventListener('abort', rejectAbort, { once: true });
      });
      try {
        return await Promise.race([task, cancelled]);
      } finally {
        combined.removeEventListener('abort', rejectAbort);
      }
    };
    const module = await abortable(import(pathToFileURL(scenarioFile).href));
    if (typeof module.default !== 'function')
      throw new Error('The scenario must export a default async function.');
    const api: MultiplayerScenario = {
      players,
      signal: combined,
      async connectIdentity(player) {
        if (!players.includes(player)) throw new Error('Choose a player from this scenario.');
        return connectTestIdentity(player.page, url);
      },
      async approveBackendAccount(player, module) {
        if (!players.includes(player)) throw new Error('Choose a player from this scenario.');
        return approveTestBackendAccount(player.page, module, backend!.provider.pubkey);
      },
      check(name, condition) {
        const passed = condition === true;
        checks.push({ name, passed });
        if (!passed) throw new Error(`Failed: ${name}`);
      },
      measure(name, milliseconds, maximum) {
        const passed =
          Number.isFinite(milliseconds) &&
          milliseconds >= 0 &&
          Number.isFinite(maximum) &&
          maximum > 0 &&
          milliseconds <= maximum;
        checks.push({ name, passed, milliseconds, maximum });
        if (!passed)
          throw new Error(`Failed: ${name} (${milliseconds.toFixed(1)} ms; budget ${maximum} ms)`);
      },
      async network(next) {
        conditions = networkConditions.parse({ ...conditions, ...next });
        await Promise.all(
          players.map(({ page }, index) =>
            page.evaluate(
              (next) =>
                (
                  window as unknown as {
                    soyliNetworkLab: { set: (next: NetworkConditions) => void };
                  }
                ).soyliNetworkLab.set(next),
              { ...conditions, seed: Math.min(2147483647, conditions.seed + index) },
            ),
          ),
        );
      },
      diagnostics: readDiagnostics,
    };
    await abortable(Promise.resolve(module.default(api)));
    combined.throwIfAborted();
    if (!checks.length)
      throw new Error(
        'No assertions recorded. Use check() or measure(); connection alone is not a gameplay test.',
      );
    if (checks.some((check) => !check.passed))
      throw new Error('A recorded assertion failed; see the report.');
    if (errors.length) throw new Error('Browser errors occurred; see the report.');
  } catch (error) {
    failure = combined.aborted
      ? 'Multiplayer scenario cancelled or timed out.'
      : formatDiagnostic(diagnose(error, 'multiplayer scenario'));
  } finally {
    clearTimeout(timer);
    // Capture observations on failure as well. Never include native candidates or credentials.
    if (browser?.isConnected()) {
      try {
        [routes, simulated] = await deadline(
          Promise.all([
            readDiagnostics(),
            Promise.all(
              players.map(({ page }) =>
                page.evaluate(() =>
                  (
                    window as unknown as { soyliNetworkLab: { read: () => unknown } }
                  ).soyliNetworkLab.read(),
                ),
              ),
            ),
          ]),
          1500,
        );
      } catch {
        warnings.push(
          'Final connection diagnostics unavailable; scenario assertions are retained.',
        );
      }
    }
    combined.removeEventListener('abort', abort);
    lifetime.abort(new Error('Scenario finished'));
    try {
      await browser?.close().catch(() => {});
      server?.stop(true);
      await backend?.close();
    } catch (error) {
      failure ??= formatDiagnostic(diagnose(error, 'close multiplayer test services'));
    } finally {
      if (turn) {
        // coturn's graceful shutdown can wait on allocation timers; this instance is disposable.
        turn.process.kill();
        const kill = setTimeout(() => turn!.process.kill('SIGKILL'), 3000);
        try {
          await turn.process.exited;
        } finally {
          clearTimeout(kill);
        }
      }
      await rm(directoryCopy, { recursive: true, force: true });
    }
  }
  const report = {
    cliVersion: version,
    artifactHash: await sha256(artifact),
    status: failure ? 'failed' : 'passed',
    scenario: relativePath,
    players: options.players,
    durationMs: Date.now() - started,
    conditions: optionsToNetwork(options),
    transport: turn ? 'forced local TURN' : 'local ICE',
    checks,
    errors,
    warnings,
    ...(failure ? { failure } : {}),
    peers: routes,
    simulated,
    scope:
      'Creator scenario assertions on a local frozen build. No public-network, packet-loss or whole-game certification.',
  };
  await mkdir(dirname(reportPath), { recursive: true });
  await Bun.write(reportPath, JSON.stringify(report, null, 2) + '\n');
  return { ...report, reportPath };
}

function optionsToNetwork(options: NetworkConditions): NetworkConditions {
  return { latencyMs: options.latencyMs, jitterMs: options.jitterMs, seed: options.seed };
}
