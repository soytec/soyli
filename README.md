# soyli

Standalone Bun source repository for the Soy CLI. CLI code, shared implementation,
creator templates, pinned starter snapshots, and browser preview assets live here;
no checkout of the original napplet-soy project is required.

Requires Bun 1.4.3 or newer for development. CLI builds require the exact version in
`.bun-version` (currently 1.4.3), which is embedded in the executable. Git is needed
for source collaboration.

```sh
bun install --frozen-lockfile
bun run soyli --help
bun run soyli --version
bun run soyli new ./my-napplet --identity later --no-install
bun run soyli dev --project ./my-napplet
```

Validate and build:

```sh
bun run typecheck
bun test
bun run build
bun scripts/smoke.ts # verifies a relocated distribution
./dist/soyli --help
```

The build embeds the creator resources and preview bundle, and places dynamically
loaded Playwright and WebSocket libraries in `dist/lib`. Distribute the entire
`dist` directory, including licenses. The executable needs no separate Bun install.
Chromium and project toolchains download on demand. Signing, publishing, and
collaboration still require their configured services; native key storage uses
the operating system credential store.

All implementation lives in `src`: `index.ts` starts the CLI, `commands/` handles
command dispatch, `services/` contains workflows and integrations, and `helpers/`
contains small shared utilities. Backend infrastructure, browser runtime, preview,
creator tooling, toolchains, and distribution support each have focused folders.
Tests live beside their modules in `__tests__/`; shared fixtures live in `tests/fixtures/`
and runnable examples in `examples/`. Templates, support files, vendor snapshots,
and distribution metadata remain at the repository root. See
[migration notes](docs/MIGRATION.md) for provenance and remaining release infrastructure work.

## Internal imports

Use the single root `package.json` source alias across features, for example
`#src/protocol/events.ts` or `#src/services/identity/accounts.ts`. Keep relative
imports within a feature and include the file extension. Import browser-safe
modules directly rather than through barrels that also load Bun-only services.
No TypeScript path aliases or extra package manifests are needed.

Resource paths (`new URL(...)` and `?raw` imports) remain relative. Templates and
vendor snapshots must not depend on this repository's private import aliases.
