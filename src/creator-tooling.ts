function replace(source: string, before: string, after: string) {
  if (source.split(before).length !== 2)
    throw new Error('Upstream tooling guidance changed; review the soyLI adapter.');
  return source.replace(before, after);
}
function section(source: string, from: string, to: string, body: string) {
  const start = source.indexOf(from),
    end = source.indexOf(to, start + from.length);
  if (start < 0 || end < 0)
    throw new Error('Upstream tooling section changed; review the soyLI adapter.');
  return replace(source, source.slice(start, end), body + '\n\n');
}
export function adaptToolingSkill(path: string, source: string) {
  if (path === 'skills/napplet-make/SKILL.md') {
    source = section(
      source,
      '## Step 2 — Triage the directory and toolchain',
      '## Step 3 — Non-negotiables while executing',
      `## Step 2 — Inspect the existing soyLI workspace

Read docs/napplet-space.md before running tools. The project and its skills are
already installed. Inspect package.json, napplet.json, vite.config.ts and src/.
Do not run another scaffold/init command, reinstall skills or require Paja/Kehto.
Use soyli setup for a fresh checkout, soyli run verify for the project checks,
soyli run test:conformance for upstream conformance and soyli check for the host.
Use soyli dev and its printed URL for interactive preview; stop your owned session
after testing. If a surrounding studio owns the preview process, let it manage
that lifetime. A raw Vite URL is not a hosted napplet preview.

Preserve compatible build configuration, dependencies and source history when
contributing to an existing project. Read the installed napplet-port skill when
porting application code. Load the relevant downstream skills explicitly:
napplet-ui for visuals and napplet-test before calling the result verified.`,
    );
    return replace(
      source,
      '- Paja preview URL reported, or Paja explicitly reported unavailable.',
      '- soyLI sandbox preview verified, or the exact missing host check reported as a gap.',
    );
  }
  if (path !== 'skills/napplet-build/SKILL.md') return source;
  source = source.replace(
    /^description:.*$/m,
    'description: Implement a napplet-design spec in an existing soyLI project, preserving its build and host boundaries. Use for application code, backend modules, tests, build checks and hosted preview. Pair with napplet-ui and napplet-sdk.',
  );
  source = section(
    source,
    '## Step 1 — Start from the CLI scaffold',
    '## Step 2 — Project-specific edit points',
    `## Step 1 — Use the existing soyLI project

Read docs/napplet-space.md for the installed tooling contract. This project is
already scaffolded and its skills are installed. Do not run upstream create/init,
reinstall skills or overwrite its package/lock/build configuration.
For a fresh checkout, run soyli setup. Use soyli build and soyli dev for the
hosted app; use soyli run <script> for project checks. Preserve the pinned package
manager and single-file build. Add scripts and source modules as the app needs.`,
  );
  source = replace(
    source,
    '| `.napplet/config.json` | Read-only for you; CLI-owned deployment metadata |',
    '| `napplet.json` | Portable metadata, backend provider/boards/modules and capture settings. Use docs/napplet-space.md; keep identity selection and private state outside Git. |',
  );
  source = replace(
    source,
    '| `README.md`, `docs/*` | Product usage, NAP boundaries, verification notes |',
    '| `README.md`, `docs/*` | Product usage, NAP boundaries, verification notes |\n| `src/**` | Split game, rendering, UI and networking code into useful modules; retain SDK boundaries |\n| `backend/**` | Tracked handler, manifest and schemas; follow soy-backends |\n| `tests/**` | Game rules, hosted multiplayer scenarios and responsive checks |',
  );
  source = replace(
    source,
    'deploy metadata comes from napplet init',
    'soyLI publication metadata comes from napplet.json',
  );
  source = section(
    source,
    '## Step 6 — Preview through Paja, not Vite',
    '## Common pitfalls',
    `## Step 6 — Verify in the soyLI host

Use soyli dev and its printed URL. Stop the session you started afterward.
Run soyli check against the final build and inspect captured screenshots/clips.
For dynamic backends or multiplayer, follow the scenario and identity fixtures in
docs/napplet-dynamic-backends.md and docs/napplet-backend.md. A startup check or
compiler success does not verify game rules, shared state or the public provider.

Report commands, passed assertions, skips and blockers separately. Record whether
the result is verified locally, published, backend-deployed and verified publicly.
If blocked, preserve the build, selected identity and real permissions; provide
the exact error, reproduction and remaining command instead of bypassing checks.`,
  );
  return source;
}
export function adaptToolingBoilerplate(path: string, source: string) {
  if (path === 'README.md') {
    source = replace(source, 'pnpm install\npnpm dev', 'soyli setup\nsoyli dev');
    source = replace(
      source,
      '- A pointer to the current `napplet-*` agent skills (installed with the\n  skills.sh CLI) instead of forked local skill bodies.',
      '- Installed soyLI-adapted agent skills; tooling guidance in docs/napplet-space.md.',
    );
    return section(
      source,
      'For agent-driven work, install the official',
      '## Text Selection',
      'For agent-driven work, use the installed `napplet-make` skill. Read\n`docs/napplet-space.md` first; `soyli skills update` refreshes managed guidance\nwhile preserving your edits. Living NIP-5D and NAP documents remain protocol truth.',
    );
  }
  if (path !== 'AGENTS.md') return source;
  source = replace(
    source,
    '1. Install the current `napplet-*` agent skills with the skills.sh CLI\n   (`npx skills add napplet/napplet`) and follow `napplet-make` for\n   agent-driven napplet work. This template vendors no skill bodies.',
    '1. Read `docs/napplet-space.md` and follow the already installed `napplet-make`\n   skill. Do not re-scaffold or reinstall upstream skills in this project.',
  );
  return replace(
    source,
    'Use `pnpm dev` for shell/manual testing.',
    'Use `soyli dev` and its printed URL for shell/manual testing; stop it afterward.',
  );
}
