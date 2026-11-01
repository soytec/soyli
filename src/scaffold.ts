import { DiagnosticError } from '../packages/diagnostics/src';
import { sourceGit } from '../packages/grasp/src/client';
import { projectPublishingDefaults } from '../packages/publish/src/config';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { requireGit } from './prerequisites';
import { AccountError } from '../packages/identity/src/signer';
import { examples, exampleHtml } from '../packages/examples/artifact';
import { boilerplateFiles, installCreatorSkills, upstream } from './creator-kit';

export class ScaffoldInputError extends Error {}

export async function scaffold(parent: string, name: string, template: string) {
  try {
    const target = await scaffoldProject(parent, name, template);
    // Only a newly created destination reaches here, after all managed guidance
    // has been written. Existing projects and remixes never use this path.
    await initializeGit(target);
    return target;
  } catch (error) {
    if (error instanceof AccountError || error instanceof ScaffoldInputError) throw error;
    const code = (error as NodeJS.ErrnoException).code;
    if (['EACCES', 'EPERM', 'EROFS'].includes(code ?? ''))
      throw new AccountError(
        'PROJECT_PERMISSION',
        'Cannot write the project files. Choose a folder owned by your current user and check its permissions. Running soyLI with sudo is not required.',
      );
    if (code === 'ENOSPC')
      throw new AccountError(
        'PROJECT_DISK_FULL',
        'Not enough disk space to create the project. Free space before retrying; partially created files may remain.',
      );
    throw error;
  }
}
async function createDestination(target: string) {
  try {
    await mkdir(target);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST')
      throw new AccountError(
        'DESTINATION_EXISTS',
        `The destination already exists: ${target}. No files were overwritten. Inspect it before retrying; choose another folder name for a fresh project. If it is already a project, use soyli setup --project <folder>.`,
      );
    throw error;
  }
}
async function initializeGit(target: string) {
  // Avoid --initial-branch: older Apple Git accepts init + symbolic-ref too.
  try {
    await sourceGit(target, ['init']);
    await sourceGit(target, ['symbolic-ref', 'HEAD', 'refs/heads/main']);
  } catch (cause) {
    throw new DiagnosticError(
      'GIT_INIT_FAILED',
      `Project files were created at ${target}, but Git initialization failed.`,
      {
        operation: 'initialize project Git repository',
        cause,
        recovery:
          'Resolve the Git error, then initialize Git in the existing folder before running soyli setup --project <folder>.',
      },
    );
  }
  try {
    await sourceGit(target, ['add', '--all', '--', '.']);
    await sourceGit(
      target,
      ['-c', 'commit.gpgSign=false', 'commit', '-m', 'Initialize napplet with soyLI'],
      {
        GIT_AUTHOR_NAME: 'napplet soyLI',
        GIT_AUTHOR_EMAIL: 'scaffold@napplet.invalid',
        GIT_COMMITTER_NAME: 'napplet soyLI',
        GIT_COMMITTER_EMAIL: 'scaffold@napplet.invalid',
      },
    );
  } catch (cause) {
    throw new DiagnosticError(
      'GIT_INITIAL_COMMIT_FAILED',
      `Project files were created at ${target}, but the initial local Git checkpoint could not be saved.`,
      {
        operation: 'save initial scaffold checkpoint',
        target,
        cause,
        recovery:
          'Resolve the Git error below. In the existing folder, inspect git status and save the starting point with soyli checkpoint "Initialize napplet with soyLI", then run soyli setup if dependencies are needed. Do not recreate the project.',
      },
    );
  }
}
async function scaffoldProject(parent: string, name: string, template: string) {
  if (template !== 'boilerplate') {
    const target = await scaffoldLegacy(parent, name, template);
    await installCreatorSkills(target);
    return target;
  }
  if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(name))
    throw new ScaffoldInputError(
      'Choose a folder name using lowercase letters, numbers, and hyphens.',
    );
  await requireGit();
  const target = resolve(parent, name);
  await createDestination(target);
  for (const [path, text] of Object.entries(boilerplateFiles(name))) {
    await mkdir(dirname(resolve(target, path)), { recursive: true });
    await writeFile(resolve(target, path), text, { flag: 'wx' });
  }
  const previewId = crypto.randomUUID();
  await writeFile(
    resolve(target, 'napplet.json'),
    JSON.stringify(
      {
        schema: 'space-local-project/v1',
        name,
        template,
        entry: 'dist/index.html',
        previewId,
        identifier: `n-${previewId.replaceAll('-', '').slice(0, 11)}`,
        publish: projectPublishingDefaults(),
        preview: { delayMs: 1500 },
        requires: [],
        relays: [],
        servers: [],
        license: 'MIT',
        topics: [],
      },
      null,
      2,
    ) + '\n',
  );
  await writeFile(
    resolve(target, 'napplet.upstream.json'),
    JSON.stringify(upstream, null, 2) + '\n',
  );
  await installCreatorSkills(target);
  return target;
}

async function scaffoldLegacy(parent: string, name: string, template: string) {
  if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(name))
    throw new ScaffoldInputError(
      'Choose a folder name using lowercase letters, numbers, and hyphens.',
    );
  if (!examples.some((e) => e.slug === template))
    throw new ScaffoldInputError(
      `Unknown template. Choose: ${examples.map((e) => e.slug).join(', ')}`,
    );
  await requireGit();
  const target = resolve(parent, name);
  // Fail atomically if anything already occupies the destination; never overwrite a project.
  await createDestination(target);
  await writeFile(resolve(target, 'index.html'), exampleHtml(template));
  const previewId = crypto.randomUUID();
  await writeFile(
    resolve(target, 'napplet.json'),
    JSON.stringify(
      {
        schema: 'space-local-project/v1',
        name,
        template,
        entry: 'index.html',
        previewId,
        identifier: `n-${previewId.replaceAll('-', '').slice(0, 11)}`,
        publish: projectPublishingDefaults(),
        preview: { delayMs: 1500 },
        requires: [],
        relays: [],
        servers: [],
        license: 'MIT',
        topics: examples.find((e) => e.slug === template)!.topics,
      },
      null,
      2,
    ) + '\n',
  );
  await writeFile(
    resolve(target, 'package.json'),
    JSON.stringify(
      {
        name,
        private: true,
        type: 'module',
        scripts: {
          dev: 'soyli dev',
          check: 'soyli check',
          publish: 'soyli publish',
        },
      },
      null,
      2,
    ) + '\n',
  );
  await writeFile(
    resolve(target, 'AGENTS.md'),
    `# ${name}\n\nBuild a small, self-contained creative experiment in index.html.\n\n- Keep all executable JavaScript and CSS in index.html. Embed small assets; retrieve external byte resources only through napplet.resource.\n- No CDN imports, direct fetch/WebSockets, service workers, forms, popups, or parent-window access. Use host-mediated NAP APIs for resources and Nostr reads.\n- Host domains are injected before your scripts run. Check window.napplet?.resource (or the relevant domain) for optional capabilities. Declare mandatory domains in napplet.json requires.\n- The player is an opaque sandbox. Use napplet.storage instead of localStorage. Listen to napplet.identity.onChanged when retaining account data in memory.\n- Use napplet.resource for assets, napplet.relay/outbox for reads, and napplet.fs for session files. Relays in napplet.json are fallback read destinations. Explicit public WSS hints are supported through the host; private/LAN relays are denied except explicitly configured literal-loopback WS in local preview; publishing/signing calls remain denied by the playback policy.\n- Use canvas, inline SVG, DOM or embedded data URLs. Coordinate all audible output, including Web Audio and embedded sounds, with a napplet-owned NAP-MEDIA session; honor host pause/stop/volume and user activation. If MEDIA is missing or rejects the session, keep games playable silently. See docs/napplet-space.md.\n- Keep playable HTML within 25 MiB; each managed asset and host resource remains limited to 10 MiB. Support pointer and touch; respect reduced motion where practical.\n- Run soyli dev for the same restricted preview runtime as napplet.soy. The preview and browser checks are provided by the installed CLI; no Bun or Node installation is needed.\n- Preserve license notices and credit when remixing. Never place private signing keys in this project.\n\nRead docs/napplet-space.md for the installed skills and this legacy single-file workflow. Ask what the creator wants to make, then start with a small visible change.\n`,
  );
  await writeFile(resolve(target, 'CLAUDE.md'), '@AGENTS.md\n');
  await writeFile(
    resolve(target, '.gitignore'),
    'node_modules/\n.napplet-space/\n.env\n.env.*\n.DS_Store\n',
  );
  await writeFile(
    resolve(target, 'LICENSE'),
    `MIT License\n\nCopyright (c) 2026 napplet.space contributors\n\nPermission is hereby granted, free of charge, to any person obtaining a copy of this software and associated documentation files (the "Software"), to deal in the Software without restriction, including without limitation the rights to use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of the Software, and to permit persons to whom the Software is furnished to do so, subject to the following conditions:\n\nThe above copyright notice and this permission notice shall be included in all copies or substantial portions of the Software.\n\nTHE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.\n`,
  );
  await writeFile(
    resolve(target, 'README.md'),
    `# ${name}\n\nA local napplet based on ${template}, from the Space lab starter collection.\n\nRun \`soyli dev\`, open http://localhost:4173, and edit \`index.html\` with your favorite coding agent. The preview reloads when the artifact changes. No dependency install or separate Bun/Node runtime is required. Install the CLI from https://napplet.soy/create if needed. Git is used for publishing. Local private keys use the OS credential store; new remote signer sessions use private files outside projects. soyli doctor checks prerequisites.\n\nThe preview uses the same hash verification, srcdoc sandbox, pinned shim, and host services as the website. Use the injected domains; optional domains may be absent. \`requires\` declares mandatory domains; \`relays\` configures fallback relay reads and \`servers\` supplies Blossom resource hints. Empty lists work for self-contained experiments. You can connect your browser extension to test identity changes; the preview never signs or publishes events.\n\nThe local \`previewId\` scopes your saves and is not a Nostr identity. Local bytes are trusted as your editable source and verified by hash in the browser; signature verification applies once a manifest is published. Files offered by napplet.fs stay in the preview session until you download them.\n\nEdit the optional lowercase topic labels in \`napplet.json\` as your idea evolves. They describe the creation, for example \`visual\`, \`generative\`, or \`game\`; they are not exclusive categories.\n\nThe HTML is both the source and playable artifact. Keep it self-contained. Creator identities are managed by the platform CLI account commands. The selected creator and publication targets are in ignored .napplet-space/project.json as public configuration; local private keys stay in your OS credential store and remote sessions use private files outside projects by default (optional Keychain storage). This public reference never authorizes a clone or remix to use another creator’s signer. Use \`soyli publish --dry-run\` to inspect the source and destinations, then make a reviewed Git checkpoint with soyli checkpoint before publishing. Code and pushed Git history are public by default. Git-backed remixes can use soyli propose to send changes upstream, and maintainers use soyli review to inspect and play them. Add --network local to use the dev services. The publisher keeps frozen source and retry state in .napplet-space; keep that directory when moving the project. Publication returns a portable Nostr address and reports when the website has indexed it. Friendly named links are optional and do not affect public interoperability.\n`,
  );
  return target;
}
