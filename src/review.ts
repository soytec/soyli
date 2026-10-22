import { diagnose, formatDiagnostic } from '../packages/diagnostics/src';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { Accounts } from '../packages/identity/src/accounts';
import { ProtocolClient } from '../packages/client/src/nostr';
import { defaultTargets } from '../packages/publish/src/config';
import { readBinding } from '../packages/publish/src/binding';
import { committedSource } from '../packages/publish/src/git-source';
import { sourceGit } from '../packages/grasp/src/client';
import { MAX_READ_ARTIFACT_BYTES, sha256, type SignedEvent } from '../packages/protocol/src';
import { validateManifest } from '../packages/protocol/src/manifest';
import { remixBytes } from '../packages/remix/src';
import {
  readRepository,
  readProposals,
  proposalId,
  tag,
  validatePreview,
  type Repository,
  type Proposal,
} from '../packages/collaboration/src/protocol';
import {
  collaborationContext,
  projectRepository,
  proposalAction,
  type CollaborationOptions,
} from '../packages/collaboration/src/service';
import { fetchCommit } from '../packages/collaboration/src/git';
import { previewAssets } from './preview/assets';
import { startPreviewServer } from './preview/server';
import { localBackend } from './backend';
import { buildProject, setupProject } from './toolchain';
import { projectSchema } from '../packages/publish/src/config';
import { hostEnvironment } from './distribution';

export async function proposalList(options: CollaborationOptions & { reference?: string }) {
  const targets = defaultTargets(options.network);
  let client = new ProtocolClient(() => [
    targets.relay,
    targets.grasp.replace(/^http/, 'ws') + '/',
    ...targets.mirrors,
  ]);
  try {
    const configured = await collaborationContext(options);
    client.close();
    client = configured.client;
  } catch (error) {
    if (!options.reference) throw error;
  }
  try {
    let repository: Repository, selected: string | undefined;
    if (!options.reference) repository = await projectRepository(options, client);
    else if (/^(nostr:\/\/|30617:|naddr1)/.test(options.reference))
      repository = await readRepository(client, options.reference);
    else {
      selected = proposalId(options.reference);
      const root = (
        await client.query([{ ids: [selected], kinds: [1617, 1618, 1619], limit: 1 }])
      )[0];
      if (!root) throw new Error('Proposal unavailable on the configured relays.');
      repository = await readRepository(client, tag(root, 'a') ?? '');
      selected = root.kind === 1619 ? tag(root, 'E') : root.id;
    }
    return { repository, proposals: await readProposals(client, repository, selected), selected };
  } finally {
    client.close();
  }
}
const compact = (p: Proposal) => ({
  id: p.root.id,
  revision: p.revision.id,
  title: p.title,
  author: p.root.pubkey,
  status: p.status,
  head: p.head,
  base: p.base,
  preview: tag(p.revision, 'soy-preview') ?? null,
  patch: p.patch,
});
export async function review(
  options: CollaborationOptions & {
    reference?: string;
    port?: number;
    noOpen?: boolean;
    json?: boolean;
    rebuild?: boolean;
    embedOrigin?: string;
    beforeAction?: () => Promise<() => Promise<void>>;
    ready?: (info: { url: string }) => Promise<void>;
  },
) {
  if (options.embedOrigin && !/^http:\/\/127\.0\.0\.1:\d+$/.test(options.embedOrigin))
    throw new Error('Review can only be embedded by a local workshop.');
  let state = await proposalList(options);
  const temp = await mkdtemp(join(tmpdir(), 'soyli-review-'));
  const token = crypto.randomUUID(),
    previews = new Map<string, ReturnType<typeof startPreviewServer>>();
  let target = await committedSource(options.directory).catch(() => undefined);
  const assets = await previewAssets();
  const bytes = (url: string, limit: number) =>
    remixBytes(new URL(url), options.network === 'local', AbortSignal.timeout(30000), limit);
  const selectedRevision = (id: string, revision: string) => {
    const p = state.proposals.find((p) => p.root.id === id);
    const r = p?.revisions.find((r) => r.id === revision);
    if (!p || !r) throw new Error('That proposal revision is unavailable. Refresh the list.');
    return { p, r };
  };
  async function source(id: string, revision: string) {
    const { p, r } = selectedRevision(id, revision);
    if (p.patch) return { diff: p.root.content, head: p.head, base: p.base };
    const head = tag(r, 'c')!,
      base = tag(r, 'merge-base');
    const folder = join(temp, revision, 'git');
    await mkdir(folder, { recursive: true });
    await sourceGit(folder, ['init']);
    const clones = r.tags.filter((t) => t[0] === 'clone').flatMap((t) => t.slice(1));
    await fetchCommit(folder, clones, head, options.network === 'local');
    if (!base || !/^[a-f0-9]{40}$/.test(base))
      throw new Error('No declared merge base. Inspect this proposal with ordinary Git/ngit.');
    await sourceGit(folder, ['merge-base', '--is-ancestor', base, head]);
    const diff = await sourceGit(folder, [
      'diff',
      '--no-ext-diff',
      '--no-textconv',
      '--stat',
      '--patch',
      `${base}..${head}`,
    ]);
    return { folder, head, base, diff };
  }
  async function play(id: string, revision: string, original: boolean) {
    const key = `${revision}${original ? 'original' : ''}`;
    if (previews.has(key)) return previews.get(key)!.url.href;
    const { p, r } = selectedRevision(id, revision);
    let manifest: SignedEvent;
    if (original) {
      const binding = await readBinding(options.directory);
      let input = binding?.upstream?.manifest;
      if (!input) {
        const context = await collaborationContext(options);
        try {
          input = (
            await context.client.query(
              [
                {
                  kinds: [35129],
                  authors: [state.repository.pubkey],
                  '#d': [state.repository.identifier],
                  limit: 1,
                },
              ],
              state.repository.relays,
            )
          )[0];
        } finally {
          context.client.close();
        }
      }
      if (!input) throw new Error('No original napplet release was found for this repository.');
      manifest = (await validateManifest(input)).manifest;
    } else {
      const url = tag(r, 'soy-preview');
      if (!url)
        throw new Error(
          'This proposal has no built preview. Use explicit local rebuild or ngit checkout.',
        );
      manifest = (await validatePreview(await bytes(url, 65536), r)).manifest;
    }
    const release = await validateManifest(manifest);
    let artifact: Uint8Array | undefined;
    for (const server of release.servers) {
      try {
        const value = await bytes(
          `${server.replace(/\/$/, '')}/${release.artifactHash}`,
          MAX_READ_ARTIFACT_BYTES,
        );
        if ((await sha256(value)) === release.artifactHash) {
          artifact = value;
          break;
        }
      } catch {}
    }
    if (!artifact) throw new Error('Preview download unavailable or hash mismatch.');
    const folder = join(temp, key, 'play');
    await mkdir(folder, { recursive: true });
    await Bun.write(join(folder, 'index.html'), artifact);
    await Bun.write(
      join(folder, 'napplet.json'),
      JSON.stringify({
        schema: 'space-local-project/v1',
        name: p.title,
        title: (release.title || p.title).slice(0, 160),
        description: release.description.slice(0, 1000),
        entry: 'index.html',
        previewId: crypto.randomUUID(),
        license: 'See source',
        requires: release.domains,
        optionalDomains: release.optionalDomains.slice(0, 32),
        // Authoring limits may be narrower than remote optional metadata. A review
        // still plays the verified artifact when those advertisements cannot fit.
        archetypes: projectSchema.shape.archetypes.safeParse(release.archetypes.slice(0, 16)).data,
        intents: projectSchema.shape.intents.safeParse(release.intents.slice(0, 4)).data,
        relays: [],
        servers: release.servers,
      }),
    );
    const server = startPreviewServer(pathToFileURL(folder + '/'), 0, false, assets, {
      network: 'local',
    });
    previews.set(key, server);
    return server.url.href;
  }
  let account = await (options.accounts ?? new Accounts(options.network)).current();
  let mutating = false;
  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: options.port ?? 0,
    async fetch(request) {
      const url = new URL(request.url);
      if (url.origin !== server.url.origin) return new Response('Invalid host', { status: 403 });
      if (url.pathname === '/')
        return new Response(reviewHtml, {
          headers: {
            'Content-Type': 'text/html; charset=utf-8',
            'Cache-Control': 'no-store',
            'Content-Security-Policy': `default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; frame-src http://127.0.0.1:*; connect-src 'self'; img-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors ${options.embedOrigin ?? "'none'"}`,
          },
        });
      if (
        request.headers.get('x-review-token') !== token ||
        (request.headers.get('origin') && request.headers.get('origin') !== server.url.origin)
      )
        return new Response('Invalid review session', { status: 403 });
      try {
        if (url.pathname === '/state' && request.method === 'GET') {
          account = await (options.accounts ?? new Accounts(options.network)).current();
          return Response.json({
            repository: state.repository.address,
            proposals: state.proposals,
            selected: state.selected,
            target,
            account: account?.pubkey,
            maintainer: !!account && state.repository.maintainers.includes(account.pubkey),
          });
        }
        if (request.method !== 'POST') return new Response('Not found', { status: 404 });
        if (Number(request.headers.get('content-length') ?? 0) > 8192)
          throw new Error('Request too large.');
        const raw = await request.text();
        if (raw.length > 8192) throw new Error('Request too large.');
        const body = JSON.parse(raw);
        if (url.pathname === '/refresh') {
          state = await proposalList(options);
          target = await committedSource(options.directory).catch(() => undefined);
          return Response.json({ ok: true });
        }
        const { p, r } = selectedRevision(body.id, body.revision);
        if (url.pathname === '/play')
          return Response.json({ url: await play(p.root.id, r.id, !!body.original) });
        if (url.pathname === '/diff') return Response.json(await source(p.root.id, r.id));
        if (
          url.pathname === '/action' &&
          ['merge', 'comment', 'close', 'reopen'].includes(body.action)
        ) {
          if (body.action === 'merge' && body.target !== target)
            throw new Error('Target changed. Refresh before merging.');
          if (mutating) throw new Error('Another review action is still running.');
          mutating = true;
          let release: (() => Promise<void>) | undefined;
          try {
            release = await options.beforeAction?.();
            if (
              (await (options.accounts ?? new Accounts(options.network)).current())?.pubkey !==
              account?.pubkey
            )
              throw new Error('Creator changed. Refresh the review before acting.');
            const result = await proposalAction({
              ...options,
              proposal: p.root.id,
              revision: r.id,
              target: body.target,
              action: body.action,
              text: body.text,
            });
            if (body.action === 'merge') target = undefined;
            return Response.json(result);
          } finally {
            mutating = false;
            await release?.();
          }
        }
        throw new Error('Unknown review action.');
      } catch (error) {
        const diagnostic = diagnose(error, 'proposal review');
        return Response.json({ error: formatDiagnostic(diagnostic), diagnostic }, { status: 400 });
      }
    },
  });
  const url = `${server.url}#${token}`;
  let closeBackend: (() => Promise<void>) | undefined;
  try {
    if (options.rebuild) {
      const p = state.proposals.find((p) => p.root.id === state.selected);
      if (!p)
        throw new Error('Use review <proposal> --rebuild to explicitly run that source build.');
      const fetched = await source(p.root.id, p.revision.id);
      if (!fetched.folder) throw new Error('Use ngit to apply this patch first.');
      await sourceGit(fetched.folder, ['checkout', '--detach', fetched.head!]);
      const project = projectSchema.parse(
        await Bun.file(join(fetched.folder, 'napplet.json')).json(),
      );
      if (project.entry === 'dist/index.html') {
        await setupProject(fetched.folder, options.signal);
        await buildProject(fetched.folder, options.signal);
      }
      const backend = await localBackend(fetched.folder);
      const built = startPreviewServer(pathToFileURL(fetched.folder + '/'), 0, false, assets, {
        network: 'local',
        backend: backend?.provider,
      });
      previews.set(p.revision.id, built);
      closeBackend = backend?.close;
    }
    if (!options.embedOrigin)
      console.log(
        options.json
          ? JSON.stringify({
              url,
              target,
              repository: state.repository.address,
              proposals: state.proposals.map(compact),
            })
          : `Review changes: ${url}\nOpening a preview runs only its checked HTML in the sandbox. Build scripts run only with --rebuild.\nCtrl+C stops the review.`,
      );
    if (!options.noOpen && !options.json)
      Bun.spawn([process.platform === 'darwin' ? 'open' : 'xdg-open', url], {
        env: hostEnvironment(),
        stdout: 'ignore',
        stderr: 'ignore',
      });
    await options.ready?.({ url });
    if (!options.signal?.aborted)
      await new Promise<void>((resolve) =>
        options.signal?.addEventListener('abort', () => resolve(), { once: true }),
      );
  } finally {
    server.stop(true);
    for (const p of previews.values()) p.stop(true);
    await closeBackend?.();
    await rm(temp, { recursive: true, force: true });
  }
}
const reviewHtml = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Review · napplet soyLI</title><style>
:root{font-family:system-ui;color:#2d3228;background:#f7f5ec}*{box-sizing:border-box}body{margin:0}header{padding:24px 4vw;display:flex;align-items:center;justify-content:space-between;gap:16px}header>div{min-width:0}header button{flex-shrink:0}section{min-width:0}select{max-width:100%}h1{font-size:32px;letter-spacing:-1px;margin:10px 0}small,.muted{color:#727868}main{display:grid;grid-template-columns:280px minmax(0,1fr);gap:28px;padding:0 4vw 40px}button,textarea,select{font:inherit;border:1px solid #c9cbbb;border-radius:8px;padding:10px 14px;background:transparent;color:inherit}button{cursor:pointer}button:hover,button.active{background:#e3ead9}button:disabled{opacity:.5;cursor:wait}nav{display:flex;gap:8px;flex-wrap:wrap;margin:18px 0}aside button{display:block;text-align:left;width:100%;margin:8px 0}aside small{display:block;margin-top:6px}pre{white-space:pre-wrap;overflow-wrap:anywhere;background:#293126;color:#e1e7d8;border-radius:10px;padding:22px;max-height:650px;overflow:auto;font-size:13px}iframe{border:1px solid #c9cbbb;width:100%;height:65vh;border-radius:12px;background:#eeede4}textarea{width:100%;min-height:90px}#status{color:#566d4b}#meta{overflow-wrap:anywhere}article{margin:14px 0;padding:12px;background:#efeede;border-radius:8px}@media(max-width:720px){main{grid-template-columns:minmax(0,1fr)}aside{min-width:0;display:flex;overflow:auto;gap:8px}aside button{min-width:220px}iframe{height:55vh}}
</style></head><body><header><div><small>NAPPLET SOYLI / COLLABORATE</small><h1>A better version starts here.</h1><small>Public source. Real Git. Play before you merge.</small></div><button id="refresh">Refresh</button></header><main><aside id="list"></aside><section><h2 id="title">Choose a proposal</h2><div id="meta" class="muted"></div><select id="revisions" aria-label="Source revision"></select><nav><button data-tab="proposed">Play proposed</button><button data-tab="original">Play original</button><button data-tab="diff">Changes</button><button data-tab="discussion">Discussion</button></nav><div id="content"></div><p id="status" role="status"></p><nav><button id="merge">Merge locally</button><button id="close">Close proposal</button><button id="reopen">Reopen</button></nav><small>A local merge keeps contributor history. Push Git and release the napplet separately.</small></section></main><script>
const token=location.hash.slice(1);history.replaceState(null,'',location.pathname);let state,selected,revision;
const $=id=>document.getElementById(id), tag=(e,n)=>e.tags.find(t=>t[0]===n)?.[1];
async function api(path,body){const r=await fetch(path,{method:body?'POST':'GET',headers:{'x-review-token':token,'Content-Type':'application/json'},...(body?{body:JSON.stringify(body)}:{})});const value=await r.json();if(!r.ok)throw Error(value.error);return value}
async function busy(button,fn){const label=button.textContent;button.disabled=true;button.textContent='Working…';try{await fn()}catch(e){$('status').textContent=e.message}finally{button.disabled=false;button.textContent=label}}
function data(){return{id:selected.root.id,revision:revision.id,target:state.target}}
function select(p,r){selected=p;revision=r??p.revision;$('title').textContent=p.title;$('meta').textContent=p.status+' · '+p.root.pubkey.slice(0,16)+' · source '+(tag(revision,'c')??'patch');$('content').replaceChildren();$('status').textContent='Preview is attributed to this contributor; a signature is not proof of a reproducible source build.';$('revisions').replaceChildren(...p.revisions.map(e=>{const o=document.createElement('option');o.value=e.id;o.textContent=new Date(e.created_at*1000).toLocaleString()+' · '+e.id.slice(0,12);o.selected=e.id===revision.id;return o}));$('merge').hidden=!state.maintainer;$('merge').disabled=!state.target||p.patch||!['open','draft'].includes(p.status);['close','reopen'].forEach(a=>$(a).hidden=!(state.maintainer||state.account===p.root.pubkey))}
async function load(){const old=selected,rev=revision;state=await api('/state');$('list').replaceChildren(...state.proposals.map(p=>{const b=document.createElement('button');b.textContent=p.title;const s=document.createElement('small');s.textContent=p.status+' · '+p.root.pubkey.slice(0,10);b.append(s);b.onclick=()=>select(p);return b}));if(!state.proposals.length)$('list').textContent='No proposals yet.';const p=state.proposals.find(p=>p.root.id===(old?.root.id??state.selected))??state.proposals[0];if(p){const r=p.revisions.find(r=>r.id===rev?.id);select(p,r);if(r&&r.id!==p.revision.id)$('status').textContent='A newer revision is available. Your reviewed revision stays selected.'}}
$('refresh').onclick=e=>busy(e.target,async()=>{await api('/refresh',{});await load()});$('revisions').onchange=e=>select(selected,selected.revisions.find(r=>r.id===e.target.value));
document.querySelectorAll('[data-tab]').forEach(b=>b.onclick=()=>busy(b,async()=>{if(!selected)return;const tab=b.dataset.tab;if(tab==='diff'){const x=await api('/diff',data());const pre=document.createElement('pre');pre.textContent=x.diff;$('content').replaceChildren(pre)}else if(tab==='discussion'){$('content').replaceChildren(...selected.comments.map(c=>{const a=document.createElement('article');a.textContent=c.pubkey.slice(0,12)+': '+c.content;return a}));const text=document.createElement('textarea');text.placeholder='Discuss the change or request changes';const send=document.createElement('button');send.textContent='Post comment';send.onclick=()=>busy(send,async()=>{await api('/action',{...data(),action:'comment',text:text.value});text.value='';$('status').textContent='Comment posted.'});$('content').append(text,send)}else{const x=await api('/play',{...data(),original:tab==='original'});const iframe=document.createElement('iframe');iframe.src=x.url;iframe.title=selected.title; $('content').replaceChildren(iframe)}}));
['merge','close','reopen'].forEach(action=>$(action).onclick=e=>busy(e.target,async()=>{if(!selected)return;const result=await api('/action',{...data(),action});$('status').textContent=result.state==='merged_locally'?'Merged locally at '+result.commit+'. Git push and napplet release are still pending.':'Proposal '+action+'.';if(action==='merge')state.target=undefined}));load().catch(e=>$('status').textContent=e.message);
</script></body></html>`;
