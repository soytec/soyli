import shim from '@napplet/shim/prelude.global?raw';
import { IntentWorkspace, intentContracts } from '../../packages/runtime/src/intent-session';
import {
  chooseIntentHandler,
  intentDefaultControls,
} from '../../packages/runtime/src/intent-controls';
import { preparePlayback } from '../../packages/runtime/src/playback';
import { loadArtifact, PLAYER_SANDBOX } from '../../packages/runtime/src';
import { nappletPrelude } from '../../packages/runtime/src/prelude';
import { declaredConfig } from '../../packages/runtime/src/config-schema';
import { attachNappletHost, type HostOptions } from '../../packages/runtime/src/host';
import type { PreviewRevision } from './server';

/** Preview retains source and verified targets in one host-owned workspace. */
export function previewIntents(options: {
  hostOptions(): Omit<HostOptions, 'frame' | 'identity' | 'manifestId'>;
  sourceFrame(): HTMLIFrameElement | undefined;
  signal: AbortSignal;
}) {
  const targets = new Map<
    string,
    { frame: HTMLIFrameElement; host: ReturnType<typeof attachNappletHost>; panel: HTMLElement }
  >();
  let current: PreviewRevision | undefined;
  const status = document.createElement('p');
  status.setAttribute('role', 'status');
  let defaults: Record<string, string> = {};
  try {
    const saved = JSON.parse(localStorage.getItem('soy:preview:intent-defaults') ?? '{}');
    if (saved && typeof saved === 'object' && !Array.isArray(saved))
      defaults = Object.fromEntries(
        Object.entries(saved).filter(
          (entry): entry is [string, string] => typeof entry[1] === 'string',
        ),
      );
  } catch {}
  const workspace = new IntentWorkspace({
    defaults,
    saveDefaults: (value) => {
      try {
        localStorage.setItem('soy:preview:intent-defaults', JSON.stringify(value));
      } catch {
        status.textContent =
          'Handler default applies to this session; browser storage is unavailable.';
      }
    },
    choose: chooseIntentHandler,
    launch: async (entry, behavior, startupSignal) => {
      const launchSignal = startupSignal
        ? AbortSignal.any([options.signal, startupSignal])
        : options.signal;
      if (entry.id === current?.intentCatalogId) {
        workspace.reuseTarget(entry.id);
        if (behavior?.focus !== false) options.sourceFrame()?.focus();
        return;
      }
      if (!entry.manifest) throw new Error('Target has no verified publication.');
      const old = targets.get(entry.id);
      old?.host.close();
      old?.panel.remove();
      targets.delete(entry.id);
      const hash = entry.manifest.tags.find((t) => t[0] === 'x' && t.length === 2)?.[1];
      if (!hash) throw new Error('Target has no standalone artifact.');
      const release = await preparePlayback(entry.manifest, hash);
      const base = options.hostOptions();
      let declaration: ReturnType<typeof declaredConfig> = {};
      const html = await loadArtifact(
        hash,
        launchSignal,
        (verified) => {
          declaration = declaredConfig(verified);
          return nappletPrelude(shim, declaration);
        },
        [...release.servers, ...(base.servers ?? [])],
        base.localServers,
      );
      launchSignal.throwIfAborted();
      const panel = document.createElement('section');
      panel.setAttribute('aria-label', entry.title ?? 'Intent target');
      panel.style.cssText =
        'position:fixed;inset:4vh 3vw;z-index:50;background:var(--background,#151b18);display:flex;flex-direction:column;border:1px solid currentColor';
      const bar = document.createElement('div');
      const label = document.createElement('span');
      label.textContent = entry.title ?? 'Intent target';
      const close = document.createElement('button');
      close.textContent = 'Close napplet';
      close.onclick = () => {
        workspace.dropPending(entry.id);
        targets.get(entry.id)?.host.close();
        targets.delete(entry.id);
        panel.remove();
        options.sourceFrame()?.focus();
      };
      bar.append(label, close);
      const frame = document.createElement('iframe');
      frame.title = entry.title ?? 'Intent target';
      frame.sandbox.value = PLAYER_SANDBOX;
      frame.allow = 'fullscreen';
      frame.referrerPolicy = 'no-referrer';
      frame.style.cssText = 'flex:1;width:100%;border:0';
      frame.srcdoc = html;
      panel.append(bar, frame);
      document.body.append(panel);
      const host = attachNappletHost({
        ...base,
        frame,
        identity: release.hostIdentity,
        manifestId: entry.manifest.id,
        title: entry.title,
        servers: [...release.servers, ...(base.servers ?? [])],
        declaration,
        intent: { workspace, catalogId: entry.id },
      });
      targets.set(entry.id, { frame, host, panel });
      if (behavior?.focus !== false) frame.focus();
    },
    focus: (id) => {
      (id === current?.intentCatalogId ? options.sourceFrame() : targets.get(id)?.frame)?.focus();
    },
    failed: (entry, error) => {
      const target = targets.get(entry.id);
      target?.host.close();
      target?.panel.remove();
      targets.delete(entry.id);
      status.textContent =
        error instanceof Error
          ? `Could not open intent target: ${error.message}`
          : 'Could not open intent target.';
    },
  });
  const controls = intentDefaultControls(workspace);
  const importLabel = document.createElement('label');
  importLabel.textContent = 'Install signed napplet manifest ';
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = '.json,application/json';
  input.setAttribute('aria-label', 'Install signed napplet manifest');
  input.onchange = async () => {
    const file = input.files?.[0];
    if (!file) return;
    try {
      if (file.size > 65536) throw new Error('Manifest is too large.');
      const event = JSON.parse(await file.text());
      const entry = await workspace.install(
        event,
        event.tags?.find((t: string[]) => t[0] === 'title')?.[1],
      );
      status.textContent = `Installed ${entry.title ?? entry.id}.`;
    } catch (error) {
      status.textContent = error instanceof Error ? error.message : 'Could not install manifest.';
    } finally {
      input.value = '';
    }
  };
  importLabel.append(input);
  controls.element.append(importLabel, status);
  document.querySelector('#network-settings')?.after(controls.element);
  options.signal.addEventListener(
    'abort',
    () => {
      controls.close();
      controls.element.remove();
      for (const target of targets.values()) {
        target.host.close();
        target.panel.remove();
      }
      targets.clear();
    },
    { once: true },
  );
  return {
    workspace,
    update(info: PreviewRevision) {
      current = info;
      workspace.register({
        id: info.intentCatalogId,
        title: info.title,
        contracts: intentContracts(info.intentTags),
      });
    },
    updateIdentity(pubkey: string | null) {
      for (const target of targets.values()) target.host.updateIdentity(pubkey);
    },
  };
}
