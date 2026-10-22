# Persistent backend rules with soyLI

## Authoring and preview

```sh
soyli backend init-module
```

This creates `backend/backend.json`, `backend/handler.ts` and `backend/schemas.json`
without overwriting existing files. The sample is a private counter, not a required
game starter. Add its manifest to your ordinary `napplet.json`:

```json
{
  "backend": {
    "boards": [],
    "modules": ["backend/backend.json"]
  }
}
```

Merge this fragment with your existing config. Preserve any configured provider or
boards. Then:

```sh
soyli backend check
soyli dev
```

`check` validates the manifest, state/operation schemas and compiles the handler in
a child process. It does not prove your application rules correct. `dev` builds
configured modules into its loopback CVM and persists worlds in
`.napplet-space/backend/boards.sqlite.dynamic.sqlite`. The existing preview host
maps calls to the configured public provider onto this local provider. Discover
the active release with `soy_backend_describe`; do not bake a local release hash
into your app. Context in `.napplet-space/soy-backend.json` includes module names.

**Restart `soyli dev` after backend source/schema edits.** Frontend watching still
works normally. A changed backend gets a new release: newly created instances use
it, and existing instances retain their old code. There is no automatic migration.
Local receipts explicitly say `local-preview` and hash the working files; they do
not claim that uncommitted code came from a public Git commit. Preview data stays
local and is not promoted when you publish the frontend.

The optional three-file example in `docs/examples/minicraft/` demonstrates shared
creative/survival worlds, bounded chunks, membership, edits and inventory. Copy
those files into `backend/` if useful, preserving existing work. They are ordinary
creator code; your app can define different operations and rules.

## The first execution profile

`soy-ts-quickjs-v1` accepts one self-contained TypeScript file exporting
`handle(context, input)`. It uses the installed Bun transpiler and QuickJS 0.31.0
compiled to WebAssembly. The per-release artifact is **JavaScript inside that
pinned WASM engine**, not a standalone WASM binary. Imports, npm installation,
project build scripts, Node APIs, filesystem access, network access, timers and
background work are unavailable. Rust/Extism plugins are not supported by this
backend profile; frontend Rust/WASM support is a separate feature.

```ts
export async function handle(ctx: any, input: any) {
  const current = await ctx.state.get('counters', 'shared');
  if (current.value !== input.expectedValue)
    throw new Error('CONFLICT: Refresh the counter before a new increment.');
  const next = { value: current.value + 1 };
  await ctx.state.set('counters', 'shared', next);
  return next;
}
```

The context supplies `operation`, `actor` (transport key), `account` (verified
Nostr key or null), `principal` (`nostr:<key>` or `guest:<transport>`), `owner`,
`instance`, `release`, `requestId` and server `now` in seconds. Never accept a
player identity or role from `input` as authority.

State capabilities are `get(collection,key)`, `set(collection,key,value)`,
`remove(collection,key)`, `access()`, `setAccess(policy)` and
`setMember("nostr:<key>", "builder" | "viewer" | null)`. Collections must be
declared. All access is confined to this instance. Only its verified owner can
change access/membership; query handlers cannot write. There is no raw SQL,
cross-instance transaction or general filesystem/database API.

The provider buffers writes, validates stored values and the returned object,
then commits state, retry receipt and revision together. An error, invalid output,
quota failure or deadline saves none of that operation's writes. Concurrent
operations, including queries, use an **instance-wide revision check**; even edits to different chunks
can conflict. Refresh before submitting a new intent. This initial profile does
not claim high-rate world simulation performance. A query that returns CONFLICT
can be refreshed with a new request ID and a short backoff; avoid overlapping your
own polling with a pending command. Never reuse a cached query intent for a refresh.

## Schemas

`schemas.json` has `version: 1`, a `records` map and an `operations` map. Each
operation declares:

```json
{
  "effect": "command",
  "access": "writer",
  "account": true,
  "input": {
    "type": "object",
    "properties": { "expectedValue": { "type": "integer", "minimum": 0, "maximum": 999999 } },
    "required": ["expectedValue"],
    "additionalProperties": false
  },
  "output": {
    "type": "object",
    "properties": { "value": { "type": "integer", "minimum": 0, "maximum": 1000000 } },
    "required": ["value"],
    "additionalProperties": false
  }
}
```

Effects are `create`, `query`, `command`; access is `reader`, `writer`, `owner`.
Creation always requires a verified account and assigns it instance ownership.
Objects require explicit properties/required fields and `additionalProperties:false`.
Arrays need `items`/`maxItems`; strings need `maxLength`. Primitive enums and numeric
bounds are supported. References, regexes, unions and custom validators are not.
Schemas describe shape; handlers enforce rules such as inventory and block placement.

Access policy is `{visibility:"public"|"members", building:"members"|"everyone",
guestsMayBuild:boolean, members:{"nostr:<pubkey>":"builder"|"viewer"}}`.
Defaults are private, members-only and no guest building. A module author does not
automatically gain access to another player's private world. The provider operator
still controls the database: encryption in transit is not end-to-end private storage.

## Player calls

Use ordinary NAP-CVM `cvm.request` or the host's `soy.backends.v1` registry family.
MCP `tools/call` wraps these arguments as `{name, arguments}`. Read
`structuredContent`, or the JSON text content in another conforming client, and
check `isError`. No new REST proxy is involved.

1. `soy_backend_describe({module:{napplet:naddr,name:"worlds"}})` returns the
   active release, schemas, limits and signed build receipt.
2. `soy_backend_invoke({target:{module,release}, operation:"createWorld",
requestId:crypto.randomUUID(), expiresAt:now+240, input:{...}})` creates a world.
3. Subsequent invocations include `target.instance` and its **pinned** release.
4. `soy_backend_changes({target,after:revision})` returns revision invalidations,
   not private state. Poll conservatively, then refetch via an authorized query.
   An expired cursor reports `RESYNC_REQUIRED`; take a new snapshot.

### Responsive shared editing

An authoritative save need not freeze the UI. Keep a confirmed snapshot separate
from pending local edits, show immediate pending feedback and serialize a bounded
command queue. Queue input while a background read finishes instead of disabling
all controls or dropping clicks. Stop accepting more work visibly when the queue
is full; a faster animation does not increase the provider's capacity. Coalesce
refreshes and honor provider limits rather than imposing an unexplained per-click
delay or overlapping many calls.

Only a confirmed provider result means an edit is saved. Retain the exact request
ID, expiry and payload while its outcome is uncertain. Do not rewrite an in-flight
intent to match newer local predictions. On a definitive rejection, reconcile the
pending display and dependent queued edits with confirmed state. On CONFLICT,
refetch before constructing any new intent; do not blindly replay stale edits.
Ignore stale snapshots and preserve pending feedback while newer state arrives.

Prefer compact operation results and queries for affected records/chunks. Use
full snapshots for joining and recovery, not every click or unchanged poll.
`soy_backend_changes` can detect new revisions without running a query handler;
it returns invalidations, not patches. Chunk records reduce payloads but do not
remove the current instance-wide conflict check. A creator-defined bounded batch
operation is possible when its schema and rules explicitly define atomic behavior.

CEP-41 streams, backend watches and direct provider WebSockets are **not exposed
by this host**. WebRTC can carry transient presence or bounded untrusted refresh
hints; a peer's message is not proof of a durable commit. TURN only assists the
peer connection and cannot remove CVM save or polling latency.

In multiplayer scenarios, measure input-to-local-feedback, provider confirmation
and edit visibility on the other player separately. Also exercise rapid input,
simultaneous edits, rejection reconciliation and uncertain retries. Record the
chosen budgets, observed timings and environment. The runner's latency/jitter
controls affect WebRTC data channels, not CVM; local tests do not establish
public-network or physical-phone performance.

### Frontend example and response shapes

`backend init` (or `soyli dev`) writes `.napplet-space/soy-backend.json` with the
public `provider`, `napplet` address and `modules`. Use that napplet address and
your manifest name for the module reference, not the browser URL or transport key.
The host maps the configured provider onto its local copy during preview.

The context is generated, ignored, and recreated by `soyli setup`, `build`, `dev`
and `run`. Keep provider/module declarations in tracked `napplet.json`; never
force-add the private `.napplet-space` directory. On a fresh checkout run
`soyli setup` before invoking the package manager directly.

If older guidance committed that context and it has since been removed from Git,
the updated publisher accepts its historical versions only after strict validation
of the former public metadata format and the normal credential scan. Keep the
current context ignored; do not rewrite Git history merely to remove valid old
public context. Run `soyli publish --dry-run` to check ancestry. A rejection names
the path/blob/commit; private bindings, journals, databases and unknown fields stay
blocked. This needs the publisher fix, not just updated project skills.

### Typed handler identity

The shipped `docs/examples/backend-context.d.ts` describes the handler context.
A type-only import is erased by the compiler and requires no runtime dependency:

```ts
import type { BackendContext } from '../docs/examples/backend-context';
export async function handle(ctx: BackendContext, input: Record<string, unknown>) {
  if (ctx.principal !== ctx.owner) throw new Error('FORBIDDEN: Only the owner can do this.');
  // Implement the declared operation here.
}
```

Prefer schema `access: "owner"` for an operation that is always owner-only.
`ctx.account` is a verified raw hex key (or null); `ctx.principal` and `ctx.owner`
are prefixed principals, such as `nostr:<pubkey>`. Comparing account directly to
owner always fails. `ctx.actor` is the ephemeral transport key, not ownership.

### Account-required test scenarios

Use `soyli multiplayer tests/worlds.mjs` with its bundled browser and disposable
backend. It copies declared module sources and starts with empty isolated state.
Adapt the following selectors to the game's UI:

```js
export default async ({players, connectIdentity, approveBackendAccount, check}) => {
  const [owner, guest] = players;
  const {pubkey} = await connectIdentity(owner);
  await owner.frame.getByRole('button', {name: 'Create world', exact: true}).click();
  await approveBackendAccount(owner, 'main');
  await owner.frame.getByText('World created', {exact: true}).waitFor();
  check('owner created a world', await owner.frame.getByText('World created', {exact: true}).isVisible());
  // Share its world code with guest, then assert the actual guest edit/result.
  // Add denied owner actions, simultaneous edits, conflicts and exact retry.
};
```

These are ephemeral test viewers, not your CLI creator. Real account proofs and
ACLs remain active. Tests must distinguish guest, owner and other signed-in
players. `backend check` only compiles; `check` only verifies startup. The runner
only verifies the assertions you supply. Restart persistence and old-release
pinning still need explicit tests in a persistent `soyli dev` session. Interactive
captures can connect a browser extension; automatic captures start as guests.

The optional `docs/examples/backend-client.ts` helper unwraps MCP results and
preserves the distinction between a definitive rejection and an uncertain
transport failure. In a TypeScript project, copy/import it and use the injected
SDK after the normal host handshake:

```ts
import { cvm } from '@napplet/sdk';
import { backendClient } from '../docs/examples/backend-client';
const api = backendClient({ cvm });
const module = { napplet: 'naddr... from soy-backend.json', name: 'main' };
const description = await api.describe(module);
if (description.disabled || !description.active) throw new Error('Backend unavailable');
const create = api.intent({ module, release: description.active }, 'create', {});
const created = await api.invoke<{ value: number }>(create);
const target = { module, release: created.release, instance: created.instance };
// Save/share target. Do not replace its release with the latest active release.
const increment = api.intent(target, 'increment', { expectedValue: created.result.value });
const updated = await api.invoke<{ value: number }>(increment);
console.log(updated.result.value, updated.revision);
// If the connection drops, retry api.invoke(increment), not a newly made intent.
```

The operation names and payloads above match `backend init-module`'s counter;
MiniCraft and your own module declare different operations.

- `describe`: `{module, active, release, revision, disabled, schemas, receipt,
profile, limits}`. `active` is the default for new instances. `release` identifies
  these schemas/receipt; request an existing instance's release explicitly.
  Without an active release, `active:null` and no `release/schemas/receipt` are returned.
- `invoke`: `{ok:true, release, requestId, instance, revision, result}`. Your
  handler's return value is nested under `result`. The outer revision covers the
  whole instance; a record's own revision, if defined, is application data.
- `changes`: `{release, revision, after, changes:[{revision}], hasMore,
mode:"invalidate-and-query"}`. Advance the cursor using `after`, then query the
  needed state; no operation result or record is embedded in these invalidations.
- A tool error has `isError:true` and `{ok:false,error:{code,message,retryable}}`
  in structured content. `CONFLICT` means refresh before a new intent.
  `FORBIDDEN`/`ACCOUNT_REQUIRED` require permission/account changes chosen by the
  user, not an automatic identity switch. Transport errors are uncertain: retain
  the original intent and expiry, then inspect state if the retry window expires.

In the shell/preview host, the first eligible call asks permission to use the
signed-in account. The host constructs and verifies an exact proof binding that
account to this provider, transport and napplet module. Sessions last up to one hour.
Reloading the host or reconnecting its transport may require fresh consent before
then. Preview may also require reconnecting the selected browser identity. Restore
viewer-scoped UI/storage when identity changes, not just at initial startup.
The supplied client allows up to two minutes for account-bound calls, including
the host prompt and extension/remote signer approval. Provider RPCs still time out
within 25 seconds after initialization; handler execution and the original intent's
retry expiry are unchanged. Session lifetime is checked when binding completes,
so taking time to approve does not invalidate an otherwise valid session. Old
projects must update their copied `docs/examples/backend-client.ts` as well as the
host/soyLI to receive this behavior. A timeout still means an uncertain outcome:
retain and retry the same intent, never silently create a replacement world.
The iframe receives no key or arbitrary signing capability. Guest calls remain
possible where the rules allow them. A signed-in identity must match across devices
to retain world ownership. A guest transport key is not a durable profile identity.

Other clients can implement the same challenge/bind exchange using
`soy_backend_session_challenge`, `soy_backend_session_bind` and
`soy_backend_session_revoke`. The returned session is transport-bound, not a bearer
credential. Authorizations are signed but **not published as social notes**.

Keep the exact request ID, expiry and payload when retrying an uncertain result.
The retry window is at most five minutes. Changing input under the same request ID
is rejected. After expiry, inspect world state before making a new intent.

For deletion, a world owner obtains `soy_backend_purge_plan`, displays its details,
then sends the reviewed `plan`/`planHash` and original `target` with their session to
`soy_backend_purge_confirm`. A changed world invalidates the plan. The result names
removed live data and retained code, public history, independent copies and
operator-managed backups. Do not describe this as deletion from the entire network.

## Creator release management

Public availability is provider-specific. Local preview works without public
admission; public builds require a provider advertising `soy.backends.v1` and
admitting your creator account. A web/CLI release alone does not enable hosting.
Check `soyli backend status --json` and report unavailable/admission errors. The flow is:

```sh
soyli checkpoint "Add backend rules"
soyli publish                          # first source publication; soyli push for later source edits
soyli backend deploy backend/backend.json
soyli backend describe main
soyli backend disable main
soyli backend enable main
soyli backend delete-release main --revision <unused-release-hash>
```

Use the name in your manifest (`worlds` for the MiniCraft example).
`deploy` requests a provider build of the selected creator's committed, public
GRASP source, waits for the result, then activates it for new worlds. No account
is changed to resolve a failure. It requires clean committed source and a provider
advertising this family and admitting your creator account. Site administrators
can grant access in Administration → Backend slots; check provider status before
promising publication.
An active or instance-referenced release cannot be deleted. Public Git history and
the signed receipt remain. Disabling retains state.

Source fetching only admits operator-listed origins, author-qualified GRASP paths,
exact Git commits and regular tracked files. Hooks/helpers, redirects and submodules
are disabled. Only the manifest, handler and schema bytes enter compilation.
Receipts bind their hashes, source commit, compiler/runtime version, schemas,
artifact and policy. The source is never executed by Bun: only transpiled, then
executed in the WASM worker. A provider signature is an assertion of provenance,
not proof of honest execution. Two local builds are checked for matching output;
independent reproducibility has not been established.

## Delivery boundary

Preview and backend checking do not certify game rules, mobile UX or public
hosting. No automatic migrations, background tasks, cross-instance transactions,
backend manager GUI or world export tool is included. Large media belongs on
Blossom. Restart preview after changing the handler or schemas.

Keep a pending creation intent until its result is known and save the returned
instance/release immediately. If every creation response is lost and its retry
window expires, this version has no instance-listing API to recover an unknown
instance ID. Do not silently create a second world and claim the first was recovered.
