# Reading and publishing Nostr events

The shared website and soyLI preview host implements the
[NAP-OUTBOX contract](https://github.com/napplet/naps/blob/8865f73d52a4864afee145f28d26520476273927/naps/NAP-OUTBOX.md)
using Applesauce stores, loaders and relay transports. This guide describes host
behavior and policy; the linked proposal defines the protocol. Included in the
0.29.0 source; see [release and deployment status](CLI-RELEASES.md).

Declare the ordinary `outbox` domain using your project's manifest tooling. Domain
availability is distinct from permission to publish. The host injects the shim;
do not add a signer, networking workaround or custom handshake to the napplet.

## Read

```js
const notes = await window.napplet.outbox.query(
  { authors: [authorPubkey], kinds: [1], limit: 20 },
  { timeoutMs: 3000 },
);
for (const { event } of notes.events) renderNote(event);
if (notes.incomplete) showRetry();

const found = await window.napplet.outbox.getEvent(eventId, {
  author: authorPubkey,
  timeoutMs: 3000,
});
if (found.result) renderNote(found.result.event);
```

Reads resolve authors' NIP-65 **write** relays. Public relay hints remain policy
candidates. Configured relays provide fallback for unresolved authors, including
mixed queries where other authors resolve successfully. Returned events have
verified signatures and matching IDs/filters. Query results deduplicate event IDs.
An empty completed lookup is distinct from a timed-out or partial lookup.

Each account host owns one bounded raw event store shared by OUTBOX reads, lazy
loaders, live updates and locally signed generic publications. A cached record
never proves network completeness. `getEvent` uses an Applesauce network loader
against the resolved destinations and tracks EOSE coverage separately; SDK fallback
behavior cannot turn exhausted relay failures into successful empty reads.

```js
const subscription = window.napplet.outbox.subscribe(
  { authors: [authorPubkey], kinds: [1], limit: 20 },
  { timeoutMs: 3000 },
);
subscription.on('event', ({ event }) => renderNote(event));
subscription.on('closed', (reason) => showStreamClosed(reason));
// When this view stops observing:
subscription.close();
```

EOSE remains internal to OUTBOX. Streams continue after stored-event backfill and
refresh relay-list routing every 60 seconds. Newly observed verified relay-list
records can also trigger rerouting. Route changes retain the subscription ID and
deduplication window. Explicit close, exhausted transport, account change or player
teardown closes the stream with a bounded useful reason. There is no five-minute
stream expiry. `timeoutMs` bounds initial work, not the entire live session.

`resolveRelays({ pubkey, direction: 'read' })` is advisory diagnostics; prefer the
event APIs to manually replaying a plan. Observed relay sidecars are default-off;
a trusted host can opt into disclosed `sidecar.relayHints`. Resource prefetch
sidecars remain disabled. Hints record observations, never proof of permanent
storage or a grant to contact a private network.

## Publish

```js
const result = await window.napplet.outbox.publish(
  {
    kind: 1,
    created_at: Math.floor(Date.now() / 1000),
    tags: [],
    content: draftText,
  },
  { toInboxes: [recipientPubkey] },
);
if (!result.ok) showPublishFailure(result.error, result.eventId, result.relays);
```

The viewer reviews each event before the host signs it. Consent shows the napplet,
signing account, kind, content, tags and destinations. There are no remembered
publication grants. A signed-out, read-only or insufficiently scoped signer cannot
publish. Website account session kind restrictions and extension/remote-signer
approval still apply; approval in the host does not override signer policy.

By default, destinations include the viewer's NIP-65 **write** relays. Each
`toInboxes` recipient adds its advertised **read** relays. Explicit `relays` add
policy-validated destinations. The host deduplicates this union and signs exactly
one immutable event, reused for every relay. It does not infer recipient fanout
from `p` tags. Missing recipient metadata is a failure; fallback relays cannot
replace required recipient inboxes.

For explicit-only publication:

```js
const result = await window.napplet.outbox.publish(template, {
  toOutbox: false,
  relays: ['wss://your-relay.example'],
});
```

`ok: true` means every selected relay acknowledged. Partial rejection returns
`ok: false`, the signed `event`/`eventId`, per-relay booleans and a safe useful cause.
Some relays may already store the event. The transport retries an unavailable
acknowledgement at most once with identical signed bytes; explicit rejection is
not retried. One acknowledgement does not prove durable storage or recipient receipt.

The host deduplicates repeated request IDs within the account/frame session,
including specialized writes. A repeated ID returns the same outcome; changing
its payload fails. Fresh SDK calls have fresh IDs and are new signing requests.
There is no durable idempotency guarantee across reloads or fresh calls. Keep drafts
and inspect the returned signed ID before requesting another publication.

Kind-30078 app-data records and kind-35858 map metadata always use their existing
specialized validators, namespace/ownership checks and complete revision reads.
Map deletion requires the existing exact owner-map kind-5 flow; generic kind-5
publishing is denied. Specialized destinations must all be explicitly configured
in host Network settings, including any targets added by default outbox or inbox
options. An incompatible target produces a policy failure before signing; routing
options never bypass schema, stale-base or ownership protections. See
[shared data](SHARED-DATA.md) and [native maps](MAP-INTENTS.md).

## Host bounds

- Reads: four filters, up to 64 author values per request input, discovery for at
  most 16 distinct authors, eight relay destinations, 200 returned events and
  eight open subscriptions. Omitted route coverage is incomplete.
- Read timeout: 100–10,000 ms, with discovery and response-delivery margins inside
  the caller's deadline. Initial stream backfill is bounded separately from live
  delivery. Deduplication retains the most recent 2,048 stream IDs; sufficiently
  old duplicates can reappear after eviction.
- Raw cache: 1,024 events, 16 MiB, 60-second lazy expiry. Relay-list cache: 128
  authors, 60-second freshness. Both are account-scoped and cleared on teardown.
- Writes: one to eight complete destinations. Larger required fanout fails before
  signing. At most 256 publication request IDs and 16 MiB replay accounting per
  account/frame scope. Requests settle within 28 seconds, inside the shim's
  30-second deadline; late signer responses cannot publish.
- Signed event size: 64 KiB, with existing NIP-01 field/tag bounds. No encrypted
  event construction or signing-key API is added. Arbitrary NAP-RELAY template
  signing remains denied.
- Public destination policy remains mandatory. Trusted local preview/Network
  settings can admit literal-loopback WS relays; iframe hints cannot grant LAN,
  private DNS, credentials-in-URL or arbitrary loopback access.

These are local resource and permission policies, not new NAP fields or Nostr quotas.
Every publisher receives the same policy. Optional source or Space metadata never
becomes a playback or publication prerequisite.
