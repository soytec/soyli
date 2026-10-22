# Manifest metadata for soyLI creators

Fresh `soyli publish` and playable proposal previews use the standalone NIP-5D
manifest from [dskvr/nips PR #7 at 4d0fb2e](https://github.com/dskvr/nips/blob/4d0fb2e9fa1fdca71be09b17a4c5f382fbca5d51/5D.md).
PR #7 merged at this revision on 2026-10-04; its unchanged head was verified on
2026-10-05. The installed SDK, shim and Vite plugin keep their separately recorded pins.

Edit `napplet.json`, use `soyli project show` / `soyli project set metadata.json`,
or open **Capabilities and discovery** in `soyli dev`. These edits are ordinary
reviewable source changes. The CLI writes the signed manifest; application code
does not build, sign or publish its own deployment event.

```json
{
  "description": "Draw a racetrack and race your friends' creations.",
  "requires": ["storage"],
  "optionalDomains": ["theme", "identity"],
  "archetypes": ["track", "editor"],
  "intents": [{ "intent": "napplet:track/edit", "parameters": ["track", "mode"] }],
  "icon": { "file": "assets/track-icon.png", "mime": "image/png" }
}
```

This is an excerpt to merge into `napplet.json`, not a replacement file or a
complete `project set` input. For `soyli project set metadata.json`, the file must
be a **flat object containing all five required fields** (`name`, `title`,
`description`, `license`, `topics`), plus any optional fields to change. Start
from the `project` object returned by `soyli project show`; do not include the
outer `revision`, `project`, `assets` or `targets` envelope. The CLI obtains the
edit revision itself.

For example, this complete `metadata.json` works with `soyli project set metadata.json`:

```json
{
  "name": "track-editor",
  "title": "Track editor",
  "description": "Draw a racetrack and race your friends' creations.",
  "license": "MIT",
  "topics": ["racing", "editor"],
  "requires": ["storage"],
  "optionalDomains": ["theme", "identity"],
  "archetypes": ["track", "editor"],
  "intents": [{ "intent": "napplet:track/edit", "parameters": ["track", "mode"] }]
}
```

Use the project's actual name, license and other metadata. Omitting optional
fields preserves them; use empty lists or `"icon": null` to clear them.

## What gets published

| Authoring input                                          | Signed NIP-5D output                                                      |
| -------------------------------------------------------- | ------------------------------------------------------------------------- |
| Built self-contained HTML                                | One `x` tag containing the HTML's SHA-256                                 |
| Description                                              | Nonempty plain-text event `content`                                       |
| Display title                                            | Optional `title` tag                                                      |
| `requires`, plus mandatory domains declared by the build | Repeated `R` tags                                                         |
| `optionalDomains`                                        | Repeated `O` tags; required domains take precedence                       |
| `archetypes`                                             | Repeated `z` tags                                                         |
| `intents`                                                | Repeated `i` tags, with the intent followed by at most 14 parameter names |
| Local `icon.file`, optional matching `icon.mime`         | One `icon` tag with hash and MIME                                         |
| Blossom destinations                                     | `server` origins for artifact and icon lookup                             |

Give the description a useful sentence about the experience. It is rendered as
plain text, including any Markdown or HTML characters. An old project with no
description publishes its title/name as a nonempty compatibility fallback.

For Vite projects, `requires` in `vite.config.ts` remains the plugin's authoring
option: soyLI reads the built `napplet-requires` metadata and serializes `R`.
Rust and single-file projects can use `napplet.json.requires`. Declare only
domains essential to the core experience. Missing optional domains must degrade
gracefully. Declarations never grant access: inspect `window.napplet.<domain>`
and handle the host's actual operation results.

Archetypes are descriptive labels, not privileges or categories enforced by the
host. An intent is a queryless convention identity, such as `napplet:track/edit`;
the `parameters` list advertises names, not embedded payload values. Advertise
only behavior the app implements using the matching NAP. A discovery declaration
alone does not implement a handler or permit a new message domain.

An icon is optional, independent of the screenshot or playable bytes. Use a PNG,
JPEG or WebP no larger than 5 MiB. soyLI retains the local file in the source
archive and uploads its exact hash-addressed bytes to the selected Blossom server.
The MIME is detected when omitted and must match when supplied. Viewers verify
the hash and decoded image before display; an unavailable or invalid icon falls
back without blocking playback. SVG icons are not supported.

Fresh soyLI publications put screenshots and preview clips directly on the signed
current manifest and, when `publish --snapshot` is requested, its snapshot. They
use the optional downstream `soy.presentation/1` convention and no longer create
Zapstore kind-32267 descriptors. The selected PR revision does not
define these fields; they are explicitly a Soy extension pending upstream agreement,
never a playback requirement. Existing descriptors remain readable. See the
[exact media tags and limits](https://github.com/zeSchlausKwab/napplet-soy/blob/main/docs/PREVIEWS.md#direct-manifest-presentation--2026-10-06-source).
Capture representative gameplay or interaction, including useful mobile presentation
assets where supported.

## Existing releases and tools

The shell and indexer also read earlier NIP-5D events with `path`, aggregate `x`,
`description` and `requires`. Their signatures and historical links remain valid;
do not rewrite them or replace source history to upgrade. An already frozen old
publication resumes with its original manifest shape and signatures. The next
fresh publication uses the standalone shape.

The pinned Vite plugin is still a build tool named `nip5aManifest`. Keep the
single-file build and SDK boundaries. Its optional legacy local manifest is not
the event soyLI publishes; do not set `VITE_DEV_PRIVKEY_HEX` or hand-edit that
generated event to migrate. Use `soyli publish --dry-run`, `soyli check`, then
`soyli publish` for the reviewed build and source.

Ordinary `soyli publish` updates kind 35129 with the project's stable `d`
identifier. Keep that identifier across edits so the listing and social thread
continue. `soyli publish --snapshot` additionally creates an independent kind-5129
publication without `d`; use it when you explicitly want that immutable copy.
The returned `/r/<current-event-id>` link already pins the signed named revision.
Old frozen jobs resume their exact snapshot choice and signatures. Snapshot `a`/`A` describes immediate/root ancestry only, which
can belong to another author. It never borrows that author's storage, identity,
backend or permissions. Keep source provenance separate from runtime authority.

`soyli skills update` refreshes these managed guides and adapted skills while
preserving edited files as conflicts. It does not rewrite an existing app, build
configuration or Git history. A matching deployed shell/indexer is needed before
new-format publications can be read by a previously deployed old host.

## Upgrade an existing publication without rebuilding it

Existing projects upgrade on a fresh `soyli publish`; frozen legacy jobs still
resume their exact signed format. An original author without the local project
can instead use `soyli migrate <napplet-link-or-naddr> --dry-run --json`, review the
converted description, tags, address, HTML hash and destinations, then run the
same command with `--confirm <confirmation>`. Interactive execution also presents
the plan and requires typing `MIGRATE`. `--resume` reuses a saved signature after
an interrupted delivery; noninteractive retries still require the confirmation.

The command verifies the exact existing HTML from declared Blossom servers and
publishes only a new named/root manifest. It does not upload, rebuild, delete,
rewrite Git, switch accounts or require Soy source/media tags. Existing optional
source/media references retain their values. Legacy path/aggregate/description/
requires become raw `x`, plain-text content and `R`; obsolete named/root ancestry
is removed from this new event, while the old signed events remain unchanged.
An empty legacy description falls back to its title, identifier or “A napplet.”
Unchanged bytes preserve this host's saved-data scope; the address preserves the
social thread. Exact source inspection continues to use the original commit.

Use `--relay <url>` to choose the primary relay retaining the current manifest;
public defaults use the managed relay and additional default mirrors. `--mirror`
selects additional copies (at most seven). The primary read must finish before
confirmation/signing, and its current/deletion state is checked again before
writing. An unavailable mirror is reported and can be retried. This does not
claim an atomic transaction across every Nostr relay. Plans/receipts are stored
privately beside account state, outside project Git; no private key enters them.
From soyLI 0.24.1, a preview also works before any account setup: the private plan
directory is created without generating a key or selecting an identity. Signing
still requires the original author's explicitly selected account and confirmation.

This command supports named (`35129`) and root (`15129`) publications. Use the
current `/n/` link; a superseded `/r/` revision cannot replace a newer release.
Immutable snapshots are deliberately not converted: their new independent
identity would not preserve the old thread/storage. Old links remain playable
through the legacy reader without any migration.
