import { redactDiagnostic } from '../packages/diagnostics/src';
import { waitForCapture } from './interactive-capture';
import { materializePreview } from './frozen-preview';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { previewAssets } from './preview/assets';
import { browserEngine, installBrowser } from './browser';
import { startPreviewServer } from './preview/server';
import { inspectPreviewVideo, MAX_VIDEO_BYTES } from '../packages/protocol/src/preview-video';
import { sha256 } from '../packages/protocol/src';
import { regularFile } from '../packages/publish/src/project';
import { PublishError, type Recording } from '../packages/publish/src/config';
import { AccountError } from '../packages/identity/src/signer';
import { RUNTIME_PROFILE } from '../packages/runtime/src/capabilities';
import { MAX_PREVIEW_BYTES } from '../packages/protocol/src/preview';
import { localBackend } from './backend';
import { builtConfiguration, executableBytes } from '../packages/publish/src/artifact';

/** Execute only the frozen HTML in our current sandbox. Never run a project's build/preview scripts. */
export async function checkPublication(
  contents: Map<string, Uint8Array>,
  forceScreenshot = false,
  recording?: Recording,
  interactive = false,
  signal?: AbortSignal,
  viewport?: { width: number; height: number },
) {
  if (
    viewport &&
    (!Number.isInteger(viewport.width) ||
      !Number.isInteger(viewport.height) ||
      viewport.width < 200 ||
      viewport.width > 1200 ||
      viewport.height < 160 ||
      viewport.height > 750)
  )
    throw new PublishError(
      'PREVIEW_VIEWPORT',
      'Capture sizes must fit within 200–1200 × 160–750 pixels.',
    );
  const directory = await mkdtemp(join(tmpdir(), 'napplet-publish-check-'));
  let browser: import('@playwright/test').Browser | undefined;
  let server: ReturnType<typeof startPreviewServer> | undefined;
  let backend: Awaited<ReturnType<typeof localBackend>>;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const abort = () => void browser?.close();
  try {
    await builtConfiguration(executableBytes(contents));
    const config = JSON.parse(new TextDecoder().decode(contents.get('napplet.json')));
    if (
      !recording &&
      !forceScreenshot &&
      config.preview?.video &&
      config.preview.video.artifactHash !== (await sha256(executableBytes(contents)))
    )
      throw new PublishError(
        'PREVIEW_VIDEO_STALE',
        'The clip belongs to an older build. Record again or remove preview.video before publishing.',
      );
    await mkdir(join(directory, '.napplet'));
    await materializePreview(directory, contents);
    backend = await localBackend(directory);
    server = startPreviewServer(pathToFileURL(directory + '/'), 0, false, await previewAssets(), {
      network: 'local',
      backend: backend?.provider,
    });
    await installBrowser(undefined, !!recording, interactive);
    signal?.throwIfAborted();
    try {
      const { chromium } = await browserEngine();
      browser = await chromium.launch({ headless: !interactive });
    } catch {
      throw new PublishError(
        'BROWSER_REQUIRED',
        'The check browser could not start. Run soyli doctor; Linux needs the Chromium system libraries. Browser setup is available with soyli browser install.',
      );
    }
    signal?.addEventListener('abort', abort, { once: true });
    const delayMs = config.preview?.delayMs ?? 1500;
    if (!Number.isInteger(delayMs) || delayMs < 250 || delayMs > 10000)
      throw new PublishError('PREVIEW_CONFIG', 'preview.delayMs must be between 250 and 10000.');
    const page = await browser.newPage({
      viewport: { width: 1200, height: 850 },
      deviceScaleFactor: 1,
    });
    page.setDefaultTimeout(5000);
    const errors: string[] = [];
    page.on('pageerror', (error) => {
      if (errors.length < 8) errors.push(redactDiagnostic(error.message));
    });
    await page.addInitScript(() => {
      (window as any).__publishViolations = [];
      document.addEventListener('securitypolicyviolation', (event) =>
        (window as any).__publishViolations.push(event.violatedDirective),
      );
    });
    await page.route('**/*', (route) =>
      new URL(route.request().url()).origin === server!.url.origin
        ? route.continue()
        : route.abort(),
    );
    await page.goto(server.url.href, { waitUntil: 'load', timeout: 10000 });
    await page.waitForFunction(
      () => !!document.querySelector('iframe')?.getAttribute('srcdoc'),
      undefined,
      { timeout: 10000 },
    );
    const iframe = page.locator('iframe');
    if (
      (await iframe.getAttribute('sandbox')) !== 'allow-scripts' ||
      (await iframe.getAttribute('src'))
    )
      throw new Error('The preview iframe did not have the required sandbox.');
    const frame = page.frames().find((frame) => frame.parentFrame());
    if (!frame) throw new Error('The preview iframe was not created.');
    await frame.waitForFunction(() => !!(window as any).napplet?.shell, undefined, {
      timeout: 5000,
    });
    await Promise.race([
      frame.evaluate(() => (window as any).napplet.shell.ready()),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error('Handshake timed out')), 5000);
      }),
    ]);
    await iframe.evaluate(
      (node, size) => {
        node.style.cssText = `position:fixed;top:0;left:0;width:${size.width}px;height:${size.height}px;border:0;display:block;`;
      },
      viewport ?? { width: 1200, height: 750 },
    );
    await frame.waitForFunction(() => document.fonts.status === 'loaded', undefined, {
      timeout: 5000,
    });
    // Engine initialization is separate from the host SHELL handshake. Creators
    // may select a visible/DOM milestone (e.g. Bevy's first rendered scene).
    if (config.preview?.readySelector) {
      try {
        await frame
          .locator(config.preview.readySelector)
          .first()
          .waitFor({ state: 'attached', timeout: 30000 });
      } catch (cause) {
        throw new PublishError(
          'PREVIEW_NOT_READY',
          'The application did not reach preview.readySelector within 30 seconds. Check engine startup, the selector and browser errors before capturing or publishing.',
          'check',
          false,
          errors.length
            ? new AggregateError([new Error(errors.join('; ')), cause], 'Browser startup failed.')
            : cause,
        );
      }
    }
    await page.waitForTimeout(delayMs);
    if (errors.length || (await frame.evaluate(() => (window as any).__publishViolations?.length)))
      throw new Error(
        errors.length
          ? errors.join('; ')
          : 'A content security policy violation occurred in the sandbox.',
      );
    if (interactive) await waitForCapture(page, recording);
    let preview: Uint8Array;
    if (config.preview?.image && !forceScreenshot) {
      const selected = contents.get(config.preview.image);
      if (
        !selected ||
        selected.length > MAX_PREVIEW_BYTES ||
        Buffer.from(selected.subarray(0, 8)).toString('hex') !== '89504e470d0a1a0a'
      )
        throw new PublishError(
          'PREVIEW_IMAGE',
          'preview.image must select a PNG under 5 MiB in the project.',
        );
      const header = Buffer.from(selected);
      if (
        header.length < 24 ||
        header.toString('ascii', 12, 16) !== 'IHDR' ||
        header.readUInt32BE(16) > 4096 ||
        header.readUInt32BE(20) > 4096
      )
        throw new PublishError(
          'PREVIEW_IMAGE',
          'The selected PNG must be no larger than 4096 × 4096.',
        );
      const valid = await page.evaluate(
        async (data) => {
          const image = new Image();
          image.src = data;
          try {
            await image.decode();
          } catch {
            return false;
          }
          return (
            image.naturalWidth > 0 &&
            image.naturalHeight > 0 &&
            image.naturalWidth <= 4096 &&
            image.naturalHeight <= 4096
          );
        },
        `data:image/png;base64,${Buffer.from(selected).toString('base64')}`,
      );
      if (!valid)
        throw new PublishError(
          'PREVIEW_IMAGE',
          'The selected preview must be a valid PNG no larger than 4096 × 4096.',
        );
      preview = selected;
    } else {
      preview = new Uint8Array(await iframe.screenshot({ type: 'png', timeout: 5000 }));
    }
    if (preview.length > MAX_PREVIEW_BYTES)
      throw new PublishError(
        'PREVIEW_IMAGE',
        'The preview exceeds 5 MiB. Choose a smaller PNG with preview.image.',
      );
    let video: Uint8Array | undefined;
    if (recording) {
      // Capture only the verified iframe. The host controls are outside the recording viewport.
      const size = viewport ?? { width: 960, height: 600 };
      await page.setViewportSize(size);
      await iframe.evaluate((node, size) => {
        node.style.width = `${size.width}px`;
        node.style.height = `${size.height}px`;
        node.style.zIndex = '2147483647';
      }, size);
      await page.waitForTimeout((interactive ? 0 : recording.startMs) + 100);
      // Keyboard-first recipes must address the app, not the preview toolbar.
      await iframe.focus();
      const path = join(directory, 'preview.webm');
      await page.screencast.start({ path, size });
      try {
        const start = Date.now();
        const timeline = [
          ...(interactive ? [] : recording.actions),
          ...(forceScreenshot ? [{ type: 'cover' as const, atMs: recording.durationMs / 2 }] : []),
        ];
        for (const action of timeline.sort((a, b) => a.atMs - b.atMs)) {
          await page.waitForTimeout(Math.max(0, start + action.atMs - Date.now()));
          if (action.type === 'cover')
            preview = new Uint8Array(await iframe.screenshot({ type: 'png', timeout: 5000 }));
          else if (action.type === 'click')
            // Saved recipes use the documented 960 × 600 coordinate space.
            await page.mouse.click((action.x * size.width) / 960, (action.y * size.height) / 600);
          else await page.keyboard[action.type === 'keyDown' ? 'down' : 'up'](action.key);
        }
        await page.waitForTimeout(Math.max(0, start + recording.durationMs - Date.now()));
      } finally {
        await page.screencast.stop();
      }
      video = await regularFile(directory, 'preview.webm', MAX_VIDEO_BYTES);
    } else if (config.preview?.video && !forceScreenshot) {
      video = contents.get(config.preview.video.file);
      if (!video) throw new PublishError('PREVIEW_VIDEO', 'The selected preview video is missing.');
    }
    if (preview.length > MAX_PREVIEW_BYTES)
      throw new PublishError('PREVIEW_IMAGE', 'The captured gameplay cover exceeds 5 MiB.');
    if (video) {
      try {
        inspectPreviewVideo(video);
      } catch {
        throw new PublishError(
          'PREVIEW_VIDEO',
          'Use a silent VP8 WebM up to 12 seconds, 1200 × 750 and 5 MiB, or record a new clip.',
        );
      }
      // Decode an actual frame with our cached browser; metadata alone is insufficient.
      const decoded = await page.evaluate(
        async (data) => {
          const v = document.createElement('video');
          v.muted = true;
          v.preload = 'auto';
          try {
            return await new Promise<boolean>((resolve) => {
              const timer = setTimeout(() => resolve(false), 5000);
              v.onloadeddata = () => {
                clearTimeout(timer);
                resolve(v.videoWidth > 0);
              };
              v.onerror = () => {
                clearTimeout(timer);
                resolve(false);
              };
              v.src = data;
            });
          } finally {
            v.removeAttribute('src');
            v.load();
          }
        },
        `data:video/webm;base64,${Buffer.from(video).toString('base64')}`,
      );
      if (!decoded)
        throw new PublishError(
          'PREVIEW_VIDEO',
          'The selected WebM could not be decoded. Record a new clip.',
        );
    }
    if (errors.length || (await frame.evaluate(() => (window as any).__publishViolations?.length)))
      throw new Error(
        errors.length
          ? errors.join('; ')
          : 'A content security policy violation occurred in the sandbox.',
      );
    return { profile: RUNTIME_PROFILE, browser: browser.version(), preview, video };
  } catch (error) {
    if (error instanceof AccountError) throw error;
    throw new PublishError(
      'BROWSER_CHECK',
      'The frozen creation failed the shared sandbox startup check. Run the local preview and fix script or handshake errors before publishing.',
      'check',
      false,
      error,
    );
  } finally {
    signal?.removeEventListener('abort', abort);
    clearTimeout(timer);
    await browser?.close();
    server?.stop(true);
    await backend?.close();
    await rm(directory, { recursive: true, force: true });
  }
}
