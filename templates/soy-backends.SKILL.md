---
name: soy-backends
description: >-
  Build persistent shared rules for a napplet using soyLI dynamic CVM modules: collaborative worlds, inventories, turns, permissions, and state that survives empty rooms. Also use for backend schemas, local preview, deployment, release pinning, conflicts or retry errors. Use the existing scoreboard, NIP-78 sharing or WebRTC guidance when no authoritative custom rules are needed.
---

Read `docs/napplet-space.md` and `docs/napplet-dynamic-backends.md` from the project
root. They describe the installed CLI and exact handler/schema/tool contracts.
Do not infer APIs from another CVM SDK version. `soyli backend --help` and
`soyli backend status --json` expose the installed commands and provider support.

Choose the smallest fitting capability:

- Shared personal bests with a car/loadout attachment: existing scoreboards in
  `docs/napplet-backend.md`.
- Independently published tracks, puzzles or drawings: NIP-78 in `docs/napplet-data.md`.
- Fast movement: WebRTC in `docs/napplet-backend.md`; a CVM transaction is not a tick.
- Authoritative shared edits/rules and durable state: a dynamic module.

For a module, use `soyli backend init-module` once, then edit its three tracked
files and declare its manifest in `napplet.json`. Preserve existing modules and
provider settings. Start with one useful vertical flow through the real host.
Use `docs/examples/minicraft/` for contract examples, not as mandatory game design.

Define bounded input, output and record schemas. Derive authority from `ctx`,
never a player-supplied account/role. Use the shipped backend-context types;
prefer schema access: owner, or compare ctx.principal === ctx.owner (account is
an unprefixed key). Keep handlers self-contained; no runtime imports,
network, filesystem, npm installs, background jobs or trusted client scores.
A successful command commits its state and result together; a failure saves none.

The frontend discovers the active release for new instances and retains each
existing instance's release. Use account consent for durable ownership and make
guest limitations visible. For an uncertain result, retry the exact request ID,
expiry and payload. A conflict requires refresh and a new intent; after expiry,
read state before resubmitting. Do not label local preview data as public data.

For interactive editing, follow "Responsive shared editing" in
`docs/napplet-dynamic-backends.md`: separate pending feedback from confirmed state,
bound queued work and keep background reads from freezing controls. Prefer compact
results and selective reads. Measure local feedback, confirmation and other-player
visibility separately; eventual delivery alone is not a responsiveness check.
The current host has no backend streams or watch API; do not invent one.

Run `soyli backend check` and `soyli dev`; restart preview after backend edits.
Use the documented multiplayer connectIdentity/approveBackendAccount fixtures
for account-required local tests; never open a creator credential for gameplay tests.
Exercise at least two identities, an unauthorized write, simultaneous edits,
retry of a committed request and persistence after restart. Test the game rules,
not only successful tool calls. Stop the preview you started when done.

Public deployment depends on provider support and creator admission. Check that
before promising publication. Commit/push the source, then use
`soyli backend deploy <manifest>` and inspect the signed receipt. Keep existing
worlds pinned; there is no automatic migration. Never switch accounts, remove
permissions or silently replace shared state with local storage to bypass errors.
Report the exact actionable failure and what is verified locally versus remotely.
Keep a short evidence record: build/commit, commands and assertions passed,
skipped or blocked checks, inspected media, public release/receipt (if any), and
the next command needed. A locally working app with publication blocked is not
a published release; do not reinterpret skipped conformance checks as passed.
