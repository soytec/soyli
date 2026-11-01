# Standalone CLI migration

Imported from the local `napplet-soy` checkout at Git HEAD
`9895ad86b8cd3aed9d18908d9e8496e82f7981fe` on 2026-10-22. This identifies the
source checkout; the imported files reflect its working tree. Original MIT
license and bundled upstream license notices are preserved.

## Upstream sync

CLI and included shared implementation changes through upstream commit
`e70792cc85aeaf35238084ac5a50527a4317895b` (`napplet-soy/main`, 2026-11-01 sync)
have been ported from the original extraction baseline. This includes upstream
CLI version 0.31.4,
publish-time proposal reconciliation, retained-media review, check coverage,
and coordinated napplet-owned audio. The coordinated-audio creator example
and relevant publication/runtime regression tests are included locally.

The standalone paths, build scripts and exact Bun 1.4.3 build requirement are
preserved. Website, Studio, wallet, deployment and service/browser integration
suites remain outside this repository. This is a source port, not a Git-history
merge; updates still use the monorepo release channel described below.

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
  have not been migrated. The local build requires the version in `.bun-version`.
- The website, studio, hosted services, and their service/browser integration test
  suites are outside this extraction. The migrated CLI tests run locally here.

Public network destinations and pinned downloads remain external services, as
required by the CLI's publishing and toolchain behavior. Self-contained here means
all CLI implementation and bundled resources belong to this repository.

## Verification

The 2026-11-01 sync passes 154 tests across 29 files, type checking, a host
executable build and the relocated-distribution smoke test on Bun 1.4.3/Linux
x64. Tests used `TMPDIR=/var/tmp/soyli-validation` because this environment's
`/tmp/.git` causes account-safety checks to reject test account directories.

The imported CLI suite passes 87 tests. Type checking and a host executable build
pass on Bun 1.4.3/Linux x64. `bun scripts/smoke.ts` copies the built distribution
to a temporary directory outside this checkout, scaffolds a project, starts its
preview, and checks its HTTP response. Hosted publication and other platforms
have not been verified as part of this migration.
