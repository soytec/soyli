import type { ListingPreview } from './listing';

export function setupListing(signal: AbortSignal) {
  const panel = document.querySelector<HTMLElement>('#listing')!;
  const content = document.querySelector<HTMLElement>('#listing-content')!;
  const play = document.querySelector<HTMLButtonElement>('#view-play')!;
  const listing = document.querySelector<HTMLButtonElement>('#view-listing')!;
  const stage = document.querySelector<HTMLElement>('#stage')!;
  const capture = document.querySelector<HTMLButtonElement>('#capture')!;
  const recording = document.querySelector<HTMLFieldSetElement>('#recording-controls')!;
  const record = document.querySelector<HTMLButtonElement>('#record-video')!;
  const startInput = document.querySelector<HTMLInputElement>('#record-start')!;
  const durationInput = document.querySelector<HTMLInputElement>('#record-duration')!;
  let actions: ListingPreview['recording']['actions'] = [];
  const status = document.querySelector<HTMLElement>('#listing-status')!;
  let shown = '',
    running = false;
  const element = <K extends keyof HTMLElementTagNameMap>(tag: K, text = '', className = '') => {
    const node = document.createElement(tag);
    node.textContent = text;
    node.className = className;
    return node;
  };
  function render(data: ListingPreview) {
    capture.hidden = !data.captureAvailable;
    recording.hidden = !data.recordingAvailable;
    startInput.value = String(data.recording.startMs / 1000);
    durationInput.value = String(data.recording.durationMs / 1000);
    actions = data.recording.actions;
    const card = element('article', '', 'listing-card');
    if (data.image) {
      const img = element('img');
      img.src = data.image.url;
      img.alt = `Screenshot for ${data.title}`;
      img.onerror = () => {
        status.textContent = 'The selected image could not be decoded. Capture a new screenshot.';
      };
      card.append(element('p', 'Static cover', 'preview-media-label'), img);
    } else card.append(element('div', 'Your screenshot goes here', 'listing-placeholder'));
    if (data.video) {
      const clip = element('video');
      clip.src = data.video.url;
      clip.controls = true;
      clip.muted = true;
      clip.playsInline = true;
      clip.preload = 'metadata';
      if (data.image) clip.poster = data.image.url;
      clip.setAttribute('aria-label', `Preview clip for ${data.title}`);
      clip.onerror = () => {
        status.textContent = 'The clip could not be played. Record a new WebM.';
      };
      card.append(element('p', 'Preview clip', 'preview-media-label'), clip);
    }
    const caption = element('div', '', 'listing-caption');
    caption.append(
      element('p', data.topics.map((t) => `#${t}`).join(' · ') || 'No tags yet', 'muted'),
      element('h1', data.title),
      element('p', data.description || 'Add a description in napplet.json.'),
      element('p', data.creator ?? 'Creator identity not selected', 'listing-key'),
    );
    card.append(caption);
    const checks = element('section', '', 'listing-checks');
    checks.append(element('h2', 'Before you publish'));
    const list = element('ul');
    for (const warning of data.warnings) list.append(element('li', warning));
    if (!data.warnings.length)
      list.append(element('li', 'Title, description, tags, creator and screenshot are present.'));
    checks.append(
      list,
      element(
        'p',
        'Review the screenshot after changing your app. Capture saves a new PNG and selects it in napplet.json; earlier images are preserved.',
        'muted',
      ),
      element(
        'p',
        'This is a local draft. Run soyli check for the build and image validation, then soyli publish when ready.',
        'muted',
      ),
    );
    const details = element('section', '', 'listing-details');
    details.append(element('h2', 'Posting details'));
    const dl = element('dl');
    const fields: [string, string][] = [
      ['Project name', data.name],
      ['Identifier', data.identifier],
      ['License', data.license],
      [
        'Built app',
        data.artifact
          ? `${data.artifact.bytes.toLocaleString()} bytes · ${data.artifact.hash}`
          : 'Not built',
      ],
      [
        'Screenshot',
        data.image
          ? `${data.image.file} · ${data.image.width} × ${data.image.height}`
          : 'Automatic capture on publish',
      ],
      [
        'Preview clip',
        data.video
          ? `${data.video.file} · ${(data.video.durationMs / 1000).toFixed(1)} seconds · ${(data.video.bytes / 1024).toFixed(0)} KB${data.video.stale ? ' · older build' : ''}`
          : 'Optional; record one above',
      ],
      ['Network', data.network],
      ['Listing relay', data.targets.relay],
      ['Mirror relays', data.targets.mirrors.join('\n') || 'None'],
      ['Assets / Blossom', data.targets.blossom],
      ['Source / Git', data.targets.grasp],
      ['Website', data.targets.site],
      ['Required capabilities', data.runtime.requires.join(', ') || 'None'],
      ['Optional capabilities', data.runtime.optionalDomains.join(', ') || 'None'],
      ['Archetypes', data.discovery.archetypes.join(', ') || 'None'],
      [
        'Accepted intents',
        data.discovery.intents.map((i) => [i.intent, ...i.parameters].join(' ')).join('\n') ||
          'None',
      ],
      ['Icon', data.discovery.icon?.file ?? 'Generic artwork'],
      [
        'User settings',
        data.runtime.configuration
          ? `${data.runtime.configuration.properties} top-level properties${data.runtime.configuration.version !== null ? ` · schema version ${data.runtime.configuration.version}` : ''}. Open Settings to try them.`
          : 'No static settings schema in this build',
      ],
      ['Runtime relays', data.runtime.relays.join('\n') || 'Host defaults'],
      ['Runtime servers', data.runtime.servers.join('\n') || 'None'],
    ];
    for (const [label, value] of fields) dl.append(element('dt', label), element('dd', value));
    details.append(
      dl,
      element(
        'p',
        'Edit publish.networks in napplet.json to change destinations. Command-line publish flags override this preview.',
        'muted',
      ),
    );
    const names = element('section', '', 'listing-details');
    names.append(
      element('h2', 'Give it a readable link'),
      element(
        'p',
        'After publishing, open the napplet page, connect the same creator account and choose Named link. Claim /@your-handle/your-slug once; it will follow future releases. Publishing does not claim a name automatically.',
      ),
    );
    if (data.page) {
      const a = element('a', 'Open napplet page ↗');
      a.href = data.page;
      a.target = '_blank';
      a.rel = 'noopener noreferrer';
      names.append(a);
    }
    content.replaceChildren(card, checks, details, names);
  }
  async function refresh() {
    if (!panel.hidden && !running) {
      try {
        const response = await fetch('/listing', { cache: 'no-store', signal });
        const data = await response.json();
        if (!response.ok) throw new Error(data.error ?? 'Cannot read the listing.');
        const serialized = JSON.stringify(data);
        if (shown !== serialized) {
          render(data);
          shown = serialized;
        }
      } catch (error) {
        status.textContent = error instanceof Error ? error.message : 'Listing unavailable.';
      }
    }
  }
  const select = (value: boolean) => {
    if (!value) panel.querySelectorAll('video').forEach((v) => v.pause());
    panel.hidden = !value;
    stage.hidden = value;
    play.setAttribute('aria-pressed', String(!value));
    listing.setAttribute('aria-pressed', String(value));
    if (value) void refresh();
  };
  play.onclick = () => select(false);
  listing.onclick = () => select(true);
  const live = document.querySelector<HTMLInputElement>('#capture-live')!;
  capture.onclick = async () => {
    record.disabled = true;
    capture.disabled = true;
    running = true;
    status.textContent = live.checked
      ? 'Opening a capture window. Play, then choose Capture this moment. Close that window to cancel.'
      : 'Capturing the built app… Chromium is downloaded on first use if needed.';
    try {
      const response = await fetch(live.checked ? '/listing/capture-live' : '/listing/capture', {
        method: 'POST',
        signal,
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error ?? 'Capture failed.');
      status.textContent = 'Screenshot saved and selected. Inspect it below before publishing.';
      shown = '';
    } catch (error) {
      status.textContent = error instanceof Error ? error.message : 'Capture failed.';
    } finally {
      capture.disabled = false;
      record.disabled = false;
      running = false;
      void refresh();
    }
  };
  record.onclick = async () => {
    if (!startInput.reportValidity() || !durationInput.reportValidity()) return;
    recording.disabled = true;
    capture.disabled = true;
    running = true;
    record.textContent = 'Recording…';
    status.textContent = live.checked
      ? 'Opening a capture window. Play, then start recording when ready. Close that window to cancel.'
      : 'Recording a fresh run of the built app. Timed clicks and keys can be set in preview.recording.actions in napplet.json.';
    try {
      const response = await fetch(live.checked ? '/listing/record-live' : '/listing/record', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          startMs: Number(startInput.value) * 1000,
          durationMs: Number(durationInput.value) * 1000,
          actions,
        }),
        signal,
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error ?? 'Recording failed.');
      status.textContent = 'Clip saved and selected. Play it below to review before publishing.';
      shown = '';
    } catch (error) {
      status.textContent = error instanceof Error ? error.message : 'Recording failed.';
    } finally {
      recording.disabled = false;
      capture.disabled = false;
      running = false;
      record.textContent = 'Record clip';
      void refresh();
    }
  };
  document.addEventListener(
    'visibilitychange',
    () => {
      if (document.hidden) panel.querySelectorAll('video').forEach((v) => v.pause());
    },
    { signal },
  );
  const timer = setInterval(() => void refresh(), 1500);
  signal.addEventListener('abort', () => clearInterval(timer), { once: true });
}
