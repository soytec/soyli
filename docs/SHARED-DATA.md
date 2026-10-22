# Shared application data

2026-10-13 OUTBOX integration: general templates now have a separate consented
publication handler; this feature's schema, ownership, revision and configured-relay
protections remain mandatory. OUTBOX own-outbox, recipient-inbox and explicit routing
options are honored only when the complete resolved target set is configured in
host Network settings; otherwise publication fails before signing. Required relay
rejection retains the signed event, per-relay outcomes and feature-specific safe
failure cause. See [current OUTBOX behavior](OUTBOX.md). Included in the
0.29.0 source; see [release and deployment status](CLI-RELEASES.md).

Use this guide when players should publish tracks, puzzles, drawings, presets or
other structured creations independently of a score. Use the bundled
`docs/examples/app-data.ts` and `app-data-contract.ts` together. They use the
injected NAP APIs; no additional backend, REST endpoint, signing key or direct
network access is needed in the napplet.

## Choose the right storage

- Device-local drafts/saves: NAP-STORAGE. Save edits before attempting publication.
- Public application-specific creations: the NIP-78 convention below.
- Large geometry, images, audio, replays: NAP-UPLOAD to Blossom, with URL, SHA-256,
  MIME and size in the record. Load through NAP-RESOURCE and verify the hash.
- Data belonging to a winning score: `soy.boards.v2` score attachments; keep it
  atomically attached to that result. Matchmaking/coordinated state uses CVM.
- Existing standard entities such as reactions, follows and bookmarks: use their
  existing NAP/NIP operations, not an app-data substitute.

Do not invent a CVM collection tool, hide requested data in player names, ship
private keys, borrow the creator's CLI identity, or silently replace requested
sharing with local-only saves. If the host is unsupported, keep the draft and
explain the missing capability. For private cross-device data, this public
convention is unsuitable; encryption/owner-only storage is not implemented here.

## Protocol and public relay policy

This is the **`soy.app-data/1` public application convention**, using NIP-78 kind
30078. It is not a new NAP, a general-purpose Nostr interchange standard, or a
claim that all NIP-78 relays offer public libraries.

Reviewed NIP-78 revision:
[`6aeea6093786644e892dd2869fa5b642fddd271d`](https://github.com/nostr-protocol/nips/blob/6aeea6093786644e892dd2869fa5b642fddd271d/78.md).
That revision recommends authenticated owner-only access and directs public
interchange toward dedicated kinds. This public-sharing convention
uses a different relay access policy: our relay accepts and serves
these signed events publicly, subject to ordinary quotas and moderation. Other
relays may reject them or hide them from other users. Test the selected relay with
two different identities and an anonymous reader; an upload acknowledgement alone
does not establish public readability. Do not store secrets in these events.

The host accepts the existing `outbox.publish` and `relay.publish` template
messages for this constrained convention only. The injected shim remains 0.30.0;
there is no generic signing grant, encrypted publishing grant or new domain.
NAP-SHELL's init capabilities include an optional **host-policy hint**:
`appData: { profile, scope, maxContentBytes, relays, defaultRelays }`. This hint is our extension,
not an upstream NAP capability requirement. Check it before offering publication;
the presence of `outbox` alone does not promise write permission. Every publisher
is treated equally, regardless of soyLI provenance. Old hosts keep read support
but need the matching update to allow these writes. Proposal players stay guests.

The scope is SHA-256 of UTF-8 JSON `["soy.app-data/1", stableHostIdentity]`.
The shared host removes the final artifact-hash suffix from its verified playback
identity; it never accepts a scope asserted by iframe code. Thus a release update
keeps its collection, a different napplet/author gets another scope, and preview
uses the project's stable `local-preview:<previewId>` identity. Preview records
are intentionally separate from public-release records. Keep schema labels stable
when publishing; do not put release hashes or changing display names in them.

Each event has these tags, with no additional tags in the initial write profile:

```json
[
  ["d", "soy.app-data/1:<scope>:<collection>:<record-id>"],
  ["s", "<scope>"],
  ["c", "<collection>"],
  ["L", "soy.app-data/1"],
  ["l", "example.track", "soy.app-data/1"],
  ["v", "1"]
]
```

The event's `content` is a JSON object with exactly these fields:

```json
{
  "schema": "example.track",
  "version": 1,
  "title": "A small circuit",
  "previous": null,
  "deleted": false,
  "data": { "points": [[0, 0], [100, 50], [0, 100]] }
}
```

Choose a descriptive, stable schema label (prefer a reverse-domain prefix you
control) and document its semantics in the project. Label reuse is open, not an
ownership or approval claim. Consuming apps must validate the actual data. The
host validates the envelope and bounded JSON, not whether a track is raceable.

A record's identity is **kind + publishing player pubkey + d tag**. Two players
may use the same record ID without collisions. Copies/remixes use a new ID under
their own identity; preserving another author is attribution, not write authority.
The signed event ID is a revision. Updates name the expected revision in
`previous`; creations use null. The host checks selected relays before consent
and again before publication, rejects stale bases and serializes same-origin
edits. This is not an atomic multi-relay compare-and-swap. Independent devices can
still race; Nostr's newest timestamp/lowest-ID tie-break selects the current event.

## Minimal creator example

Import the helper from `../docs/examples/app-data.js` in a typical `src/` file.
Declare `shell`, `identity` and `outbox` requirements using the project's existing
build metadata. The helper reads the live host policy rather than hardcoding our
server, a creator identity or a namespace.

```ts
import { appDataCollection } from '../docs/examples/app-data.js';

type Track = { points: [number, number][] };
function validateTrack(value: unknown): Track {
  if (!value || typeof value !== 'object' || !('points' in value) ||
      !Array.isArray(value.points) || value.points.length < 3 ||
      value.points.length > 512 || !value.points.every(p =>
        Array.isArray(p) && p.length === 2 && p.every(n =>
          typeof n === 'number' && Number.isFinite(n) && Math.abs(n) <= 10000))) {
    throw new Error('A track needs 3–512 finite coordinate pairs.');
  }
  return { points: value.points as [number, number][] };
}

const tracks = await appDataCollection({
  collection: 'tracks', schema: 'example.track', version: 1,
  validate: validateTrack,
});
const page = await tracks.list();
// Render page.records; expose incomplete and invalid instead of claiming nothing exists.

const change = await tracks.prepare({
  id: crypto.randomUUID(), title: 'A small circuit',
  data: { points: [[0, 0], [100, 50], [0, 100]] }, base: null,
});
// On the user's Publish action; the trusted host asks for consent.
const saved = await change.publish();
// On Retry, call change.publish() again: keep this object and the local draft.

const lookup = await tracks.get(saved.author, saved.id);
if (lookup.incomplete) throw new Error('Some relays did not finish. Retry before editing.');
if (!lookup.record) throw new Error('Track unavailable; keep your local draft.');
const edit = await tracks.prepare({
  id: saved.id, title: 'A smoother circuit',
  data: { points: [[0, 0], [120, 60], [0, 100]] }, base: lookup.record,
});
const updated = await edit.publish();

// Explicit Unpublish action; host confirmation explains its limits.
const removal = await tracks.prepare({
  id: updated.id, title: updated.title, base: updated, deleted: true,
});
await removal.publish();
```

The helper requires a connected viewer only when preparing/publishing changes.
Visitors can browse anonymously. Signing in with the same Nostr identity on
another device restores ownership. Switching accounts invalidates a prepared
change. Local preview uses the selected browser extension, never the CLI account.

To share a record, retain its author, scope, collection, ID, schema/version and
relay hints, or encode its ordinary kind-30078 address with NAP-COMMON/NIP-19.
`get(author, id, scope)` and `list({ scope })` can inspect a compatible collection
from another napplet; writes remain confined to the current napplet's scope.
To remix a foreign record, validate its data and prepare a new ID with `base: null`.
There is no automatic compatibility claim merely because two records share a label.

## Limits and honest UI states

- **16 KiB UTF-8 JSON content**, 12 nested levels, 4096 values, 1024 items/array,
  128 fields/object. These are public host limits, not NIP-78 protocol limits.
- Host approval per publication. Retried writes reuse the same signed event while
  its bounded session cache exists. Relay acknowledgements mean at least one
  selected relay accepted it, not permanent storage or availability everywhere.
- Publishing uses configured host write relays (Network settings); iframe hints
  cannot silently add a destination. A partial current-record lookup blocks writes.
  The helper defaults to the **first configured relay**, avoiding unrelated discovery
  relays with private-only NIP-78 policies or outages. With the website defaults this
  is relay.napplet.soy; users can put their own compatible relay first. An explicit
  helper `relays` option can select more configured destinations. App-data reads
  with explicit relay hints use those storage relays, without unrelated NIP-65
  discovery fanout. For all other event reads the usual outbox routing remains.
  Errors distinguish denied consent, missing identity, stale edits, invalid data,
  unavailable relays and failed publication. Surface them at the action with Retry.
- Lists are recent, bounded relay views (default 40, at most 100 records/page).
  The helper chooses current revisions before validating payloads; invalid or
  unsupported records are counted, not replaced with older compatible revisions.
  `incomplete` is distinct from an empty complete response. This is not a global
  index or arbitrary JSON query engine. Sort/filter data only within the loaded view.
- `nextUntil` is an inclusive time cursor. Deduplicate revisions across pages;
  if the cursor stops advancing because too many records share a timestamp, narrow
  the query or use an indexer. Do not claim exhaustive pagination in that case.
- Unpublish writes a **public tombstone**, with `deleted: true` and `data: null`.
  It hides the current record in compatible clients; it does not send a NIP-09
  deletion, erase old copies or remove linked Blossom files. Restore by explicitly
  editing the current tombstone. A missing record after an incomplete read is not
  permission to create a replacement.
- Addressable relays may discard older revisions. `previous` is a conflict hint,
  **not retained history**. For a racetrack tied to race times, pin the complete
  track payload to a Blossom hash or retain its data with the score; include the
  ruleset/game-mode version. Referencing only a replaceable record ID is insufficient
  for historical replay. Automatic immutable archives and dynamic track-specific
  scoreboard registration are not implemented by this slice.

## Agent acceptance checklist

Test in `soyli dev`, not an unsandboxed source server. Use two independent browser
identities: publish as A, browse/play as B, edit as A after reopening, reject a stale
edit, and copy as B to a new record. Verify anonymous discovery, denied consent,
identity changes, malformed/oversized content, failed relays and tombstone hiding.
Test both local preview and the deployed host version. Keep existing local drafts
when sharing fails. Do not declare success merely because an event was signed or
because a fixture relay accepted it. Independent-agent usability and public-provider
verification are separate from repository integration tests.
