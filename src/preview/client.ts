import { previewIntents } from './intent-client';
import { AppearanceControl } from '../../packages/runtime/src/appearance-control';
import { shellTheme } from '../../packages/runtime/src/appearance';
import type { ExtensionSigner } from 'applesauce-signers';
import { setupManager } from './manager-client';
import shim from '@napplet/shim/prelude.global?raw';
import { loadArtifact, PLAYER_SANDBOX } from '../../packages/runtime/src';
import { nappletPrelude } from '../../packages/runtime/src/prelude';
import { missingDomains } from '../../packages/runtime/src/capabilities';
import { attachNappletHost, type HostPrompt } from '../../packages/runtime/src/host';
import type { ExportFile } from '../../packages/runtime/src/filesystem';
import type { PreviewRevision } from './server';
import { setupListing } from './listing-client';
import { setupDiagnostics } from './diagnostics';
import { setupControllers } from './controllers';
import { createRoot } from 'react-dom/client';
import { createElement } from 'react';
import { SettingsControl } from '../../packages/runtime/src/settings-panel';
import { MediaControls } from '../../packages/runtime/src/media-controls';
import { declaredConfig } from '../../packages/runtime/src/config-schema';
import { MultiplayerSettings } from '../../packages/runtime/src/multiplayer-settings';

createRoot(document.querySelector('#appearance')!).render(createElement(AppearanceControl));

const stage = document.querySelector<HTMLElement>('#stage')!;
const status = document.querySelector<HTMLElement>('#status')!;
const dialog = document.querySelector<HTMLDialogElement>('#prompt')!;
const detail = document.querySelector<HTMLElement>('#prompt-detail')!;
const confirm = document.querySelector<HTMLButtonElement>('#confirm')!;
const cancel = document.querySelector<HTMLButtonElement>('#cancel')!;
const later = document.querySelector<HTMLButtonElement>('#later')!;
const link = document.querySelector<HTMLAnchorElement>('#open-link')!;
const exports = document.querySelector<HTMLElement>('#files')!;
const settingsRoot = createRoot(document.querySelector('#settings')!);
const mediaRoot = createRoot(document.querySelector('#media')!);
const networkRoot = createRoot(document.querySelector('#network-settings')!);
networkRoot.render(createElement(MultiplayerSettings));
let settingsOpen = false;
function settingsChanged(open: boolean) {
  settingsOpen = open;
  if (frame) frame.inert = choice !== null || open;
}
let host: ReturnType<typeof attachNappletHost> | undefined;
let frame: HTMLIFrameElement | undefined;
let choice: HostPrompt | null = null;
let urls: string[] = [];
let loaded = '';
let pubkey: string | null = null;
let viewerSigner: ExtensionSigner | undefined;
const lifetime = new AbortController();
let previewInfo: PreviewRevision | undefined;
const intents = previewIntents({
  signal: lifetime.signal,
  sourceFrame: () => frame,
  hostOptions: () => ({
    theme: shellTheme,
    relays: previewInfo?.relays ?? [],
    servers: previewInfo?.servers ?? [],
    localServers: previewInfo?.servers ?? [],
    uploadServers: previewInfo?.uploadServers ?? [],
    backend: previewInfo?.backend,
    pubkey,
    sign: async (key, template) => {
      const signer = viewerSigner;
      if (!signer || pubkey !== key) throw new Error('Identity changed');
      const event = await signer.signEvent(template);
      if (signer !== viewerSigner || pubkey !== key) throw new Error('Identity changed');
      return event;
    },
    prompt: showPrompt,
    files: showFiles,
  }),
});
setupListing(lifetime.signal);
setupManager(lifetime.signal);
const diagnostics = () => host?.diagnostics() ?? Promise.resolve([]);
setupDiagnostics(diagnostics, lifetime.signal);
setupControllers(lifetime.signal);
// Only the trusted local preview/scenario runner can access this opaque-frame parent.
Object.assign(window, { soyliPreview: { diagnostics } });

const filePicker = document.createElement('input');
filePicker.type = 'file';
filePicker.setAttribute('aria-label', 'Choose files for napplet');
filePicker.hidden = true;
detail.after(filePicker);
detail.style.whiteSpace = 'pre-wrap';
detail.style.overflowWrap = 'anywhere';
detail.style.maxHeight = '50vh';
detail.style.overflowY = 'auto';
filePicker.onchange = () => choice?.selectFiles?.(Array.from(filePicker.files ?? []));
function showPrompt(prompt: HostPrompt | null) {
  choice = prompt;
  filePicker.value = '';
  filePicker.hidden = !prompt?.picker;
  filePicker.accept = prompt?.picker?.accept ?? '';
  filePicker.multiple = prompt?.picker?.multiple ?? false;
  if (prompt?.picker?.directory) filePicker.setAttribute('webkitdirectory', '');
  else filePicker.removeAttribute('webkitdirectory');
  if (frame) frame.inert = prompt !== null || settingsOpen;
  if (!prompt) {
    dialog.close();
    return;
  }
  detail.textContent =
    prompt.kind === 'save'
      ? `Save ${prompt.value}? It will appear below for download.`
      : prompt.value;
  confirm.hidden = prompt.kind === 'link' || prompt.kind === 'files';
  confirm.textContent =
    prompt.kind === 'action'
      ? 'Approve & publish'
      : prompt.kind === 'upload'
        ? 'Approve upload'
        : prompt.kind === 'media'
          ? 'Play audio'
          : prompt.kind === 'multiplayer'
            ? 'Allow'
            : prompt.kind === 'network'
              ? 'Connect'
              : 'Save file';
  cancel.textContent = prompt.kind === 'multiplayer' ? 'Block' : 'Cancel';
  later.hidden = prompt.kind !== 'multiplayer';
  link.hidden = prompt.kind !== 'link';
  if (prompt.kind === 'link') link.href = prompt.value;
  if (!dialog.open) dialog.showModal();
  cancel.focus();
}
confirm.onclick = () => choice?.answer(true);
cancel.onclick = () => choice?.answer(false);
later.onclick = () => choice?.dismiss();
link.onclick = () => choice?.answer(true);
dialog.oncancel = (event) => {
  event.preventDefault();
  choice?.dismiss();
};

function showFiles(files: ExportFile[]) {
  urls.forEach((url) => URL.revokeObjectURL(url));
  urls = [];
  exports.replaceChildren(
    ...files.map((file) => {
      const a = document.createElement('a');
      a.href = URL.createObjectURL(file.blob);
      urls.push(a.href);
      a.download = file.name.split('/').pop()!;
      a.textContent = `${file.name} ↓`;
      return a;
    }),
  );
}
const connect = document.querySelector<HTMLButtonElement>('#connect')!;
connect.onclick = async () => {
  connect.disabled = true;
  try {
    if (pubkey) {
      pubkey = null;
      viewerSigner = undefined;
    } else {
      const { ExtensionSigner } = await import('applesauce-signers');
      const signer = new ExtensionSigner();
      const key = await signer.getPublicKey();
      if (!/^[a-f0-9]{64}$/.test(key))
        throw new Error('The extension returned an invalid public key.');
      pubkey = key;
      viewerSigner = signer;
    }
    host?.updateIdentity(pubkey);
    intents.updateIdentity(pubkey);
    connect.textContent = pubkey ? 'Disconnect' : 'Connect browser extension';
    status.textContent = pubkey ? 'Connected' : 'Guest preview';
  } catch {
    status.textContent = 'Could not connect. Unlock a Nostr browser extension and try again.';
  } finally {
    connect.disabled = false;
  }
};
document.querySelector<HTMLButtonElement>('#reload')!.onclick = () => {
  loaded = '';
};
async function refresh() {
  try {
    const response = await fetch(new URL('revision', location.href), {
      cache: 'no-store',
      signal: lifetime.signal,
    });
    const info: PreviewRevision & { error?: string } = await response.json();
    if (!response.ok) throw new Error(info.error ?? 'Could not read local source.');
    if (info.id === loaded) return;
    previewInfo = info;
    intents.update(info);
    host?.close();
    host = undefined;
    stage.replaceChildren();
    frame = undefined;
    loaded = info.id;
    status.textContent = 'Verifying preview…';
    const missing = missingDomains(info.requires);
    if (missing.length) throw new Error(`Unsupported required capabilities: ${missing.join(', ')}`);
    let declaration: ReturnType<typeof declaredConfig> = {};
    const doc = await loadArtifact(
      info.artifactHash,
      lifetime.signal,
      (verifiedHtml) => {
        declaration = declaredConfig(verifiedHtml);
        return nappletPrelude(shim, declaration);
      },
      {
        localUrl: new URL(`artifacts/${info.artifactHash}`, location.href).href,
        credentials: 'same-origin',
      },
    );
    frame = document.createElement('iframe');
    frame.title = 'Your napplet';
    frame.sandbox.value = PLAYER_SANDBOX;
    frame.allow = 'fullscreen';
    frame.referrerPolicy = 'no-referrer';
    frame.srcdoc = doc;
    // Attach before the child's bootstrap can post shell.ready.
    stage.replaceChildren(frame);
    host = attachNappletHost({
      intent: { workspace: intents.workspace, catalogId: info.intentCatalogId },
      theme: shellTheme,
      backend: info.backend,
      backendIdentity: info.backendIdentity,
      backendAliases: info.backendAliases,
      media: (session) =>
        mediaRoot.render(session ? createElement(MediaControls, { media: session }) : null),
      frame,
      identity: info.hostIdentity,
      manifestId: info.id,
      relays: info.relays,
      servers: info.servers,
      uploadServers: info.uploadServers,
      title: 'Local preview',
      sign: async (key, template) => {
        const signer = viewerSigner;
        if (!signer || pubkey !== key) throw new Error('Identity changed');
        const event = await signer.signEvent(template);
        if (signer !== viewerSigner || pubkey !== key) throw new Error('Identity changed');
        return event;
      },
      localServers: info.servers,
      pubkey,
      prompt: showPrompt,
      files: showFiles,
      declaration,
      configuration: (session) =>
        settingsRoot.render(
          session
            ? createElement(SettingsControl, {
                session,
                title: 'Local preview',
                onOpenChange: settingsChanged,
              })
            : null,
        ),
    });
    status.textContent = 'Local preview · saved changes reload automatically';
  } catch (error) {
    host?.close();
    host = undefined;
    stage.replaceChildren();
    frame = undefined;
    // Retrying is safe and lets transient errors recover without another source edit.
    loaded = '';
    status.textContent = error instanceof Error ? error.message : 'Preview unavailable.';
  } finally {
    if (!lifetime.signal.aborted) setTimeout(() => void refresh(), 700);
  }
}
window.addEventListener('pagehide', () => {
  lifetime.abort();
  host?.close();
  settingsRoot.unmount();
  mediaRoot.unmount();
  networkRoot.unmount();
  showFiles([]);
});
void refresh();
