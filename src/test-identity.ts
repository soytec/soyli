import type { Page } from '@playwright/test';
import { finalizeEvent, generateSecretKey, getPublicKey, type EventTemplate } from 'nostr-tools';

/** A disposable viewer, never a CLI account. Signing is confined to the local host frame. */
export async function connectTestIdentity(page: Page, origin: string) {
  const url = new URL(origin);
  if (
    url.protocol !== 'http:' ||
    url.hostname !== '127.0.0.1' ||
    new URL(page.url()).origin !== url.origin
  )
    throw new Error('Test identities require the runner-owned loopback preview.');
  const key = generateSecretKey(),
    pubkey = getPublicKey(key);
  const binding = '__soyliTestIdentity';
  await page.exposeBinding(binding, ({ frame }, event?: EventTemplate) => {
    if (frame !== page.mainFrame() || new URL(frame.url()).origin !== url.origin)
      throw new Error('Only the local preview host may use a test identity.');
    if (!event) return pubkey;
    if (
      event.kind !== 1 ||
      !event.tags.some((t) => t[0] === 't' && t[1] === 'soy-backend-authorization-v1') ||
      JSON.parse(event.content).operation !== 'sessionBind'
    )
      throw new Error('The test identity only signs backend account session proofs.');
    return finalizeEvent(event, key);
  });
  await page.evaluate((binding) => {
    const w = window as any;
    w.nostr = {
      getPublicKey: () => w[binding](),
      signEvent: (event: unknown) => w[binding](event),
    };
  }, binding);
  await page.locator('#connect').click();
  await page.getByRole('button', { name: 'Disconnect', exact: true }).waitFor();
  return { pubkey };
}

export async function approveTestBackendAccount(page: Page, module: string, provider: string) {
  if (!/^[a-z][a-z0-9-]{0,47}$/.test(module)) throw new Error('Choose a backend module name.');
  // Match the specific account prompt, never click through upload/payment/other dialogs.
  const dialog = page
    .locator('#prompt[open]')
    .filter({
      hasText: `Use your signed-in Nostr identity for saved worlds and actions in ${module} on backend ${provider.slice(0, 12)}?`,
    });
  await dialog.locator('#confirm').click();
}
