import type { manageProject } from '../manager';
import { setupWorkshop } from './workshop-client';
type State = Awaited<ReturnType<typeof manageProject>>;
const el = <K extends keyof HTMLElementTagNameMap>(name: K, text = '', className = '') => {
  const node = document.createElement(name);
  node.textContent = text;
  node.className = className;
  return node;
};
export function setupManager(signal: AbortSignal) {
  const root = document.querySelector<HTMLElement>('#manager')!;
  const status = el(
    'p',
    'Edits are saved to your project files. Nothing is published.',
    'manager-status',
  );
  status.setAttribute('role', 'status');
  const content = el('div', '', 'manager-content');
  root.append(status, content);
  const headers = {
    'X-Soyli-Token': document.querySelector<HTMLMetaElement>('meta[name=soyli-token]')!.content,
  };
  let state: State | undefined;
  async function request(action?: unknown) {
    const response = await fetch('/manager', {
      signal,
      cache: 'no-store',
      headers: { ...headers, ...(action ? { 'Content-Type': 'application/json' } : {}) },
      ...(action ? { method: 'POST', body: JSON.stringify(action) } : {}),
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error ?? 'Cannot update this project.');
    state = data;
    return data as State;
  }
  async function save(action: Record<string, unknown>, button: HTMLButtonElement) {
    const label = button.textContent;
    button.disabled = true;
    button.textContent = 'Saving…';
    try {
      render(await request({ ...action, revision: state!.revision }));
      status.textContent = 'Saved to project files. Rebuild and check before publishing.';
    } catch (error) {
      status.textContent = error instanceof Error ? error.message : 'Save failed.';
    } finally {
      button.disabled = false;
      button.textContent = label;
    }
  }
  function field(parent: HTMLElement, label: string, value: string, multiline = false) {
    const wrapper = el('label', label);
    const input = multiline ? el('textarea') : el('input');
    input.value = value;
    wrapper.append(input);
    parent.append(wrapper);
    return input;
  }
  function section(title: string, description: string) {
    const card = el('section', '', 'manager-section');
    card.append(el('h2', title), el('p', description, 'muted'));
    return card;
  }
  function render(data: State) {
    const project = section(
      'Make it yours.',
      'Name, description and tags travel with your source. Your publication identity stays the same.',
    );
    const form = el('form', '', 'manager-form');
    const name = field(form, 'Project name', data.project.name),
      title = field(form, 'Display title', data.project.title),
      description = field(form, 'Description', data.project.description, true),
      topics = field(form, 'Tags · comma separated', data.project.topics.join(', ')),
      license = field(form, 'Project license', data.project.license);
    const metadata = el('details');
    metadata.append(el('summary', 'Capabilities and discovery'));
    metadata.append(
      el(
        'p',
        'Describe what your napplet supports. Optional integrations and discovery labels never grant permissions.',
        'muted',
      ),
    );
    const requires = field(
        metadata,
        'Required domains · comma separated',
        data.project.requires.join(', '),
      ),
      optionalDomains = field(
        metadata,
        'Optional domains · comma separated',
        data.project.optionalDomains.join(', '),
      ),
      archetypes = field(
        metadata,
        'Archetypes · comma separated',
        data.project.archetypes.join(', '),
      ),
      intents = field(
        metadata,
        'Accepted intents · one per line, followed by parameter names',
        data.project.intents.map((i) => [i.intent, ...i.parameters].join(' ')).join('\n'),
        true,
      ),
      icon = field(
        metadata,
        'Icon · project file (PNG, JPEG or WebP)',
        data.project.icon?.file ?? '',
      );
    intents.placeholder = 'napplet:track/edit track mode';
    icon.placeholder = 'assets/icon.png';
    form.append(metadata);
    const commaList = (value: string) =>
      value
        .split(',')
        .map((v) => v.trim())
        .filter(Boolean);
    const saveProject = el('button', 'Save project');
    saveProject.type = 'submit';
    form.append(saveProject);
    form.onsubmit = (e) => {
      e.preventDefault();
      void save(
        {
          action: 'project',
          changes: {
            name: name.value,
            title: title.value,
            description: description.value,
            topics: topics.value
              .split(',')
              .map((x) => x.trim().replace(/^#/, ''))
              .filter(Boolean),
            license: license.value,
            requires: commaList(requires.value),
            optionalDomains: commaList(optionalDomains.value),
            archetypes: commaList(archetypes.value),
            intents: intents.value
              .split('\n')
              .map((line) => line.trim())
              .filter(Boolean)
              .map((line) => {
                const [intent, ...parameters] = line.split(/\s+/);
                return { intent, parameters };
              }),
            icon: icon.value.trim() ? { file: icon.value.trim() } : null,
          },
        },
        saveProject,
      );
    };
    project.append(form);
    const assets = section(
      'The asset cupboard.',
      'Media, fonts, JSON, text and binary data packs. Originals stay in Git; external runtime copies go to your chosen Blossom server when you publish.',
    );
    assets.append(
      el(
        'p',
        `${(data.storage.used / 1048576).toFixed(1)} / 32 MiB managed assets · 10 MiB per resource · 40 MiB source budget`,
        'manager-budget',
      ),
    );
    const upload = el('form', '', 'manager-form');
    const fileLabel = el('label', 'Choose a file');
    const file = el('input');
    file.type = 'file';
    file.required = true;
    fileLabel.append(file);
    upload.append(fileLabel);
    const id = field(upload, 'Asset name · e.g. jump-sound', '');
    id.required = true;
    id.setAttribute('pattern', '[a-z][a-z0-9-]{0,47}');
    const licenseField = field(upload, 'Asset license / attribution', data.project.license);
    const source = field(upload, 'Original source or credit', '');
    const label = el('label', 'Storage');
    const storage = el('select');
    for (const [value, text] of [
      ['external', 'Blossom · load when needed'],
      ['embedded', 'Embedded · small files inside the app'],
    ]) {
      const option = el('option', text);
      option.value = value;
      storage.append(option);
    }
    label.append(storage);
    upload.append(label);
    const add = el('button', 'Add asset');
    upload.append(add);
    upload.onsubmit = async (e) => {
      e.preventDefault();
      const selected = file.files?.[0];
      if (!selected) return;
      if (selected.size > 10 * 1048576) {
        status.textContent = 'This resource exceeds the current 10 MiB runtime limit.';
        return;
      }
      const buffer = new Uint8Array(await selected.arrayBuffer());
      let binary = '';
      for (let i = 0; i < buffer.length; i += 8192)
        binary += String.fromCharCode(...buffer.subarray(i, i + 8192));
      await save(
        {
          action: 'asset',
          id: id.value,
          storage: storage.value,
          license: licenseField.value,
          source: source.value,
          data: btoa(binary),
        },
        add,
      );
    };
    assets.append(upload);
    const grid = el('div', '', 'asset-grid');
    for (const asset of data.assets) {
      const card = el('article', '', 'asset-card');
      if (!asset.error && /^(image|audio|video)\//.test(asset.mime)) {
        const media = el(
          asset.mime.startsWith('image/')
            ? 'img'
            : asset.mime.startsWith('audio/')
              ? 'audio'
              : 'video',
        );
        media.src = asset.url;
        if (media instanceof HTMLImageElement) {
          media.alt = asset.id;
          media.loading = 'lazy';
        } else {
          media.controls = true;
          media.preload = 'metadata';
        }
        card.append(media);
      } else
        card.append(el('div', asset.mime.startsWith('font/') ? 'Aa' : '◇', 'asset-placeholder'));
      card.append(
        el('h3', asset.id),
        el('p', `${(asset.bytes / 1024).toFixed(1)} KB · ${asset.mime}`, 'muted'),
        el('code', asset.path),
        el('p', asset.error ?? asset.destination, 'asset-destination'),
        el('p', asset.license),
      );
      const toggle = el('button', asset.storage === 'external' ? 'Embed instead' : 'Use Blossom');
      toggle.onclick = () =>
        void save(
          {
            action: 'asset-update',
            id: asset.id,
            storage: asset.storage === 'external' ? 'embedded' : 'external',
            license: asset.license,
            source: asset.source,
          },
          toggle,
        );
      const remove = el('button', 'Unlist');
      remove.title = 'Remove from the inventory; preserve original files and published bytes.';
      remove.onclick = () => void save({ action: 'asset-remove', id: asset.id }, remove);
      const credits = el('details');
      credits.append(el('summary', 'Edit credits'));
      const creditForm = el('form');
      const creditLicense = field(creditForm, 'License / attribution', asset.license);
      const creditSource = field(creditForm, 'Source / credit', asset.source);
      const creditSave = el('button', 'Save credits');
      creditForm.append(creditSave);
      creditForm.onsubmit = (e) => {
        e.preventDefault();
        void save(
          {
            action: 'asset-update',
            id: asset.id,
            storage: asset.storage,
            license: creditLicense.value,
            source: creditSource.value,
          },
          creditSave,
        );
      };
      credits.append(creditForm);
      card.append(toggle, remove, credits);
      grid.append(card);
    }
    assets.append(
      grid,
      el(
        'p',
        "Import assetUrl from '../soy-assets.js' for media, or assetBlob for data: await (await assetBlob('game-pack')).arrayBuffer(). Rebuild after inventory changes.",
        'manager-recipe',
      ),
    );
    const presentation = section(
      'Choose the invitation.',
      'Capture in Listing, then select a cover or clip here. Previous captures are preserved.',
    );
    const choices = el('div', '', 'manager-form');
    for (const kind of ['image', 'video'] as const) {
      const label = el('label', kind === 'image' ? 'Cover image' : 'Preview clip');
      const choice = el('select');
      const none = el('option', kind === 'image' ? 'Automatic screenshot on publish' : 'No video');
      none.value = '';
      choice.append(none);
      const selected = kind === 'image' ? data.preview.image : data.preview.video?.file;
      for (const path of new Set([
        ...[
          ...data.presentation.filter((x) => x.endsWith(kind === 'image' ? '.png' : '.webm')),
          ...(kind === 'image'
            ? data.assets.filter((a) => a.mime === 'image/png').map((a) => a.path)
            : []),
        ],
        ...(selected ? [selected] : []),
      ])) {
        const option = el('option', path);
        option.value = path;
        choice.append(option);
      }
      choice.value = selected ?? '';
      label.append(choice);
      const select = el('button', 'Use selection');
      select.onclick = () =>
        void save({ action: 'select', kind, file: choice.value || null }, select);
      choices.append(label, select);
    }
    const captures = el('div', '', 'asset-grid');
    for (const path of data.presentation) {
      const card = el('article', '', 'asset-card');
      const isImage = path.endsWith('.png');
      const media = isImage ? el('img') : el('video');
      media.src = '/manager/presentation?file=' + encodeURIComponent(path);
      if (media instanceof HTMLImageElement) {
        media.alt = path;
        media.loading = 'lazy';
      } else {
        media.controls = true;
        media.preload = 'metadata';
      }
      const choose = el('button', isImage ? 'Use as cover' : 'Use as clip');
      choose.onclick = () =>
        void save({ action: 'select', kind: isImage ? 'image' : 'video', file: path }, choose);
      card.append(media, el('p', path), choose);
      captures.append(card);
    }
    const captureLink = el('button', 'Open capture controls');
    captureLink.onclick = () => document.getElementById('view-listing')!.click();
    presentation.append(choices, captures, captureLink);
    const destinations = section(
      'Where it goes.',
      'These destinations are local to your checkout. A new destination applies to new publications; pending releases retain their saved targets.',
    );
    const targetForm = el('form', '', 'manager-form');
    const inputs = new Map<string, HTMLInputElement | HTMLTextAreaElement>();
    for (const [key, label] of [
      ['blossom', 'Assets · Blossom'],
      ['relay', 'Listing · Nostr relay'],
      ['grasp', 'Source · GRASP'],
      ['site', 'Website'],
      ['mirrors', 'Extra relay copies · one per line'],
    ])
      inputs.set(
        key,
        field(
          targetForm,
          label,
          key === 'mirrors' ? data.targets.mirrors.join('\n') : data.targets[key as 'blossom'],
          key === 'mirrors',
        ),
      );
    const saveTargets = el('button', 'Save destinations');
    targetForm.append(saveTargets);
    targetForm.onsubmit = (e) => {
      e.preventDefault();
      void save(
        {
          action: 'targets',
          targets: {
            ...Object.fromEntries([...inputs].map(([key, input]) => [key, input.value.trim()])),
            mirrors: inputs
              .get('mirrors')!
              .value.split('\n')
              .map((s) => s.trim())
              .filter(Boolean),
          },
        },
        saveTargets,
      );
    };
    destinations.append(
      targetForm,
      el(
        'p',
        'Provider storage allowance: unknown. Runtime/source limits above are client limits, not a paid storage plan.',
        'muted',
      ),
    );
    content.replaceChildren(project, assets, presentation, destinations);
  }
  const reload = document.querySelector<HTMLButtonElement>('#manager-refresh')!;
  async function refresh() {
    try {
      render(await request());
      status.textContent = 'Loaded from project files. Nothing is published.';
    } catch (e) {
      status.textContent = e instanceof Error ? e.message : 'Manager unavailable.';
    }
  }
  reload.onclick = () => void refresh();
  document.querySelector('#view-manager')!.addEventListener(
    'click',
    () => {
      document.querySelector<HTMLElement>('#stage')!.hidden = true;
      document.querySelector<HTMLElement>('#listing')!.hidden = true;
      document.querySelectorAll<HTMLVideoElement>('#listing video').forEach((v) => v.pause());
      root.hidden = false;
      for (const id of ['view-play', 'view-listing', 'view-manager'])
        document.getElementById(id)!.setAttribute('aria-pressed', String(id === 'view-manager'));
      if (!state) void refresh();
    },
    { signal },
  );
  for (const id of ['view-play', 'view-listing'])
    document.getElementById(id)!.addEventListener(
      'click',
      () => {
        root.hidden = true;
        document.getElementById('view-manager')!.setAttribute('aria-pressed', 'false');
        root.querySelectorAll('video,audio').forEach((v) => (v as HTMLMediaElement).pause());
      },
      { signal },
    );
  setupWorkshop(root, content, status, signal);
}
