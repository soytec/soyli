import type { Page } from '@playwright/test';
import { PublishError, type Recording } from '../packages/publish/src/config';

/** Let the creator reach the interesting moment before the existing capture encoder starts. */
export async function waitForCapture(page: Page, recording?: Recording) {
  const iframe = page.locator('iframe');
  if (recording) {
    await page.setViewportSize({ width: 960, height: 690 });
    await iframe.evaluate((node) => {
      node.style.width = '960px';
      node.style.height = '600px';
    });
  }
  let ready!: () => void;
  const pressed = new Promise<void>((resolve) => {
    ready = resolve;
  });
  await page.exposeFunction('soyliCaptureReady', ready);
  await page.evaluate(
    ({ video, height, seconds }) => {
      const bar = document.createElement('div');
      bar.style.cssText = `position:fixed;left:0;right:0;top:${height}px;padding:16px;background:#e7ecd9;z-index:9999;display:flex;gap:16px;align-items:center`;
      const button = document.createElement('button');
      button.textContent = video ? `Record the next ${seconds} seconds` : 'Capture this moment';
      button.style.cssText =
        'padding:10px 16px;background:#293124;color:white;border:0;border-radius:6px;cursor:pointer';
      button.onclick = () => {
        bar.remove();
        (window as any).soyliCaptureReady();
      };
      const help = document.createElement('span');
      help.textContent = 'Play first. Capture when something happens. Close this window to cancel.';
      bar.append(button, help);
      document.body.append(bar);
    },
    {
      video: !!recording,
      height: recording ? 600 : 750,
      seconds: (recording?.durationMs ?? 6000) / 1000,
    },
  );
  let wait: ReturnType<typeof setTimeout> | undefined;
  let cancel!: () => void;
  try {
    await Promise.race([
      pressed,
      new Promise<never>((_, reject) => {
        cancel = () =>
          reject(
            new PublishError(
              'CAPTURE_CANCELLED',
              'Capture cancelled. Your existing files were preserved.',
            ),
          );
        page.once('close', cancel);
        if (page.isClosed()) cancel();
        wait = setTimeout(
          () =>
            reject(
              new PublishError(
                'CAPTURE_EXPIRED',
                'Capture session expired after five minutes. Start a new capture.',
              ),
            ),
          5 * 60000,
        );
      }),
    ]);
  } finally {
    clearTimeout(wait);
    if (cancel) page.off('close', cancel);
  }
}
