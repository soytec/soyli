# Standalone CLI migration

Imported from the local `napplet-soy` checkout at Git HEAD
`9895ad86b8cd3aed9d18908d9e8496e82f7981fe` on 2026-10-22. This identifies the
source checkout; the imported files reflect its working tree. Original MIT
license and bundled upstream license notices are preserved.

The CLI is the primary application: source lives in `src`, regression tests in
`src/__tests__`, and templates, support files, vendor snapshots, and distribution
metadata live at the repository root.

The CLI source, regression tests, templates, Rust helpers, distribution metadata,
vendor snapshots, and the shared source files it imports are local to this repo.
Creator guides and preview styles are included. The installer embedded by the
update command lives in `support`, with no dependency on a web app.
Dependency versions are retained from the source project and locked locally.

`bun run build` compiles for the host platform and embeds preview assets. It stages
both supported Playwright profiles and ws alongside the executable. Keep `dist/lib`
with the binary when relocating it. Browser installation is a separate, on-demand
operation, as in the original CLI.

## Remaining release work

- The imported version metadata remains the upstream CLI version; package.json's
  initial repository version does not establish a new public release.
- `soyli update` and its embedded installer still use the existing upstream release
  channel. A standalone release channel, installer URLs, and version policy need
  to be established before publishing this fork independently.
- Cross-platform release archives, hosted installer delivery, CI, and Nix packaging
  have not been migrated. The local build uses the installed Bun version.
- The website, studio, hosted services, and their service/browser integration test
  suites are outside this extraction. The migrated CLI tests run locally here.

Public network destinations and pinned downloads remain external services, as
required by the CLI's publishing and toolchain behavior. Self-contained here means
all CLI implementation and bundled resources belong to this repository.

## Verification

The imported CLI suite passes 87 tests. Type checking and a host executable build
pass on Bun 1.4.3/Linux x64. `bun scripts/smoke.ts` copies the built distribution
to a temporary directory outside this checkout, scaffolds a project, starts its
preview, and checks its HTTP response. Hosted publication and other platforms
have not been verified as part of this migration.
