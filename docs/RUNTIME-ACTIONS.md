# Files, uploads and viewer actions

Available in soyLI since **0.15.0** and the shared website runtime
`space-playback-4`. Upgrading the CLI does not upgrade a remote website.
The host installs the runtime before app code runs; apps must not perform the
host's bootstrap handshake. Use the starter's `runtimeHasDomain(domain)` helper
to gate optional domains and the upstream SDK to call them. Handle operations
with `try { await ... } catch { ... }` so both synchronous errors and rejected
promises reach a useful fallback. Namespace presence alone does not guarantee
that an operation is implemented or permitted.

These are the selected NAP-FS, NAP-UPLOAD, NAP-COMMON and NAP-LISTS contracts.
Use the upstream SDK or injected `window.napplet` namespace; no Soy-only iframe
messages, client API proxies or creator-specific manifest fields are required.
All publishers receive the same policy. The frame remains opaque with no raw
network access, filesystem paths, secret key or general-purpose signer.

## Import and export files

`fs.pickFile`, `pickFiles` and `pickDirectory` open a host-owned native chooser.
The user's selection grants a **session copy**, not access to the original file
or a live OS folder. Choosing a folder imports its browser-visible files and
relative directory structure; empty directories are not represented. Directory
selection depends on browser support. Cancellation fails without importing data.

```js
const { entries } = await napplet.fs.pickFile({
  accept: [{ extension: '.txt' }],
  description: 'Choose a text file to turn into a poster',
});
const part = await napplet.fs.read(entries[0].path, { offset: 0, length: 262144 });
// part.data is base64. Read further chunks until part.eof.
```

Use returned virtual paths: `/files/import-<id>/...`. Stat, list, chunked reads,
writes, directories, moves, removals and watches remain available. Changes affect
session copies only. `pickSaveFile` selects a virtual export destination; write
chunks and let the user download the resulting file through host controls.

Limits: **10 MiB total session files**, 128 entries including directories, 256 KiB
per read/write, 16 watches, at most 127 files in one selection. Imports are atomic:
an invalid name, duplicate path, quota failure or account change commits nothing.
Download wanted files before stopping, reloading or switching accounts. Session
files are not persistent project assets; the creator's Assets manager is separate.

## Upload bytes to Blossom

`upload.info()` advertises the Blossom rail and **10 MiB per file** limit. The
website uses the viewer's first Blossom server in **Network settings**; local
preview uses the first `servers` entry in the effective project configuration.
The preview's temporary managed-asset HTTP server is never an upload destination.
The chosen origin is shown before approval. A manifest's storage hints cannot
silently select the website viewer's upload destination.

```js
const listener = napplet.upload.onStatus((status) => {
  if (status.status === 'complete') showDownload(status.url);
  if (status.status === 'failed' || status.status === 'cancelled') showError(status.error);
});
const initial = await napplet.upload.upload({
  data: new Blob(['My generated text'], { type: 'text/plain' }),
  filename: 'creation.txt',
  caption: 'A creation made in this napplet',
  noTransform: true,
});
// Initial status is uploading, including time spent awaiting consent.
// You can also call upload.status(initial.uploadId). Close listener on teardown.
```

Uploads require a connected viewer and individual host approval. The host signs
hash-scoped, server-scoped kind-24242 Blossom authorization, sends bytes directly
with browser CORS, then downloads and verifies the stored bytes. The final result
contains HTTPS URL (explicit loopback HTTP during development), canonical Blossom
fallback, SHA-256, size, MIME and NIP-94 tags. It does not publish a file metadata
event or grant arbitrary relay publishing. The authorization event and secret key
are not returned to the napplet.

Blobs and ArrayBuffers work; base64 is not the upload wire format. This initial
rail never transforms bytes. Nonempty rail-specific metadata, other rails,
redirects, inconsistent descriptors and servers without suitable CORS fail.
There is no proxy, automatic destination change, GIF encoder or unlimited streaming
upload. Limit: two outstanding jobs, 32 jobs and 32 MiB submitted per account/frame
session. `onStatus` reports lifecycle changes; byte-level transfer progress is not
available. Account/frame teardown aborts pending work. Bytes already accepted by a
server may remain there after cancellation; closing the page is not a deletion.
These runtime limits are separate from the server's storage/publication limits.

## Follow, react and report

COMMON retains its profile/follows reads and public NIP-19 helpers, including
`nrelay`. It never encodes or decodes a secret identifier.

```js
await napplet.common.follow('npub1...');
await napplet.common.unfollow('npub1...');
await napplet.common.react(eventId, '🚀');
await napplet.common.report({ type: 'event', id: eventId }, 'spam', 'Why I reported it');
```

Follow changes preserve existing kind-3 tags/content and avoid no-op publications.
Reactions resolve a signed native Nostr event and publish kind 7 with its event,
author, kind and address when applicable. Use `+`, `-`, one emoji, or a single
`:shortcode:` with a custom emoji URL. Reports publish kind 1984 with NIP-56 reasons;
an event's author is resolved and conflicting caller-supplied authors are rejected.

The host approval shows the requesting napplet, action, stable targets, report text,
viewer key and relay destinations. A guest gets `not-signed-in`. The website uses
its selected Applesauce account (extension, NIP-46 or local session); local preview
uses **Connect browser extension**. The CLI's publishing identity is never silently
used for actions initiated by a running napplet. A remote signer may require renewed
permission for these event kinds. Proposal previews stay guest-scoped.

## Manage public list items

Call `napplet.lists.supported()` to discover supported kinds and item types. The
initial host advertises `privateItems: false` for all of them:

| Kind | Type | Items |
| --- | --- | --- |
| 3 | follow-list | pubkey |
| 10000 | mute-list | pubkey, event, hashtag, word |
| 10001 | pinned-notes | event |
| 10002 | relay-list-metadata | relay, with read/write/read-write markers |
| 10003 | bookmarks | event, article address |
| 10006 | blocked-relays | relay |
| 10007 | search-relays | relay |
| 10015 | interests | hashtag, interest-set address |
| 10063 | blossom-servers | server |
| 30000 | follow-sets | pubkey |
| 30002 | relay-sets | relay |
| 30003 | bookmark-sets | event, article address |
| 30015 | interest-sets | hashtag |

```js
await napplet.lists.add(
  { kind: 30000, identifier: 'favorite-creators' },
  [{ itemType: 'pubkey', value: authorHex, visibility: 'public' }],
  { create: true, title: 'Favorite creators' },
);
await napplet.lists.remove(
  { kind: 10003 },
  [{ itemType: 'event', value: eventId, visibility: 'public' }],
);
```

Identify a list by **kind or type**, not both. Addressable sets require an
identifier. Missing lists need explicit `create: true` for additions; title,
description and image apply only when creating. At most 64 items are changed at
once. Unsupported kinds/items and explicit private items return errors.

Public edits preserve unknown tags and encrypted content verbatim. NAP-LISTS
removal with omitted visibility means public **and** private: if opaque content
exists, that request fails instead of silently performing only half the removal.
Use explicit `visibility: 'public'` for public-only changes. Removing one NIP-65
read/write role from an unmarked relay preserves the opposite role.

List reads require EOSE from every selected action relay (up to eight); incomplete
reads cannot become empty replacement lists. The host rechecks before signing
and before publishing, serializes concurrent edits locally/across same-origin tabs
where Web Locks are available, and refuses detected conflicts. On the website,
action relays come from the viewer's Network settings, not manifest hints. Local
preview uses its configured relays. The selected relay view is not a globally
complete Nostr snapshot: configure the relays holding your lists. Nostr has no
cross-relay compare-and-swap; a different client can still race the final write.
List metadata cannot claim a global transaction guarantee.

Failed publications retain a bounded signed event for an identical retry within
the same account/frame. A changed base invalidates a pending list event. Host
approval is required again. Identity changes and request deadlines prevent late
signer answers from initiating writes. Arbitrary signing, encryption and private
list mutation remain ungranted. The 2026-09-23 source adds a constrained
`relay.publish`/`outbox.publish` subset for public kind-30078 application records;
other event kinds and unrestricted writes remain denied. See
[shared application data](SHARED-DATA.md) for the viewer consent, schema, namespace,
relay policy, retry and unpublish contract. This requires the matching host update.

## Verification

`bun test packages/runtime packages/nostr packages/client` covers imports, list
preservation, incomplete relay reads, conflicts, consent, signer integrity,
identity cancellation, upload hash verification and public identifier helpers.
`bun test tests/services/runtime-actions.test.ts` exercises the pinned upstream
shim in both a real soyLI preview and a production website build, with isolated
relay/Blossom fixtures and an injected NIP-07 signer. It includes mobile approval
controls and uses no public account or external publication.

This is bounded implementation evidence, not full independent-client conformance,
all-device folder picker coverage or a guarantee of third-party storage/relay policy.
