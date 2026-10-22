import type { WorkshopState } from '../workshop';
import { formatDiagnostic } from '../../packages/diagnostics/src';
import { outboxReport } from '../../packages/publish/src/outbox-report';

const el = <K extends keyof HTMLElementTagNameMap>(tag: K, text = '', className = '') => {
  const node = document.createElement(tag);
  node.textContent = text;
  node.className = className;
  return node;
};
export function setupWorkshop(
  root: HTMLElement,
  editor: HTMLElement,
  editorStatus: HTMLElement,
  signal: AbortSignal,
) {
  if (document.querySelector<HTMLMetaElement>('meta[name=soyli-workshop]')?.content !== 'true')
    return;
  const headers = {
    'X-Soyli-Token': document.querySelector<HTMLMetaElement>('meta[name=soyli-token]')!.content,
  };
  const nav = el('nav', '', 'workshop-tabs');
  nav.setAttribute('aria-label', 'Workshop sections');
  const panel = el('section', '', 'workshop-panel');
  panel.hidden = true;
  root.insertBefore(nav, editorStatus);
  root.append(panel);
  let active = 'Project',
    state: WorkshopState | undefined,
    working = false,
    reviewUrl: string | undefined;
  const mediaUrls: string[] = [];
  const buttons = new Map<string, HTMLButtonElement>();
  async function request(path = '', body?: unknown) {
    const response = await fetch('/workshop' + path, {
      cache: 'no-store',
      signal,
      headers: { ...headers, 'Content-Type': 'application/json' },
      ...(body ? { method: 'POST', body: JSON.stringify(body) } : {}),
    });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error ?? 'Workshop unavailable.');
    return result;
  }
  const actionButtons: HTMLButtonElement[] = [];
  function action(label: string, fn: (button: HTMLButtonElement) => Promise<void>) {
    const button = el('button', label);
    button.type = 'button';
    button.disabled = working || !!state?.busy;
    button.onclick = () => {
      void fn(button).catch((error) => {
        button.textContent = `Retry · ${error.message}`;
        button.classList.add('workshop-error');
      });
    };
    actionButtons.push(button);
    return button;
  }
  async function load() {
    for (const button of actionButtons) button.disabled = true;
    state = await request();
    render();
  }
  async function run(body: Record<string, unknown>, button: HTMLButtonElement) {
    if (!state || working) return;
    working = true;
    const disabled = new Map(actionButtons.map((control) => [control, control.disabled]));
    for (const control of disabled.keys()) control.disabled = true;
    button.setAttribute('aria-busy', 'true');
    button.textContent = 'Starting…';
    try {
      const job = await request('', {
        ...body,
        ...(body.action === 'review' ? {} : { revision: state.revision }),
      });
      do {
        state = await request();
        if (state?.job?.id !== job.id)
          throw new Error('The action changed in another window. Reload its result.');
        button.textContent = state!.job!.stage + '…';
        if (state!.job!.state !== 'running' && !state!.busy) break;
        await new Promise((resolve) => setTimeout(resolve, 800));
      } while (!signal.aborted);
      if (state!.job?.state === 'failed') throw new Error(state!.job.error);
      if (body.action === 'review') reviewUrl = (state!.job?.result as { url: string }).url;
      working = false;
      render();
    } catch (error) {
      working = false;
      render();
      const retry = action(
        `Retry ${String(body.action)} · ${error instanceof Error ? error.message : 'Action failed'}`,
        (button) => run(body, button),
      );
      retry.classList.add('workshop-error');
      panel.append(retry);
    } finally {
      working = false;
      button.removeAttribute('aria-busy');
      for (const [control, wasDisabled] of disabled) control.disabled = wasDisabled;
    }
  }
  function section(title: string, detail: string) {
    const card = el('section', '', 'workshop-card');
    card.append(el('h2', title), el('p', detail, 'muted'));
    return card;
  }
  function field(card: HTMLElement, label: string, multiline = false) {
    const wrapper = el('label', label, 'workshop-field'),
      input = multiline ? el('textarea') : el('input');
    wrapper.append(input);
    card.append(wrapper);
    return input;
  }
  function facts(parent: HTMLElement, values: Record<string, string>) {
    const list = el('dl', '', 'workshop-facts');
    for (const [label, value] of Object.entries(values))
      list.append(el('dt', label), el('dd', value));
    parent.append(list);
  }
  function render() {
    if (!state) return;
    actionButtons.length = 0;
    for (const url of mediaUrls.splice(0)) URL.revokeObjectURL(url);
    if (active === 'Project') return;
    panel.replaceChildren();
    const summary = el(
      'p',
      `${state.tree.branch} · ${state.tree.head?.slice(0, 10) ?? 'No checkpoint yet'} · ${state.tree.changed.length ? state.tree.changed.length + ' changed files' : 'Working tree clean'}`,
      'workshop-summary',
    );
    panel.append(summary);
    if (active === 'Changes') {
      const card = section(
        'A checkpoint for your idea.',
        'Review every changed file, then save them together in Git. A checkpoint stays on this computer.',
      );
      const layout = el('div', '', 'workshop-diff-layout'),
        files = el('nav', '', 'workshop-files'),
        diff = el('pre', 'Choose a file to see its changes.', 'workshop-diff');
      files.setAttribute('aria-label', 'Changed files');
      for (const path of state.tree.changed) {
        const b = action(path, async (button) => {
          button.setAttribute('aria-busy', 'true');
          try {
            diff.textContent = (
              await request(
                '/diff?' + new URLSearchParams({ path, revision: state!.tree.revision }),
              )
            ).diff;
          } finally {
            button.removeAttribute('aria-busy');
          }
        });
        b.setAttribute('aria-label', path);
        b.append(
          el(
            'small',
            [
              state.tree.staged.includes(path) ? 'staged' : '',
              state.tree.unstaged.includes(path) ? 'unstaged' : '',
            ]
              .filter(Boolean)
              .join(' + ') || 'new file',
          ),
        );
        files.append(b);
      }
      layout.append(files, diff);
      card.append(layout);
      if (!state.tree.changed.length)
        diff.textContent = 'All saved. Edit your files or project details to start another change.';
      const message = field(card, 'What changed?');
      message.placeholder = 'Add a pair of portals';
      const save = action('Save local checkpoint', (button) => {
        if (!message.value.trim()) throw new Error('Describe the change first.');
        return run({ action: 'checkpoint', message: message.value }, button);
      });
      save.disabled ||= !state.tree.changed.length;
      card.append(
        save,
        el(
          'p',
          'All listed changes, including new assets and deletions, are included. Use ordinary Git for selective staging.',
          'muted',
        ),
      );
      panel.append(card);
    } else if (active === 'Proposals') {
      const create = section(
        'Pass your improvement back.',
        'Share a playable proposal with the original author. Your Git history and proposal become public; releasing your own napplet is a separate choice.',
      );
      if (state.upstream) {
        facts(create, {
          'Original repository': state.upstream,
          'Signing creator': state.identity?.pubkey ?? 'Choose an identity in the terminal',
        });
        const description = field(create, 'Describe your proposal', true);
        create.append(
          action('Publish playable proposal', (button) =>
            run({ action: 'propose', description: description.value }, button),
          ),
        );
        const recovery = el('details');
        recovery.open = state.job?.action === 'propose' && state.job.state === 'failed';
        recovery.append(el('summary', 'Recover an interrupted proposal'));
        recovery.append(
          el(
            'p',
            'Resume the saved submission for this branch and creator, including after restarting soyLI. Its original files and destinations are retained.',
            'muted',
          ),
          action('Resume saved proposal', (button) =>
            run(
              {
                action: 'propose',
                description: description.value || 'Resume saved proposal',
                resume: true,
              },
              button,
            ),
          ),
        );
        create.append(recovery);
      } else
        create.append(
          el(
            'p',
            'This checkout has no original repository to contribute back to. Remix a published napplet to start a contribution.',
          ),
        );
      const incoming = section(
        'Play it. Discuss it. Bring it in.',
        'Open proposals for this repository. A merge updates local Git only; publish when you are ready to release it.',
      );
      incoming.append(
        action(reviewUrl ? 'Reload proposal review' : 'Open proposal review', (button) =>
          run({ action: 'review' }, button),
        ),
      );
      if (reviewUrl) {
        const frame = el('iframe', '', 'workshop-review');
        frame.src = reviewUrl;
        frame.title = 'Playable proposal review';
        incoming.append(frame);
      }
      incoming.append(
        action('Push committed Git history', (button) => run({ action: 'push' }, button)),
        el('p', 'This makes committed source public without releasing a new napplet.', 'muted'),
      );
      panel.append(create, incoming);
    } else {
      const card = section(
        'One last look. Then let it loose.',
        'Publishing makes this napplet, its assets and committed Git history public. Checks stay local until you choose Publish.',
      );
      const plan = state.prepared?.plan;
      facts(card, {
        'Signing creator':
          state.identity?.pubkey ?? 'Choose a creator with soyli account create, connect or use',
        Title: plan?.title ?? state.project.project.title,
        Description: plan?.description ?? state.project.project.description,
        'Source checkpoint': plan?.sourceCommit ?? state.tree.head ?? 'Save a checkpoint first',
        'Listing relay': state.project.targets.relay,
        'Assets · Blossom': state.project.targets.blossom,
        'Source · GRASP': state.project.targets.grasp,
        Website: state.project.targets.site,
        'Extra relay copies': state.project.targets.mirrors.join(', ') || 'None',
      });
      card.append(action('Build & check', (button) => run({ action: 'check' }, button)));
      if (state.prepared) {
        card.append(
          el(
            'p',
            `Checked · ${state.prepared.profile} · ${(plan!.sourceBytes / 1048576).toFixed(1)} MiB source`,
            'workshop-check',
          ),
        );
        const media = el('div', '', 'workshop-media');
        for (const [path, enabled] of [
          ['cover', state.prepared.cover],
          ['video', state.prepared.video],
        ] as const) {
          if (!enabled) continue;
          const view = path === 'cover' ? el('img') : el('video');
          if (view instanceof HTMLVideoElement) {
            view.controls = true;
            view.preload = 'metadata';
          } else view.alt = 'Checked cover image';
          media.append(view);
          void fetch('/workshop/' + path, { headers, signal })
            .then(async (response) => {
              if (!response.ok || !view.isConnected) return;
              const url = URL.createObjectURL(await response.blob());
              mediaUrls.push(url);
              view.src = url;
            })
            .catch(() => {});
        }
        card.append(
          media,
          action('Publish this revision', (button) => run({ action: 'publish' }, button)),
        );
        card.append(
          el(
            'p',
            'Publishing verifies the source again and uses these checked presentation files. Multiplayer gameplay is not automatically tested.',
            'muted',
          ),
        );
      }
      panel.append(card);
      if (state.publication.status !== 'not_started') {
        const published = section(
          state.pendingJob ? 'Finish the saved release.' : 'Latest release.',
          'A saved release keeps its original source, creator and destinations, even if you edit the project.',
        );
        facts(published, {
          Status:
            state.publication.status === 'announced_pending_index'
              ? 'Published to relays · website indexing pending'
              : state.publication.status === 'indexed'
                ? 'Published and indexed'
                : 'Publication in progress',
          Creator: state.publication.creator,
          Commit: state.publication.sourceCommit,
          Relay: state.publication.targets.relay,
          Blossom: state.publication.targets.blossom,
          Git: state.publication.targets.grasp,
          Website: state.publication.targets.site,
          'Extra relay copies': state.publication.targets.mirrors.join(', ') || 'None',
        });
        for (const [relay, failure] of Object.entries(state.publication.mirrorErrors)) {
          published.append(
            el(
              'pre',
              `Optional mirror failed: ${relay}\nEvent kind ${failure.eventKind}\n${formatDiagnostic(failure.diagnostic)}`,
              'workshop-error',
            ),
          );
        }
        for (const line of outboxReport(state.publication.outbox))
          published.append(
            el('pre', line, line.includes('\nOperation: ') ? 'workshop-error' : 'muted'),
          );
        if (state.pendingJob)
          published.append(
            action('Resume saved release', (button) =>
              run({ action: 'resume', jobId: state!.pendingJob }, button),
            ),
          );
        const link = el('a', 'Open napplet ↗');
        link.href = state.publication.url;
        link.target = '_blank';
        link.rel = 'noopener noreferrer';
        published.append(link);
        panel.append(published);
      }
    }
    if (state.job?.state === 'done' && state.job.action !== 'review') {
      const result = state.job.result as Record<string, unknown>;
      const done = el(
        'p',
        `${state.job.action === 'checkpoint' ? 'Checkpoint saved locally' : state.job.action === 'check' ? 'Checks passed' : state.job.action === 'propose' ? 'Playable proposal published' : state.job.action === 'push' ? 'Git history pushed' : 'Release processed'}${result?.commit ? ' · ' + String(result.commit).slice(0, 10) : ''}.`,
        'workshop-check',
      );
      done.setAttribute('role', 'status');
      panel.append(done);
    }
    if (state.busy) {
      const progress = el(
        'p',
        state.job?.stage ?? 'Another workshop action is running…',
        'workshop-summary',
      );
      progress.setAttribute('role', 'status');
      panel.append(progress);
    }
  }
  for (const name of ['Project', 'Changes', 'Proposals', 'Publish']) {
    const button = el('button', name);
    buttons.set(name, button);
    nav.append(button);
    button.setAttribute('aria-pressed', String(name === active));
    button.onclick = () => {
      active = name;
      editor.hidden = name !== 'Project';
      editorStatus.hidden = name !== 'Project';
      panel.hidden = name === 'Project';
      for (const [label, control] of buttons)
        control.setAttribute('aria-pressed', String(label === name));
      if (name === 'Project') {
        panel.replaceChildren();
        return;
      }
      panel.textContent = 'Reading your project…';
      void load().catch((error) => {
        panel.textContent = error.message;
      });
    };
  }
  const reload = document.querySelector<HTMLButtonElement>('#manager-refresh')!;
  reload.addEventListener(
    'click',
    () => {
      if (active !== 'Project')
        void load().catch((error) => {
          panel.textContent = error.message;
        });
    },
    { signal },
  );
  signal.addEventListener(
    'abort',
    () => {
      for (const url of mediaUrls) URL.revokeObjectURL(url);
    },
    { once: true },
  );
}
