# Shared scores and peer sessions with soyLI

This guide ships in every soyLI project as `docs/napplet-backend.md`.
It describes the Soy v1 service contract and the standard NAP-CVM / NAP-WEBRTC
APIs. The app owns game rules, simulation, synchronization and UI. The host owns
transport keys, Nostr connections, signaling, peer connections and permissions.

The host asks once before connecting to peers and remembers the player's Allow
or Block choice in that browser for the host site. Players can change it in
Network settings (also available in soyLI preview). Dismissing leaves it unset;
blocked requests return an error. Keep a retry path in your connection UI.
Direct connections and TURN fallback are automatic; no TURN controls are needed
inside your napplet. The setting does not grant access to unfamiliar CVM providers.

## Enable a backend

In an existing or new boilerplate:

```sh
soyli skills update
soyli backend init
```

`init` saves portable backend configuration in `napplet.json`, uses your selected creator, and resolves
the site's default public provider. It never uploads a game. If that provider is
offline, local preview still works; run `backend sync` and rebuild when available.
Read the printed provider key and relay destinations.

The selected account also determines the author namespace during `backend sync`
and publishing. Switching public keys creates separate boards; existing scores
stay under their original author. Switching back reuses that namespace. A remote
signer for the same public key keeps the same boards. Sharing rebuilds the public
backend context before checking the game; it never changes your account selection.

The provider and board definitions remain editable:

```json
{
  "backend": {
    "provider": {
      "pubkey": "<64-character-provider-public-key>",
      "relays": ["wss://relay.napplet.soy"]
    },
    "boards": [
      {
        "board": "highscore-v1",
        "title": "High scores",
        "order": "highest",
        "minimum": 0,
        "maximum": 1000000
      }
    ]
  }
}
```

This is a fragment to merge into the existing file, not a replacement project.
Use `boards: []` for matchmaking without scores. The CLI generates public
`.napplet-space/soy-backend.json` with `{version, napplet, provider, boards}`. Import it from your
source (`import backend from '../.napplet-space/soy-backend.json'` in `src/main.ts`). Do not
handwrite its naddr, copy a different creator's namespace, or put secrets in it.
This context is generated and Git-ignored, alongside private data: never force-add
`.napplet-space/`. Commit `napplet.json` and declared module source instead; the
public provider/destinations are inspectable there. `soyli setup`, `build`, `dev`
and `run` regenerate the context before invoking project tools. After an ordinary
Git checkout use `soyli setup` before a direct package-manager build. Remixes
regenerate their own author-qualified namespace. Backend configuration inherited
from older local bindings is made portable by rerunning `soyli backend init`.

Add `cvm` to the existing Vite plugin's `requires` array, and `webrtc` if peer
connections are essential. Retain other requirements and the upstream build.
Use the injected `window.napplet` APIs through the upstream SDK; never create a
second iframe bridge or an RTCPeerConnection in the sandbox.

```sh
soyli dev          # rebuilds in the shared host, with isolated local backend data
soyli build
soyli check
soyli publish --dry-run
soyli publish      # registers configured boards with creator authorization
```

The default local preview starts the **same CVM implementation** used by the
website, with its own loopback relay and SQLite data in `.napplet-space/backend`.
It maps the configured provider to the local one: preview scores never reach the
public board. Screenshot/record/publish checks create a fresh temporary backend
with the same configured boards, so automated captures do not submit public scores.
No global Bun/Node or separate backend setup is needed. Restart
`dev` after changing board definitions. Changed immutable rules need a new board
ID; ordinary rebuilds preserve scores. Two separate browser profiles/contexts can
join the same dev URL. Duplicated tabs can inherit the same session identity; use
separate contexts for independent players. Remote-device preview/TURN is not
configured by the default loopback preview.

`soyli backend status` probes the selected public provider over encrypted Nostr.
`soyli backend sync` explicitly registers boards ahead of publishing. If it pins
or changes a provider, rebuild afterward. `publish --resume` resumes frozen bytes
and does not change backend configuration. Existing creations need a CLI update,
`skills update`, and a restarted dev server; no re-scaffolding is required.

## Calling the service

The following examples are JavaScript; use the upstream SDK's types in TypeScript.
Obtain the injected namespace after the boilerplate's existing ready handshake.
The published artifact must import the generated context so it knows its own
stable author-qualified naddr. Relay hints are not part of namespace identity.

```js
import { cvm, webrtc } from '@napplet/sdk';
import backend from '../.napplet-space/soy-backend.json';

async function call(tool, args = {}, boardFamily = 'soy.boards.v1') {
  // The preview host maps this public provider to the isolated local service.
  // Before the default provider is available, the configured registry also works.
  const result = backend.provider
    ? await cvm.callTool(backend.provider, tool, args)
    : await cvm.registry.call(
        tool.startsWith('soy_board_')
          ? boardFamily
          : tool.startsWith('soy_match_')
            ? 'soy.matchmaking.v1'
            : 'soy.rooms.v1',
        tool,
        args,
      );
  if (result.isError) {
    throw new Error(
      result.content
        ?.filter((x) => x.type === 'text')
        .map((x) => x.text)
        .join('\n') || 'Backend request failed',
    );
  }
  return result.structuredContent;
}
const { actor } = await call('soy_session');
```

The transport actor is a host-owned key scoped to this browser tab, napplet and
viewer. It is shared by CVM and WebRTC, survives a reload in that tab, and is
separate from a logged-in Nostr profile. Guests work without signing in. Never
use the creator's key for gameplay or interpret an actor as a verified human.
Closing the tab/session can start a new player identity. Clearing storage loses
that guest's personal-best association, while the shared board remains intact.

`cvm.request`, `callTool`, discovery, provider close and the configured registry
are available. `registry.describe(family)` returns tool schemas and per-tool
CEP-15 hashes. Registry families are Soy contracts, not new NAP browser methods.
Another provider needs user permission. No automatic provider failover migrates
state; switching infrastructure is an explicit creator/operator decision.
Payment-required results remain errors; there is no wallet authorization here.
The separate soy.backends.v1 family supports bounded persistent custom rules;
read docs/napplet-dynamic-backends.md and the soy-backends skill for availability
and authoring. The standard room/board service does not accept uploaded code.
Generic streams, sampling and server game
simulation are not provided by this service.

## Shared scoreboard

```js
const ref = { napplet: backend.napplet, board: 'highscore-v1' };
await call('soy_board_submit', { ...ref, score: finalScore, name: playerName });
const { rows, own, trust } = await call('soy_board_read', { ...ref, limit: 20 });
// rows: [{ actor, score, name, updated, revision, hasData }]; own: row or null
```

Render names as plain text. Submit at the end of a run; poll at most every two
seconds while visible. A repeat or worse score cannot inflate the best result.
Use `lowest` for race times. Scores are finite numbers within the registered range.
`trust` is `client-reported`: this is a casual board, not anti-cheat or suitable
for prizes. Creator authorization protects the board's rules, not score truth.

Board registration is signed by the naddr's author, bound to the provider and
requesting transport actor. soyLI handles this with the selected local or NIP-46
creator. Rules persist across releases; an incompatible change uses a new ID
(e.g. `highscore-v2`). Remixing creates a new naddr and must register separate
boards. Public provider data is not copied into a remix or local preview.

## Score attachments: cars, drawings, loadouts and other run data

The `soy.boards.v2` family adds structured public data to a personal best. No
custom backend, website REST API or new NAP capability is needed. Ordinary v1
boards remain supported. Check `cvm.registry.has('soy.boards.v2')` before offering
this feature; show an actionable unavailable message if the host/provider is older.
`soyli backend sync` also checks provider support before requesting registration
signatures. Update soyLI, run `soyli skills update`, and restart dev for local support;
the public backend and shell also need this version of the service and registry.

Add a new board to `backend.boards` in `napplet.json` (merge with your existing
configuration). This example stores race times in milliseconds and a small drawing:

```json
{
  "board": "hills-classic-v1",
  "title": "Hills · Classic",
  "order": "lowest",
  "minimum": 1,
  "maximum": 3600000,
  "dataSchema": {
    "type": "object",
    "additionalProperties": false,
    "required": ["version", "limbs"],
    "properties": {
      "version": { "type": "integer", "enum": [1] },
      "color": { "type": "string", "maxLength": 24 },
      "limbs": {
        "type": "array",
        "minItems": 1,
        "maxItems": 64,
        "items": {
          "type": "array",
          "minItems": 2,
          "maxItems": 2,
          "items": { "type": "number", "minimum": -100, "maximum": 100 }
        }
      }
    }
  }
}
```

Run `soyli dev` to test against the same isolated service. `soyli publish` registers
the board; `soyli backend sync` can do that explicitly beforehand. The schema is
creator-authorized and immutable, like ordering and score limits. Adding/changing
the schema on an existing board requires a **new board ID**; existing scores remain
on their original board. Separate tracks, modes and incompatible physics/rulesets.

Using the `call` helper above:

```js
const ref = { napplet: backend.napplet, board: 'hills-classic-v1' };
const callBoard = (tool, args) => call(tool, args, 'soy.boards.v2');
await callBoard('soy_board_submit', {
  ...ref,
  score: finishTimeMs,
  name: playerName,
  data: { version: 1, color: 'coral', limbs: [[0, 0], [12, 8], [24, 3]] },
});
const { rows, own, nextOffset } = await callBoard('soy_board_read', { ...ref, limit: 20 });
// A list row contains hasData + revision, never the full payload. Fetch on selection:
const selected = rows[0];
if (selected?.hasData) {
  const result = await callBoard('soy_board_entry', {
    ...ref, actor: selected.actor, revision: selected.revision,
  });
  if (result.stale) {
    // That player's best changed. Refresh the list before displaying run details.
  } else if (result.entry) {
    // entry includes score, name, actor, updated, revision and data from ONE run.
    drawLimbs(result.entry.data.limbs);
  }
}
// For another page, pass offset: nextOffset when it is non-null.
```

Data is required for boards with `dataSchema`; boards without a schema reject it.
No coercion or defaults are applied. Score, name and data update together only for
a **strictly better** result. Equal/worse submissions and retries preserve the
winning run and its revision. Reads survive service restarts and ordinary releases.
Only each actor's current personal best is retained, not a complete race history.
`soy_board_entry` without a revision returns the latest entry, or `entry: null` if
absent. With an outdated revision it returns `stale: true, entry: null`.

The schema is a bounded JSON Schema subset: root object; nested object/array,
string, number, safe integer, boolean and null types; `properties`, `required`,
boolean `additionalProperties` (defaults to true), `items`, primitive `enum`
(1–32 distinct choices), numeric minimum/maximum, min/max length and min/max items.
Optional `title`/`description` labels are limited to 512 characters. Unsupported
keywords, references, regex and composition are rejected. Declare
`additionalProperties: false` when only named fields should be accepted.

The schema and each attachment are limited to **8 KiB of serialized UTF-8 JSON**.
Schema depth is at most 8 with 128 schema nodes. Data depth is at most 8 with 2,048
values, at most 256 items per array and 64 fields per object. Field names are at
most 128 characters; prototype-related names, non-finite numbers and non-JSON
values are rejected. Strings count Unicode code points for schema length rules;
the separate byte budget still applies. Invalid data returns a field-specific
error without echoing its values. Leaderboard pages return up to `limit` rows
(1–100), also capped at 16 KiB of row JSON to fit the encrypted transport. Follow
`nextOffset`; pages are a live view and can move as scores change.

All score attachments are **publicly readable through the provider**, even though
transport messages are encrypted. Store no secrets or private saves here. Treat
received fields as untrusted data; render text safely. A session actor is still
not a durable Nostr profile, and submitted geometry does not prove a score is honest.

Keep large replay, image or video bytes on a configured Blossom server and declare
URL/hash fields in the data schema. Use the standard upload/resource capabilities
and verify retrieved bytes; the score service stores references and never uploads,
fetches or executes them. Snapshot run data at the right moment: a locked design
can be captured at race start; live editing needs initial geometry plus timed
changes to replay accurately. A final drawing alone is only a final snapshot.
Keep personal run history separately in NAP-STORAGE. Do not silently drop requested
shared data, hide it in display names, or claim that local-only history is shared.

## Matchmaking to WebRTC

Choose an application protocol label that describes compatible game messages.
The same naddr, protocol, queue and requested player count match together. Bump
the protocol when messages/rules become incompatible; no self-referential build
hash is required. Player count is an application choice within provider limits.

```js
const protocol = 'my-game-v1';
let ticket = await call('soy_match_join', {
  napplet: backend.napplet,
  protocol,
  queue: 'casual',
  players: desiredPlayers,
});
while (ticket.state === 'waiting') {
  await new Promise((resolve) => setTimeout(resolve, 2000));
  ticket = await call('soy_match_status', { ticket: ticket.ticket });
}
if (ticket.state !== 'matched') throw new Error('Match closed; join again');

let sessionId;
const stopEvents = webrtc.onEvent((event) => {
  if (event.sessionId !== sessionId) return;
  if (event.type === 'peer') updatePeer(event.pubkey, event.state);
  if (event.type === 'message') validateAndApply(event.from, event.payload);
  if (event.type === 'closed') showReconnect(event.reason);
});
const { session } = await webrtc.open({
  scope: { type: 'room', room: ticket.room, peers: ticket.peers },
  channel: 'game',
  protocol,
});
sessionId = session.id;
// Wait for a peer "joined" event before sending; open() only starts negotiation.
await webrtc.send(sessionId, { type: 'input', sequence, buttons });
// Later, on exit (also stop timers/listeners):
await webrtc.close(sessionId, 'Leaving game');
stopEvents.close();
await call('soy_match_leave', { ticket: ticket.ticket });
```

Use the functions above as lifecycle examples; supply your UI, cancellation and
message validation. Queue join is idempotent for one actor and matching options.
Waiting tickets expire after 60 seconds without status calls. Matched tickets
last ten minutes; they are rendezvous records, not the lifetime of gameplay.
Leaving a fixed match marks its remaining tickets closed. Game authority, host
selection, migration and game-over decisions belong in the game protocol.

Gameplay travels on WebRTC data channels, directly when ICE succeeds or through
TURN when needed. CVM is not a per-frame game server. The current channel profile
is reliable/ordered JSON broadcast to connected peers, up to 16 KiB per message.
Use one host relay pattern or mesh as your application needs, but `send` broadcasts:
put an intended recipient in the validated app message if needed. There is no
NAP selector for unordered delivery in the pinned proposal. Coalesce obsolete
updates on backpressure; do not send assets or a complete world every frame.

### Responsive synchronization

A connected data channel is only a transport. For a fast-action game, the creator
still needs to implement responsive synchronization. A guest that waits for the
host's snapshot before drawing its own movement pays for the whole round trip,
plus the input and snapshot scheduling intervals. Rendering at 60 FPS does not
smooth a world that jumps to a new position only when a packet arrives.

For a game with one simulation authority, start with a **star**: every guest
connects directly to the host. One room session can contain multiple peers; the
four-session limit is not a four-connection limit. With a known participant set:

```js
const peers = actor === authority ? members.filter((key) => key !== actor) : [authority];
const { session } = await webrtc.open({
  scope: { type: 'room', room, peers },
  channel: 'game',
  protocol,
});
```

Validate the authority and membership at the application layer. For changing
membership, follow the restrictions below; don't silently accept arbitrary peers
to avoid reconnection. Forwarding trees are a deliberate bandwidth/scale tradeoff:
each intermediary adds a network hop and possibly another send interval. A slow
intermediary affects every descendant. Mesh and lockstep can suit other games;
there is no universal required topology.

Keep these responsibilities separate:

1. **Predict the local player.** Apply movement and local aiming immediately using
   the same fixed-step rules as the host. Send sequenced input. The host returns
   authoritative state and the last input sequence actually applied for each player.
   Reconcile by discarding acknowledged inputs and replaying the remaining inputs
   over that state. Immediate shot animation need not grant an authoritative hit.
2. **Interpolate remote players.** Keep timestamped snapshots and render between
   two known states on a slightly delayed simulation timeline. Use host tick numbers
   and a local monotonic arrival anchor; wall clocks on different machines differ.
   Start with a buffer around two snapshot intervals, then measure. Handle teleports,
   spawn/death and stale data explicitly instead of interpolating every field.
3. **Send useful data.** Inputs go upstream; compact world snapshots go downstream.
   A leaf should not echo the world back. Names/settings belong in infrequent control
   messages. Use a fixed-step accumulator and a send deadline; don't reset a nominal
   20 Hz deadline to every delayed render frame. Cap catch-up work after suspension.
4. **Bound recovery.** Ignore stale sequence numbers, validate ranges and sender
   authority, cap pending input/snapshot queues, discard obsolete unsent updates
   under backpressure, and request a fresh state when the backlog is no longer safe.
   Reconnection, host departure and peer membership changes need explicit behavior.

`docs/examples/multiplayer-sync.ts` contains small application-side prediction and
snapshot-buffer examples. Copy/adapt them to the game's state and collision rules;
they are not new host APIs or an engine. `advance(input)` represents one fixed
simulation step. The host must process/ack that same sequence exactly once: merely
receiving the latest input is not acknowledgment that every tick was simulated.
Validate untrusted snapshots before passing them to either helper. Keep predicted
render state separate from authoritative scores/hits. For a held-input protocol,
adapt the history to tick ranges rather than pretending one packet equals one tick.

### Repeatable multiplayer scenarios

The CLI runs creator-owned JavaScript/TypeScript scenarios with its bundled browser:

```sh
soyli build
soyli multiplayer tests/multiplayer.mjs
soyli multiplayer tests/multiplayer.mjs --players 4 --latency 50 --jitter 15 --seed 1
# Optional: use an installed coturn executable for a disposable, forced relay test.
soyli multiplayer tests/multiplayer.mjs --turn-binary /path/to/turnserver --latency 50
```

`skills update` supplies `docs/examples/multiplayer-scenario.mjs`. Copy it into your
tests, adapt its Host/Join/readiness selectors, and observe your rendered player
state. An unadapted example fails rather than claiming the game works. The command
uses the current build without running a build, publishing, or changing application
source. Its scenario is **trusted local test code**, like an ordinary project test;
don't run a scenario from an untrusted checkout without reviewing it.

The default is two isolated guest browser contexts; `--players` accepts 2–8.
These temporary contexts allow peer connections for the test; they do not alter
the player's normal browser permissions.
Configured backend calls are mapped to a disposable local CVM/room/board instance.
The temporary copy is removed on completion. This does not reuse or modify the
dev backend's state. Declared dynamic manifests, handlers and schemas are copied
from the frozen inputs, as they are for check/screenshot/record. Chromium is cached on first use; Bun/Node and project Playwright
dependencies are not required for `.mjs` scenarios. Each run replaces
`.napplet-space/multiplayer/latest.json`, including failures. A failed assertion,
empty scenario, browser error or timeout returns a nonzero exit status.
Reports identify the CLI version and exact artifact hash. Final diagnostics have
a separate bounded deadline; an unavailable observation is reported as a warning
without discarding the scenario's assertions.

The scenario exports a default async function receiving:

- `connectIdentity(player)`: connects a fresh disposable Nostr viewer in that
  player's trusted host and returns `{pubkey}`. It does not touch CLI accounts,
  Keychain or your creator identity; the opaque iframe cannot use the signer.
  Call once per player. Use distinct players for distinct identities.
- `approveBackendAccount(player, moduleName)`: waits for and accepts only that
  module's account-consent prompt on the runner's local provider. Invoke after
  triggering the UI operation. Other permission dialogs are not auto-approved.

- `players`: `{page, frame}` for each independent browser; these are Playwright
  handles for the trusted preview and sandboxed napplet respectively.
- `check(name, boolean)`: record a required assertion and fail if false.
- `measure(name, milliseconds, maximum)`: record an observed timing and its budget.
- `network({latencyMs, jitterMs, seed})`: adjust simulated conditions on all players.
- `diagnostics()`: per-player arrays of connected/connecting peers with selected
  route, native RTT, queued bytes and cumulative message/byte counts.
- `signal`: cancellation/timeout signal. `--timeout` is 60 seconds by default,
  accepts 1–300, and includes local service/browser startup after any first-use
  Chromium download. Cleanup may take a few additional seconds.

`--latency` adds 0–1000 ms **per outgoing hop**, so 50 adds about 100 ms per round
trip. `--jitter` adds a seeded ±0–500 ms variation, clamped at zero. The simulator
preserves message order, bounds queued bytes and cancels queued sends when a channel
closes. It adds delay around real RTC traffic; it does not emulate packet loss,
bandwidth contention or SCTP retransmission. Native RTT excludes this added delay.
The report records simulation conditions separately. Do not interpret it as public
network qualification. Direct local ICE can fail on VPNs; use the optional isolated
coturn path to exercise the same shared host over a known relay route. This does not
test the deployed TURN configuration or credentials.

For fast controls, a useful starting budget is visible local feedback within 50 ms
under an added 50–100 ms each way. Set budgets appropriate to your game. Measure
host and guests; include remote movement continuity, correction after a disagreement,
simultaneous firing, joins/leaves and reconnection. Time actual rendered-state changes,
not just key handlers or receipt of an input. Keep the assertions in the project's
normal verification script. Our connection smoke checks and `soyli check` cannot
infer whether arbitrary game logic is responsive. `soyli check` explicitly reports
gameplay as untested when the artifact requires WebRTC.

The normal `soyli dev` preview's **Connection diagnostics** panel shows live direct
or relay selection, RTT, buffering and send/receive rates. These are host-side
observations, not napplet-facing protocol extensions. Reports/panels omit native
candidate addresses, SDP and TURN credentials. A low transport RTT with poor guest
controls points toward application scheduling/synchronization; also test actual
separate networks, packet loss and long sessions before making performance claims.

## Named rooms and changing membership

Instead of fixed-match tickets, use:

- `soy_room_create({napplet, protocol, name, capacity, listed})` → room snapshot.
- `soy_room_list({napplet, protocol})` → `{rooms}` (listed rooms only).
- `soy_room_join({room})` / `soy_room_status({room})` → snapshot with peer keys.
- `soy_room_leave({room})` → `{left:true}`.

Poll status every 2–20 seconds while active to renew your 60-second membership.
Others may remain after you leave; an empty/expired room disappears. Create is
not retry-idempotent: retain its returned ID; after an ambiguous failure, list
before creating again. An unlisted room ID is not a password. No durable world
state is stored here. With no explicit WebRTC `peers` allowlist, peers on the same
room/channel/protocol discover each other. That is an open rendezvous, not proof
of CVM membership. For restricted peer sets, pass the returned keys and explicitly
close/reopen the transport when that set changes; the pinned API has no update-set
operation. Validate every message and implement app-level authorization as needed.

## Limits, diagnostics and release checks

Default service limits: 8 total room/match players, 1,000 rooms/tickets, four room
memberships per actor, 1,000 boards, 1,000 players per board, 100 read rows and 120
tool calls per actor per minute. The host allows four CVM providers, four WebRTC
sessions, eight remote peers per session, 120 sends/second and 512 KiB/second.
Transport limits are deployment policy, not a promise that every game scales to
these maxima. Keep simulation topology and bandwidth choices explicit.

Handle capability denial, provider errors, `connecting`, `peer:left`, `closed`,
timeouts and backpressure visibly. A browser reload/sign-in change disposes the
old transport; rejoin explicitly. No automatic state replay or migration occurs.
TURN credentials are host-only and short-lived (ten minutes); reopening obtains
fresh credentials. Long-running relay sessions/credential renewal are not yet
qualified. Some restrictive networks still cannot connect; the managed service
has no TURN-over-TLS 443 fallback. Browser ICE can reveal network addresses after
the player's peer-connection consent.

Test with independent browser contexts. Test forced TURN and clients on separate
networks before claiming public connectivity; two tabs are insufficient evidence.
Test guest use, reconnect/leave, malformed peer messages, offline provider,
republishing without score reset, and remix isolation. Run both the upstream
conformance suite and `soyli check`; capability presence alone does not prove an
entire game works. The local upstream reference shell may expose a different
capability profile; the soyLI preview is the target host.
