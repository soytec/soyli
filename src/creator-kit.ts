import { lstat, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import boilerplate from '../vendor/boilerplate.json';
import skills from '../vendor/skills.json';
import settingsSchema from '../templates/config.schema.json';
import settingsExample from '../templates/napplet-settings.ts.txt' with { type: 'text' };
import actionsGuide from '../docs/RUNTIME-ACTIONS.md' with { type: 'text' };
import controllersGuide from '../docs/CONTROLLERS.md' with { type: 'text' };
import mobileGuide from '../docs/MOBILE.md' with { type: 'text' };
import wasmGuide from '../docs/WASM.md' with { type: 'text' };
import visualGuide from '../docs/VISUAL-DESIGN.md' with { type: 'text' };
import { adaptVisualBoilerplate, adaptVisualSkill } from './creator-visuals';
import { adaptToolingBoilerplate, adaptToolingSkill } from './creator-tooling';
import { adaptManifestBoilerplate, adaptManifestSkill, manifestGuide } from './creator-manifest';
import rustBridge from '../support/napplet.rs' with { type: 'text' };
import bevyAssets from '../support/napplet_bevy.rs' with { type: 'text' };
// Distinct module identity keeps Bun's raw-source cache separate from executable imports.
import gamepadHelper from '../packages/input/src/gamepad.ts?raw' with { type: 'text' };
import backendGuide from '../docs/BACKEND-CREATOR.md' with { type: 'text' };
import dynamicBackendGuide from '../docs/DYNAMIC-BACKENDS-CREATOR.md' with { type: 'text' };
import backendClientExample from '../templates/backend-client.ts.txt' with { type: 'text' };
import backendSkill from '../templates/soy-backends.SKILL.md' with { type: 'text' };
import backendTypes from '../packages/dynamic-backends/src/handler-types.ts?raw' with { type: 'text' };
import minicraftHandler from '../packages/dynamic-backends/fixtures/minicraft/handler.ts?raw' with { type: 'text' };
import minicraftManifest from '../packages/dynamic-backends/fixtures/minicraft/backend.json';
import minicraftSchemas from '../packages/dynamic-backends/fixtures/minicraft/schemas.json';
import sharedDataGuide from '../docs/SHARED-DATA.md' with { type: 'text' };
import outboxGuide from '../docs/OUTBOX.md' with { type: 'text' };
import appDataHelper from '../packages/app-data/src/app-data.ts?raw' with { type: 'text' };
import appDataContract from '../packages/app-data/src/app-data-contract.ts?raw' with { type: 'text' };
import multiplayerSync from '../templates/multiplayer-sync.ts.txt' with { type: 'text' };
import multiplayerScenario from '../templates/multiplayer-scenario.mjs.txt' with { type: 'text' };
import { AccountError } from '../packages/identity/src/signer';

export const upstream = { boilerplate: boilerplate.revision, skills: skills.revision };
const profile = `# napplet soyLI integration

This project includes the pinned napplet/boilerplate and napplet-* skills with
documented soyLI authoring adaptations. Start with napplet-make. Protocol guidance
follows the selected upstream draft in docs/napplet-manifest.md; this note maps
tooling commands to the installed napplet soyLI. Read that guide before editing
capabilities, intents, archetypes or icon metadata. Fresh publications use the
standalone NIP-5D shape; earlier signed napplets remain readable.

Before styling, read docs/napplet-visual-design.md. Choose a visual direction for
the main experience AND its UI/HUD; record it in the project brief. Starter colors,
type, density and settings are replaceable demo choices. App-owned colors are the
default; matching the host is opt-in. Preserve existing art direction on contributions.

Mobile is part of the default delivery. Read docs/napplet-mobile.md before building
the interface and before calling it finished. Verify touch controls and real narrow
viewports in the host; desktop startup checks alone do not establish mobile support.
Prepare representative landscape and portrait promotional media when tooling allows,
and report missing coverage honestly. Never invent a portrait recording option.

## Commands

- The project is already scaffolded. Do not run another creator CLI or re-scaffold it.
- Skills are already installed locally in .agents/skills and .claude/skills.
  The upstream npx skills command is an alternative for other environments.
- For the maintained TypeScript boilerplate, soyli setup prepares the pinned Node/pnpm toolchain and dependencies.
  Nothing is installed globally; ordinary pnpm commands also work if you have it.
- soyli run verify runs the TypeScript boilerplate's upstream guidance/type/build checks.
- soyli run test:conformance runs that boilerplate's upstream reference-shell checks.
  Its pinned test browser is downloaded and cached on first use.
  Report passed, failed and skipped cases separately; skipped is not verified.
  See "Verification boundaries" below before diagnosing a conformance failure.
- soyli dev watches the selected build inside the napplet.soy sandbox (Vite by default).
  Use its URL for preview. The upstream pnpm dev URL serves source without a host.
  Manage project edits name/title, description, tags/license, destinations and assets.
  Capabilities and discovery also edits required/optional domains, archetypes,
  accepted intent parameters and a local icon; changes are saved to napplet.json.
  Its Changes tab reviews files and saves explicit local Git checkpoints; Proposals
  publishes/reviews playable contributions and merges locally. Publish reviews the
  creator, destinations and checked cover/clip before an explicit release.
  Edits use project files; reload if another editor/agent changed them. No silent publish.
  Switch from Play to Listing to inspect the title, description, tags, creator,
  screenshot, optional video clip, license and publishing destinations. Use Capture screenshot after
  the final build; inspect the saved image in Listing before publishing. Captures
  select a new PNG in napplet.json and preserve previous images.
  Enable "Play in a capture window first" to open a fresh interactive capture window.
  Play until a useful moment, then capture or record; close the window to cancel.
  Interactive recording ignores scripted actions/start-delay. The duration still applies.
  The Settings button opens the same live configuration form as the website.
- For the maintained TypeScript boilerplate, soyli build makes dist/index.html. Edit index.html, src/main.ts and
  src/styles.css; keep the upstream Vite configuration and dependency lockfile.
- Rust/WASM or Bevy is an option, not a required starter. Read docs/napplet-wasm.md
  before choosing it. Use the generic Rust build recipe, pinned toolchain/lockfile,
  embedded executable bytes and ordinary NAP host calls. Reuse the same soyli
  setup/build/dev/check/publish/propose commands. Single-threaded WebGL2 first;
  do not assume network-fetched WASM, workers or native engine APIs are available.
  Measure final HTML size early, use the shipped Rust bridge/Bevy asset reader,
  and set preview.readySelector to a real scene-ready milestone before capture.
- soyli config shows effective publishing targets without a signer or build.
  config init writes editable targets into the ignored .napplet-space/project.json binding.
- For shared scores, matchmaking or peer connections, read docs/napplet-backend.md.
  soyli backend init saves portable backend declarations in napplet.json and generates
  ignored .napplet-space/soy-backend.json. Commit napplet.json and module source;
  never force-add .napplet-space. setup/build/dev/run regenerate the public context.
  soyli dev runs an isolated copy of the backend automatically; publishing registers
  declared boards with the creator's authorization. Backend status checks connectivity.
  Boards can declare dataSchema for public JSON attached to each personal best (8 KiB),
  such as a car, drawing or loadout. Use soy.boards.v2 and soy_board_entry for details;
  see the guide's score attachments example. Keep score and run data in one submission.
  Do not drop requested shared data or put it in the player's name to bypass limits.
  Large replay/media bytes belong on Blossom with a URL/hash reference in the data.
- For player-created tracks, puzzles, drawings or presets shared independently of scores,
  read docs/napplet-data.md and use docs/examples/app-data.ts with app-data-contract.ts.
  For ordinary Nostr event reads, live streams and consented publications, read
  docs/napplet-outbox.md. Keep map/app-data specialized write protections intact.
  Default to the documented public NIP-78 convention, with a stable schema label/version
  and application payload validation. Keep drafts in local storage, large files on Blossom.
  Do not invent a CVM collection service or replace requested sharing with local-only saves.
  Check the host's appData policy; generic outbox presence is not write permission.
  Existing social entities still use their standard NAPs. Public records are not private saves.
  Test discovery with another identity, updates after reopening and failed/stale writes.
- For authoritative persistent rules (world edits, inventory, turns), read
  the soy-backends skill and docs/napplet-dynamic-backends.md. Public deployment
  requires a compatible provider and creator admission; check availability first. Use backend init-module,
  declare backend.modules manifests, backend check and soyli dev. Keep handlers
  self-contained; schemas, permissions, retry IDs and release pinning are part of
  correctness. Test two identities, conflicts, retries and restart persistence.
  Restart dev after backend edits. Never weaken ownership checks or switch accounts
  to bypass an error; public player-created content still belongs in NIP-78.
- For real-time multiplayer, read the responsive synchronization section of docs/napplet-backend.md.
  Copy/adapt docs/examples/multiplayer-scenario.mjs into your tests and use
  soyli multiplayer tests/multiplayer.mjs --latency 50 --jitter 15.
  Test a guest's visible movement/aim/shot feedback, not only connection success.
  Connection diagnostics in the preview show route, RTT, buffering and traffic.
  Keep your own game/topology/scenario tests in the project's verification workflow;
  the upstream verify command and soyli check do not certify multiplayer responsiveness.
- soyli check checks the existing built artifact in our host.
- For USB/Bluetooth game controllers, read docs/napplet-controllers.md and use
  docs/examples/gamepad.ts. The Controller tester in soyli dev checks buttons,
  axes, dead zones and test mappings inside the real sandbox. Wire named actions
  into your game; retain keyboard/touch input and handle disconnect/focus/pause.
  Use the native Gamepad API, not SERIAL or an invented gamepad NAP requirement.
  Test actual controllers as well as synthetic input; soyli check is not a hardware test.
- soyli screenshot saves preview.png and selects it in napplet.json.
  Inspect the image: it should show a representative app state, not a blank canvas
  or loading screen. Use screenshot preview-2.png for another capture, or supply
  your own PNG with preview.image. Capture after the final build.
- soyli record saves preview.webm and selects it with the current artifact hash.
  Listing also offers Record clip with start-delay and length controls. It records
  a fresh run, not the interactive session currently on screen. Play and inspect
  it in Listing; keep the static PNG as well. Existing clips are never overwritten.
  For an interaction recipe set preview.recording.actions: timed click (x/y in a
  960 × 600 viewport), keyDown or keyUp with atMs relative to recording start.
  preview.recording.durationMs is 2000–8000; startMs is 0–10000 after normal startup.
  A changed build needs a fresh clip, or remove preview.video to publish only a PNG.
- soyli publish --dry-run inspects source and destinations;
  soyli publish requires a committed clean tree, builds dist/index.html projects,
  then checks the artifact and publishes. Preview/review opening never runs build scripts.
  Ordinary publishing updates the same author-qualified listing and preserves its
  social thread; it does not create a separate snapshot for every edit. Use
  soyli publish --snapshot only when the creator requests an additional immutable
  publication. Pinned /r/ links already select exact signed named revisions.
  Keep the project identifier and selected account unless the user changes them.
- For older single-file projects whose napplet.json entry is index.html, edit
  that file directly and use dev/check/publish; no build toolchain is required.

## Runtime assets

Use soyli assets add <file> <id> --storage external --license <license> or Manage
project. It writes tracked assets/<hash>.<ext>, napplet.assets.json, soy-assets.js
and soy-assets.d.ts. From src/main.ts import { assetUrl } from '../soy-assets.js';
then await assetUrl('jump-sound') for an image/audio/video URL, or a FontFace URL.
Embedded mode uses the upstream Vite import; external uses the standard host resource
capability and a verified Blossom hash. Never use raw remote fetch or public/ paths.
soyli assets list shows credits/bytes/destinations; assets sync regenerates the helper
after a deliberate inventory edit. Unlist preserves originals; update source calls.
Keep lock/helper/originals in Git so another creator can rebuild. Publish/propose
uploads external resources before announcing the playable version; remix verifies
originals. Local preview uses the same sandbox with registered local bytes.

Use PNG/JPEG/WebP/GIF, WAV/Ogg/MP3, WOFF/WOFF2, short MP4/WebM, JSON, plain text
or opaque binary data packs (including custom extensions such as .ssrcpack).
For data, import { assetBlob } from '../soy-assets.js'; then read
await (await assetBlob('game-pack')).arrayBuffer() or .text() with your decoder.
Do not fetch(await assetUrl(...)): even Blob URL fetches are blocked by the sandbox.
The Blob helper works in both storage modes. No separate upload script or nak is
needed: assets add imports locally; publish/propose uploads and verifies bytes;
assets sync regenerates helpers without uploading. After upgrading soyLI, run
assets sync in an existing project, rebuild and test. Format/extension recognition
is not decoding proof: exercise real data/media. Packs are not unpacked or converted.
Raw HTML, SVG/XML and active-document markers remain blocked by resource policy;
credential scans still apply. Only include assets you have permission to publish.
Current budget: 32 assets, 10 MiB each, 32 MiB managed total, within 40 MiB/1,024 source
and release files (including built HTML and previews), with a 50 MiB source tar.
Embedded bytes also consume the 25 MiB HTML budget. The file count is a tooling
safety budget, not a Nostr quota or hosting plan. Host resources still have their
separate 10 MiB limit. Destination Blossom is configurable; provider quotas are unknown.
There is no streaming/transcoding or out-of-Git large-original workflow yet.
Use soyli project show or project set <json-file> for the manager metadata service.
The JSON has name, title, description, topics and license. The manager's Changes,
Proposals and Publish tabs use the same checkpoint/propose/review/merge/publish
services. Keep changes committed before sharing; GUI saves do not auto-commit.

## Make the preview worth opening

Before publishing, plan one frame and one short sequence that show why this
napplet is interesting. Enter the game or main interaction first: a splash screen,
menu or idle character rarely demonstrates the experience. Trigger the mechanic,
show a useful result, or capture the distinctive visual moment. For ambient work,
show its characteristic motion rather than inventing action that does not fit it.

Use preview.recording.actions to reproduce the sequence with soyli record. These
are real captures of the built napplet, not generated illustrations of features it
does not have. Keep text readable at gallery size and exclude host controls. Watch
the saved clip and inspect the PNG for blank/loading frames, cropped subjects,
errors and a missing interaction. Retry when the result fails to tell the story.
A successful capture command only proves a file was created, not that it is good.

Keep the static cover alongside the optional clip. Rebuild after code changes,
recapture as needed, and review both in Listing. Automatic startup capture is a
fallback, not a substitute for choosing a useful frame. The recorder installs its
own cached capture tooling; do not ask the user to install a separate recording
application. Do not claim the current fresh-run recorder captures the visible
interactive browser session, or that GIF export is supported.

## Metadata and host support

napplet.json contains portable name, description, runtime requirements and settings.
.napplet-space/project.json contains the local creator, publication identifier,
upstream and service overrides. soyli config shows effective destinations and both
paths. This binding stays out of Git changes proposed upstream. Never put secrets
in either file. Preserve the binding and journals when moving the project.

New projects expose publish.networks.public and publish.networks.local explicitly:
relay is the primary manifest relay, blossom receives the HTML, source
archive, preview image and selected WebM, grasp is the NIP-34 Git service, and site displays the
result. The defaults use wss://relay.napplet.soy, https://blossom.napplet.soy,
https://git.napplet.soy and https://napplet.soy. Edit those fields to choose services.
CLI --relay/--blossom/--grasp/--site overrides apply only to that publication.
The optional mirrors array receives extra manifest copies only after
our primary relay acknowledges publication; failures do not undo the primary
publication. Use mirrors: [] to disable extra copies. Publishing also copies the
release to the creator's NIP-65 write relays (best effort, at most eight, read from
the current kind 10002 list on each run). Never substitute a foreign
primary relay silently. relays and servers at the top level are runtime read and
resource hints, not publishing destinations. Git must provide NIP-34/GRASP support.

A new release may change Blossom, site and mirrors. Existing relay/Git history
requires explicit migration when moving those services; --resume always uses the
saved release destinations. Keep the publication journal to preserve that history.

Publishing automatically captures a 1200 × 750 PNG from the sandbox when no
preview.image is selected, using preview.delayMs (1500 by default, 250–10000).
It uploads the PNG to the selected Blossom server and signs its hash/MIME in the
napplet manifest. The optional soy.presentation/1 convention uses presentation,
screenshot and preview tags; these are not established NIP-5D fields. Clients that
ignore them can still play the same napplet. No new Zapstore event is generated.
This fallback prevents accidental
imageless releases; an inspected screenshot is still the preferred finishing step.
For an interactive scene needing a start click, take a representative PNG during
manual/browser testing and select it with preview.image. Only PNG up to 5 MiB and
4096 × 4096 is currently accepted. Remove preview.image to resume automatic capture.
Optional clips use silent VP8 WebM up to 5 MiB, 1200 × 750 and 12 seconds.
soyli record produces 960 × 600 video; the recorder may add a brief final frame.
Publishing freezes its bytes and a signed preview hash/MIME on the napplet manifest,
retaining a screenshot for clients that do not display video. Never fabricate a clip
or change preview.video.artifactHash to bypass the stale-build check.
The local preview setting is authoring configuration, not a new Nostr manifest tag.

Readable routes are a one-time website claim, not an automatic publish step.
After publishing, open the napplet page, connect the same creator account and
choose Named link to claim /@your-handle/your-slug. The name follows later releases.
Existing published napplets can claim a name without republishing.

## Local Git checkpoints and public releases

New projects start with the completed scaffold and guidance already committed
locally as "Initialize napplet with soyLI", attributed to napplet soyLI rather than
a creator identity. Git-backed remixes start at the original published commit and
preserve its history. Inspect git log and git status when resuming older projects
or archive/HTML remixes; they may still need their first reviewed checkpoint.
Commit coherent changes after the relevant checks. Before pausing or handing the
project back, save a checkpoint even if the whole napplet is unfinished; describe
outstanding issues accurately in its message. Do not wait for publication to preserve work.
Follow the creator's Git preferences and inspect git status and git diff first.
Review the files being staged, including new files; do not sweep unrelated work or
secrets into a commit, rewrite history, or push without the creator's authorization.

Use soyli checkpoint "Describe your changes" (or ordinary git add/commit) to save
reviewed changes. soyli publish and soyli propose require a clean committed tree.
When shared, code and pushed Git commit ancestry are public and open source by
default. Ignoring a file does not erase its old committed contents. Keep private
notes and generated state ignored and keys outside the project. The public source
archive is the actual Git tree; ignored built HTML and previews are separate blobs.
The hash-verifiable archive supports recovery, offline inspection and independent
mirroring alongside the Git repository. The public website, indexer and runtime
must deploy the 25 MiB artifact limit before admitting HTML above 10 MiB; a CLI
update alone does not update them or an older website's source-browser file cap.
publish.files only adds release inputs; it cannot narrow tracked source or history.
Tracked files need no explicit list, and napplet.json stays limited to 16 KiB.
Safe relative source aliases such as CLAUDE.md -> AGENTS.md may remain in current
and historical Git trees. Each must resolve to a public regular file in the same
tree and selected source; target contents pass the same credential checks.
Checkpoint, publication and Git remixes preserve links and history. Downloadable
source archives and archive remixes use regular copies of exact committed target
bytes; copies count toward source limits. No replacement or history rewrite is
needed for a safe alias. Absolute, escaping, dangling, cyclic, directory, private
and unselected targets remain blocked. Configuration, playable artifacts, managed
assets, presentation files and backend build inputs must still be regular files.

One remix supports both paths, in either order:
- soyli publish releases your own version under its local publication identity.
- soyli propose "Description" submits an ordinary NIP-34 proposal upstream with a
  checked runnable preview, without creating a contributor repository. Run it
  again after a new checkpoint to update that PR. Use propose --resume only after
  a signed proposal was saved; a preparation timeout needs the original command.
- soyli review opens the local proposal inbox, source diff and original/proposed
  player. Opening a review never runs contributor setup/build scripts. Explicit
  review <id> --rebuild opts into them in a temporary checkout.
- soyli proposals --json gives agent-readable proposals and exact revisions.
- soyli merge <id> --revision <event-id> --target <reviewed-HEAD> merges locally.
  Merge on the upstream target branch. soyli push publishes that branch and
  confirmed applied status, preserving other refs; soyli publish releases the
  napplet separately. A failed push keeps its journal; rerun it from the same tip.
Use the same selected revision for testing and merge. A changed target or proposal
requires another review. Ordinary Git/ngit remain available for branches, patches,
conflicts and maintainer layouts outside this simple creator workflow.

## Pause and resume an existing creation

Keep the same folder, .git history, napplet.json and local publication binding in the ignored
.napplet-space journal. For an AI handoff, save a private .napplet-space/RESUME.md
with the current goal, changed files, checks and results, known host limitations,
and next steps. Never include credentials. Do not put a private handoff in public
source files. A new AI session should read it and inspect Git before changing code.

After a soyLI release, stop the old dev process, update the executable using the
installer without new/remix arguments, and run soyli skills update in this folder.
Review reported conflicts; edited guidance is preserved. Start soyli dev again to
use the updated bundled host. Skills update does not replace source or dependencies;
follow explicit migration instructions if a release needs changes to those.
Respect the user's currently selected account (soyli account show). Never restore
an old project creator or call account use/create/import/connect to bypass an
error unless the user asked you to change accounts. The user may switch accounts
at any time; do not scaffold a replacement project. Each sharing operation keeps
the account it started with. Switching signing methods for the same public key
keeps its publication history. A different public key publishes a separate listing
and Git repository; the original listing and its history remain intact. Status
and publish --resume refer to the selected public key's saved releases. Backend
scoreboards also use separate author namespaces; existing scores are not moved.
soyli publish --resume resumes a saved PUBLICATION, not authoring: it uploads the
old frozen bytes even if current files changed. Ordinary editing needs no resume flag.

When a command fails, read its operation, cause, exit/status and recovery step.
Use --json where supported to inspect the structured error; project run/exec
arguments are passed to the underlying tool. Include soyli version/platform and
the diagnostic when reporting a host/tool failure. Inspect soyli status before
retrying publication. Do not replace identities, disable validation or change
destinations just to bypass an error. Fix the cause and resume the saved job when
appropriate. Never print credentials in scripts or paste them into bug reports.

## Creator backup

Creating a local identity also saves its private key as an nsec file outside this
Git project. The CLI prints the path before installing dependencies. By default
it is \`~/.config/napplet-space/accounts/public/<public-key>.nsec\` (local-network
identities use accounts/local). The file has owner-only permissions. Preserve a
private copy: it is unencrypted and can recover the creator identity.

soyli account backup saves or locates that file for an existing local
creator. To restore it, use soyli account import --stdin < /path/to/key.nsec.
Signing continues to use the OS credential store; the project contains only the
public creator reference. Remote-signer identities are backed up in their signer.
Never copy the key into source, skills, browser code, or published assets.

## Remote signer sessions

soyli account pair (or account connect with a hidden bunker link) defaults to a
private session file outside this project. This holds the approved client key and
relay hints, never the remote creator's private key. No Keychain or desktop keyring
is needed for these sessions. --session-storage keychain opts into the OS vault.
account show/list reports the stored choice. To move an existing remote account,
use soyli account storage file; this preserves the pairing and needs access to its
old vault once. Retry that command if it reports unfinished old-copy cleanup.
Local private keys still use the OS vault. Never copy sessions into project files,
source archives or environment dumps. Do not re-pair just to change storage.

## Preview process ownership

Keep one preview per project and reuse the URL it prints. Do not assume port 4173:
when it is busy soyli dev selects another free port; use --port 0 for isolated tests.
Keep the terminal/tool session handle or PID when starting a preview. Stop that
session with Ctrl+C or SIGTERM in cleanup after browser tests and recordings, and
verify that its listener closed. Never kill all Bun/Node processes or an unknown
process just because it owns the desired port. Do not start a replacement preview
while leaving your earlier one behind.

Leave a preview running only for an intentional user handoff; report its project,
actual URL and how to stop the owning session. Keep its launcher alive. soyLI stops
its preview and detached build watcher on Ctrl+C, SIGTERM, terminal hangup or loss
of a known launcher. Closing a browser tab is not a shutdown. Forced kills, surviving
background launchers and already-orphaned processes still need explicit owner cleanup.

## Verification boundaries

The pinned @napplet/conformance-cli 0.2.15 reference harness advertises empty objects
for most domains while only installing resource methods. A storage namespace can
therefore exist without working methods. It also reports installedGlobal from the
absence of boot errors, so an app exception can be described as missing injection.
Inspect the original boot error and reproduce in soyli dev before attributing it
to the app or changing its capability requirements. Do not install a shim inside
the napplet or weaken checks to make the report green. Keep the conformance result,
soyli check result and real interaction evidence separate. The pinned suite can
skip manifest, wire and lifecycle cases; that is unmeasured coverage.

For optional capabilities, wrap the SDK call itself in try/await/catch; attaching
.catch to its result alone misses synchronous exceptions. If an optional save fails,
keep the app usable and explain that progress was not saved. Do not silently treat
failed required capabilities as success. Include your game/interaction regression
tests in your normal verification command, not only in a one-off test run.

## Runtime capabilities

For Vite projects, keep hard domain requirements in vite.config.ts; the publisher reads the build's
napplet-requires metadata and checks it against this host. Optional domains must
degrade gracefully, following upstream guidance. Use the injected namespace and
SDK; do not add a bootstrap or a private protocol extension to app code.
Local requires becomes signed R; optionalDomains becomes O. Archetypes, intents
and icon metadata are configured in napplet.json, not inferred from starter code.
See docs/napplet-manifest.md. The plugin's optional legacy event is not published.
Rust projects declare requirements in napplet.json.requires, use the same injected
namespace through docs/examples/napplet.rs and follow docs/napplet-wasm.md. Their
Cargo tests/build and soyli check replace TypeScript-only package scripts; do not
claim that these ran the upstream reference harness.

This host provides configuration, identity, storage, theme, resource, relay/outbox reads,
common reads/writes, user-confirmed links, file imports/session exports, Blossom uploads,
public list edits, scoped public NIP-78 records, media, ContextVM and WebRTC. See docs/napplet-actions.md for exact
APIs, examples and limits (soyLI 0.15.0; remote websites need the matching deployment).
Use fs pickers for user-selected copies; they never edit original device files.
Uploads and follow/react/report/list changes require the connected viewer's signer
and host approval; never borrow the creator publishing key. In local preview connect
a browser extension. The website uses its selected Applesauce account.
Use upload.info and lists.supported; handle denial, missing identity and asynchronous
upload status, and never assume private list support. Generic signer operations,
arbitrary relay/outbox publishing and cross-napplet writes are not granted.
The app-data write subset uses docs/napplet-data.md and the optional shell appData
policy hint; a matching website deployment is required as well as the CLI update.
A domain's presence does not promise that every operation will be permitted.
Our host check complements upstream conformance; report each result separately.

soyLI 0.8.2 supports public WSS relay hints through the shared host. napplet.json
relays are fallback read destinations; they are separate from publish.networks
relay/mirrors. Use outbox.query/getEvent with options.relays when an event lives on
a particular relay. The host also resolves NIP-65 author write relays for reads.
Public hints need WSS on port 443, without credentials or fragments; private/LAN
destinations are denied. Local preview additionally permits explicitly configured
literal-loopback WS relays. Check result.error and result.incomplete before treating
an empty query as confirmed absence. Verify lookup and playback together on both
preview and the deployed host. Do not republish another author's event to work
around a lookup failure or bypass the iframe's network restrictions.

Check injected domain availability before implementing a capability-dependent feature:
an SDK export or passing upstream reference-shell test does not mean soyLI or the
deployed website implements that domain. Local and deployed versions may differ.
soyLI 0.8.0 adds NAP-MEDIA shell-owned audio/stream playback. The website needs the
matching deployment; upgrading one does not upgrade the other. Use the upstream SDK
media.createSession with owner: 'shell', source.url (public HTTPS), optional audio
metadata, live: true for radio, and autoplay: false when showing your own play button.
Wait for the result's canonical sessionId, subscribe with onState/onCapabilities,
then sendCommand for play/pause/stop/volume. Destroy sessions when leaving the view.
MP3, Ogg audio and WAV are supported subject to browser codecs. The host handles
streaming, source checks and gesture prompts. Only use advertised controls; no seek,
playlists/HLS/DASH, video, napplet-owned sessions or hash/Nostr-only source resolution
is implemented. Nostr hints and session context are metadata, not network authority.
Artwork is not loaded by this audio host. Four sessions per frame are allowed; one
plays at a time. Streams stop at 128 MiB or two hours and close with the napplet.
Small embedded data/blob audio and Web Audio are separate browser features, subject
to user activation and codec support. Do not work around missing media support by
adding direct remote URLs, fetch, an unbounded resource download or a looser CSP.
For clients without media, keep a clear unavailable state or user-confirmed link
fallback; if playback is the core purpose, declare media required and report the
host gap. Test the actual play/pause/volume flow, not only build/startup or relay lookup.

## User-facing settings

config.schema.json declares the napplet's NAP-CONFIG settings. The upstream Vite
plugin embeds it as napplet-config-schema metadata inside the signed HTML build.
This is separate from napplet.json, which configures publication and infrastructure.
The starter's src/napplet-settings.ts uses the upstream SDK config.subscribe to
apply text size, control height and text selection live. Replace these example
properties with settings relevant to the creation. Keep sensible in-app fallbacks
when config is optional; declare requires: ['config'] in the existing Vite plugin
only if the core experience cannot work without it.

Use the NAP-CONFIG Core Subset: typed properties, literal defaults, enum choices,
numeric/string/list bounds and nested objects (at most four levels). No refs,
regex patterns, expressions or conditional schemas. x-napplet-section and
x-napplet-order organize the form. config.openSettings can open it from an app
control. The starter uses the host's config.schema when available. If a compatible
host has not loaded the build's schema, it registers the same config.schema.json
through config.registerSchema before subscribing. Preserve that fallback when
editing settings; do not replace a schema the host already supplied. Embedded
build metadata alone is not consumed by every client.

For these pinned packages, edit config.schema.json as the single schema source.
The Vite plugin emits the static metadata; src/napplet-settings.ts supplies the
runtime registration fallback; the SDK exposes calls, and the host decides what
is supported. Read the installed package types before using an API from a newer
NAP proposal. Do not add a second, divergent schema in vite.config.ts or app code.

The host validates edits and pushes values; a napplet cannot write configuration.
Space scopes values by verified creator/address/build and viewer. A new build
starts fresh. Non-secret settings persist on this browser; x-napplet-secret
string fields are masked, have no default, and last only for the running session.
Never use settings to request the creator's signing key. Check Settings in the
local preview, including defaults, live changes and a reload, before publishing.

## Upstream maintenance

Pinned boilerplate: ${boilerplate.repository}/tree/${boilerplate.revision}
Pinned skills: ${skills.repository}/tree/${skills.revision}

The vendored snapshots and licenses are retained. Local changes: package name,
this integration note, agent entry pointers, private-state gitignore entries, a
static settings example and its main.ts import, opt-in host colors in main.ts,
and a CSS header explaining the demo's replaceable styling. Generated authoring
docs and skills replace uniform density/whole-surface host-matching mandates with
project-specific visual direction for content and UI. Generated manifest guidance
is adapted to the selected standalone NIP-5D draft; vendor snapshots stay intact.
NAP message APIs and the pinned build plugin are unchanged.
Installed skill folders are excluded from the boilerplate's repository-guidance
scan; the schema-free-starter assertion checks our static settings example instead.
Run
soyli skills update to install the CLI's bundled skill revision; modified
files are reported as conflicts and preserved. Template/source changes are never
applied by that command.
`;

const pointer = `## napplet soyLI workspace\n\nRead [docs/napplet-space.md](docs/napplet-space.md) first for this project's CLI commands, installed skills, preview cleanup and host capabilities. Read [docs/napplet-visual-design.md](docs/napplet-visual-design.md) before styling the creation and its UI. This project and its adapted skills are already installed; do not re-scaffold or reinstall them. Use soyli dev and its printed URL for hosted preview, and stop your preview session after testing. Use the upstream guidance below with those tooling mappings.\n\n`;

export function creatorSkills() {
  const files: Record<string, string> = {
    'docs/napplet-space.md': profile,
    'docs/napplet-backend.md': backendGuide,
    'docs/napplet-dynamic-backends.md': dynamicBackendGuide,
    'docs/examples/backend-client.ts': backendClientExample,
    'docs/examples/backend-context.d.ts': backendTypes,
    '.agents/skills/soy-backends/SKILL.md': backendSkill,
    '.claude/skills/soy-backends/SKILL.md': backendSkill,
    'docs/examples/minicraft/handler.ts': minicraftHandler,
    'docs/examples/minicraft/backend.json': JSON.stringify(minicraftManifest, null, 2) + '\n',
    'docs/examples/minicraft/schemas.json': JSON.stringify(minicraftSchemas, null, 2) + '\n',
    'docs/napplet-data.md': sharedDataGuide,
    'docs/examples/app-data.ts': appDataHelper,
    'docs/examples/app-data-contract.ts': appDataContract,
    'docs/napplet-outbox.md': outboxGuide,
    'docs/napplet-actions.md': actionsGuide,
    'docs/napplet-controllers.md': controllersGuide,
    'docs/napplet-mobile.md': mobileGuide,
    'docs/napplet-wasm.md': wasmGuide,
    'docs/napplet-visual-design.md': visualGuide,
    'docs/napplet-manifest.md': manifestGuide,
    'docs/examples/napplet.rs': rustBridge,
    'docs/examples/napplet_bevy.rs': bevyAssets,
    'docs/examples/gamepad.ts': gamepadHelper,
    'docs/examples/multiplayer-sync.ts': multiplayerSync,
    'docs/examples/multiplayer-scenario.mjs': multiplayerScenario,
    'docs/napplet-skills-LICENSE.txt': skills.files.LICENSE,
    'CLAUDE.md':
      '@AGENTS.md\n\nThe adapted napplet skills are installed in .claude/skills; begin with napplet-make. Read docs/napplet-space.md and docs/napplet-visual-design.md.\n',
  };
  for (const [path, text] of Object.entries(skills.files)) {
    if (!path.startsWith('skills/')) continue;
    const adapted = adaptManifestSkill(path, adaptToolingSkill(path, adaptVisualSkill(path, text)));
    for (const agent of ['.agents', '.claude']) files[`${agent}/${path}`] = adapted;
  }
  return files;
}

export function boilerplateFiles(name: string) {
  const files: Record<string, string> = Object.fromEntries(
    Object.entries(boilerplate.files).map(([path, text]) => [
      path,
      adaptManifestBoilerplate(
        path,
        adaptToolingBoilerplate(path, adaptVisualBoilerplate(path, text)),
      ),
    ]),
  );
  files['package.json'] =
    JSON.stringify({ ...JSON.parse(files['package.json']), name }, null, 2) + '\n';
  files['AGENTS.md'] = pointer + files['AGENTS.md'];
  files['README.md'] = pointer + files['README.md'];
  files['config.schema.json'] = JSON.stringify(settingsSchema, null, 2) + '\n';
  files['src/napplet-settings.ts'] = settingsExample;
  files['src/main.ts'] = "import './napplet-settings.js';\n" + files['src/main.ts'];
  files['.gitignore'] +=
    '\n# Napplet Space private build/publication state\n.napplet-space/\n.nip5a-manifest.json\n';
  // Upstream scans all text, including negative examples in installed skills.
  // Keep its assertions intact; installed agent bundles are not template source.
  const original = "new Set(['.git', 'dist', 'node_modules'])";
  if (!files['tests/guidance.test.mjs'].includes(original))
    throw new Error('Upstream guidance scanner changed; review the adapter.');
  files['tests/guidance.test.mjs'] = files['tests/guidance.test.mjs'].replace(
    original,
    "new Set(['.git', 'dist', 'node_modules', '.agents', '.claude', '.napplet-space'])",
  );
  const skillInstall = 'assert.match(sources.get(path), /npx skills add napplet\\/napplet/, path);';
  if (!files['tests/guidance.test.mjs'].includes(skillInstall))
    throw new Error('Upstream skill-install guidance changed; review the adapter.');
  files['tests/guidance.test.mjs'] = files['tests/guidance.test.mjs'].replace(
    skillInstall,
    'assert.match(sources.get(path), /docs\\/napplet-space\\.md/, path);',
  );
  const schemaFree = "assert.equal(sources.has('config.schema.json'), false);";
  if (!files['tests/guidance.test.mjs'].includes(schemaFree))
    throw new Error('Upstream static-schema guidance changed; review the adapter.');
  files['tests/guidance.test.mjs'] = files['tests/guidance.test.mjs'].replace(
    schemaFree,
    "assert.equal(JSON.parse(sources.get('config.schema.json')).type, 'object');",
  );
  return files;
}

const hash = (text: string) => new Bun.CryptoHasher('sha256').update(text).digest('hex');
async function safeParent(root: string, path: string) {
  if (
    !/^[a-zA-Z0-9._/-]+$/.test(path) ||
    path.startsWith('/') ||
    path.split('/').some((p) => p === '..' || !p)
  )
    throw new AccountError('SKILLS_PATH', 'Invalid managed skill path.');
  let current = root;
  for (const part of path.split('/').slice(0, -1)) {
    current = join(current, part);
    await mkdir(current, { mode: part === '.napplet-space' ? 0o700 : 0o755 }).catch((error) => {
      if (error.code !== 'EEXIST') throw error;
    });
    const stat = await lstat(current);
    if (!stat.isDirectory() || stat.isSymbolicLink())
      throw new AccountError('SKILLS_PATH', 'Skill directories must not be symlinks.');
  }
  return join(root, path);
}

/** Add/update only our recorded bundle; a creator edit is never an overwrite target. */
export async function installCreatorSkills(directory: string) {
  const root = resolve(directory);
  const statePath = await safeParent(root, '.napplet-space/skills.json');
  const stateStat = await lstat(statePath).catch(() => null);
  if (stateStat && (!stateStat.isFile() || stateStat.isSymbolicLink() || stateStat.size > 65536))
    throw new AccountError('SKILLS_STATE', 'Invalid skill update record; it was not overwritten.');
  const previous: Record<string, string> = stateStat
    ? JSON.parse(await readFile(statePath, 'utf8')).files
    : {};
  if (!previous || typeof previous !== 'object')
    throw new AccountError('SKILLS_STATE', 'Invalid skill update record.');
  const files: Record<string, string> = {},
    updated: string[] = [],
    conflicts: string[] = [];
  for (const [path, text] of Object.entries(creatorSkills())) {
    const target = await safeParent(root, path);
    const stat = await lstat(target).catch(() => null);
    const existing =
      stat?.isFile() && !stat.isSymbolicLink() && stat.size < 1024 * 1024
        ? await readFile(target, 'utf8')
        : undefined;
    if (
      stat &&
      existing !== text &&
      (existing === undefined || previous[path] !== hash(existing))
    ) {
      conflicts.push(path);
      if (previous[path]) files[path] = previous[path];
      continue;
    }
    if (existing !== text) {
      const temporary = join(dirname(target), `.skill-${crypto.randomUUID()}`);
      await writeFile(temporary, text, { flag: 'wx' });
      await rename(temporary, target);
      updated.push(path);
    }
    files[path] = hash(text);
  }
  const temporary = `${statePath}.${crypto.randomUUID()}`;
  await writeFile(temporary, JSON.stringify({ version: 1, upstream, files }, null, 2) + '\n', {
    flag: 'wx',
    mode: 0o600,
  });
  await rename(temporary, statePath);
  return { upstream, updated, conflicts };
}
