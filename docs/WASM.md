# Rust, WebAssembly and Bevy napplets

The Rust build recipe produces the same signed, single `/index.html` artifact as
a JavaScript napplet. Players install nothing. It runs in the same opaque iframe
and uses the same host capabilities on napplet.soy and in `soyli dev`. Rustup is a
creator prerequisite, not a player prerequisite. No engine-specific starter is
required: keep an ordinary Cargo project and add the local recipe below.

## Supported boundary

- Single-threaded `wasm32-unknown-unknown`, wasm-bindgen's browser bindings and
  WebGL2. This is WASM **inside the existing web projection**, not a new NAP WASM
  projection or capability called `wasm`.
- Executable WASM, JavaScript and CSS stay embedded in one HTML file. No external
  executable modules, dynamic network imports, raw networking or worker exemption.
- 25 MiB final HTML. The build gzip-compresses WASM before base64 embedding;
  the decoded module is capped at 32 MiB. Source and
  reachable Git history each have the existing 40 MiB budget; at most 1,024 selected
  source/release files, including built HTML and previews, and a 50 MiB source tar.
  The Rust linker sets a 256 MiB maximum linear memory. This is a build
  profile, not a bound on the browser's total GPU/JavaScript memory usage.
- Published-artifact readers accept HTML up to 100 MiB, including compatible
  artifacts produced by other build tools. This does not raise soyLI’s 25 MiB build
  and publishing limit. The website, indexer and runtime need the updated read
  limit deployed before accepting HTML above 25 MiB; a CLI update alone is
  insufficient. Managed assets and host resources retain their 10 MiB limits.
- Threads, SharedArrayBuffer, WebGPU, WASI, native OS APIs and Godot are outside
  this initial qualification. A project can choose other tools, but its result
  must still work inside the same sandbox and limits.

## Configure an ordinary Rust project

Keep normal source, Cargo.toml, Cargo.lock, LICENSE and a pinned
rust-toolchain.toml in Git. Do not replace an existing project by re-scaffolding.
In its normal `napplet.json`, set `entry` to `dist/index.html` and add:

```json
"build": {
  "kind": "rust",
  "crate": "my-game",
  "target": "bin",
  "toolchain": "1.97.1",
  "bindgen": "0.2.125",
  "profile": "release"
}
```

`crate` selects the Cargo binary (hyphens preserved). For a `cdylib`, use
`target: "lib"` and its library name. The first implementation supports a package
at the project root; complex workspaces can supply a custom build recipe.
Optional `features` and `defaultFeatures` map to ordinary Cargo flags.

```toml
# rust-toolchain.toml
[toolchain]
channel = "1.97.1"
profile = "minimal"
targets = ["wasm32-unknown-unknown"]
```

Pin `wasm-bindgen = "=0.2.125"` in Cargo.toml. The CLI version and the single
wasm-bindgen version resolved in Cargo.lock must match exactly; soyLI explains
which pin to fix. Do not silently update someone else's lockfile to make a build
pass. Tested companion versions are js-sys/web-sys 0.3.102 and
wasm-bindgen-futures 0.4.75.

`soyli setup` installs the selected Rust toolchain through an existing Rustup,
adds the WASM standard library and caches that exact wasm-bindgen CLI. It creates
Cargo.lock only if absent. It does not change your default Rust toolchain or
replace your globally installed wasm-bindgen. First setup/build can take several
minutes; compiler output is visible and cancellation stops owned build processes.
If Rustup is missing, install it from [rustup.rs](https://rustup.rs).
Compiling the cached wasm-bindgen CLI also needs the platform's native C compiler
and linker (for example Xcode Command Line Tools on macOS or a Linux build-tools
package). Missing prerequisites retain their compiler/linker diagnostic.

Your `index.html` is a small page template containing your canvas, inline styling,
loading/error UI and exactly one `<!-- soyli:wasm -->` marker in the body. soyLI
replaces it with the bundled bindings and embedded module. Local JS snippets from
wasm-bindgen are bundled too. No separate `.wasm` is fetched by the viewer.
The browser decompresses the embedded bytes in memory using `DecompressionStream`
(gzip); browsers without it show an update message. This opens no network or worker
permission. The loader exposes `window.soyliWasmReady`, a Promise resolving to the Rust exports
after initialization. Use it for optional HTML buttons that call exported Rust
functions; do not invent host-owned SHELL handshakes in the app.

If present, `config.schema.json` is validated and embedded using the existing
`napplet-config-schema` metadata convention. Declare mandatory NAP domains in
`napplet.json.requires`; engine choice grants no new host permission.

```gitignore
/target/
/.napplet-space/
/dist/
```

soyLI's own Rust outputs live under ignored `.napplet-space/wasm-target`, and
`.napplet-space/wasm-build.json` records module/HTML bytes, linear-memory ceiling
and build duration. Keep the template, Rust sources, lockfiles, asset originals,
schemas and helper modules in Git. Exclude caches, not the files needed to rebuild.

## Build, edit, check and share

```sh
soyli setup
soyli build
soyli dev
soyli check
soyli doctor
soyli checkpoint "Build the first playable version"
soyli publish
```

`dev` serializes rebuilds when Rust/source/template/config/asset files change. It
uses its own watcher; cargo-watch is not needed. A failed rebuild reports the
compiler's cause and keeps the last successful preview. Save a fix to retry.
Optional `build.watch` replaces the default relative source globs; include all
build inputs. Generated directories are always excluded. Restart preview after
changing build kinds. Stop your preview session when finished; never kill other
projects' Bun/Node processes to reclaim a port.

Initialization can take longer than a JavaScript app. Set `preview.readySelector`
to a DOM marker your app creates **after its scene/assets are usable**, for example
`html[data-napplet-ready='true']`. Browser checks/capture wait up to 30 seconds for
that milestone before applying `preview.delayMs`. The host handshake and successful
module compilation alone do not prove a rendered game. Missing readiness is an
actionable error, not a successful screenshot of a loading screen.

The normal publishing, remix and proposal flow is unchanged. A clone preserves
Cargo source and pins, then `soyli setup` and `soyli build` recreate the artifact.
Opening a built proposal never executes its Cargo/build scripts. Rebuild only
source you have chosen to trust. Rust build scripts/procedural macros execute on
the creator's machine, just like other build tools.

For other build tools, `build: { "kind": "command", "command": ["executable",
"argument"], "watch": ["src/**/*", "index.html"] }` runs an argument array
without shell interpolation. It must write a complete `dist/index.html`.
`timeoutSeconds` defaults to 300 (maximum 1200). `soyli setup` does not provision
arbitrary custom toolchains. Omit `build` to keep the maintained Vite workflow.

## Calling the host from Rust

The creator kit ships `docs/examples/napplet.rs`. Include it as a Rust module:

```rust
#[path = "../docs/examples/napplet.rs"]
mod napplet;
// In an async task, never block the browser/render loop:
let value = napplet::call("storage", "getItem", &["best-score".into()]).await?;
napplet::call("storage", "setItem", &["best-score".into(), "42".into()]).await?;
let settings = napplet::call("config", "get", &[]).await?;
```

The helper preserves JS receivers, synchronous exceptions and asynchronous
rejections. `domain`/`invoke` also let you bind standard callbacks and call session
objects. For CVM, use the exact request shapes in docs/napplet-backend.md and
docs/napplet-actions.md, construct JS objects (or serialize with serde-wasm-bindgen),
and await replies in local tasks. Keep game state changes on the engine update
loop; do not block on host/network responses. Preserve callbacks with Rust
`Closure` ownership and close subscriptions when leaving the scene. The helper
does not create an unrestricted host RPC or bypass user consent.

## Bevy guidance

Qualification uses Bevy **0.19.0** (the committed lock resolves its internal
crates to 0.19.1) with default features disabled and only needed
render/asset/window features plus `webgl2`. Do not turn on `default_platform`
blindly: it also includes native/clipboard/threading features. Prefer the smallest
feature set that renders your game. A general 3D project may exceed 25 MiB even if
a small 2D project fits; measure before promising support for an entire engine.
For a minimal 3D feature set without `tonemapping_luts`, explicitly choose a
LUT-free camera tonemapper such as `Tonemapping::None` or `Reinhard`. Bevy's default
AgX produces magenta output when its LUT feature is absent. The checked specimen
uses `None`; visual checks matter even when startup reports no JavaScript error.

```toml
[profile.release]
opt-level = "s"
lto = true
codegen-units = 1
strip = true
panic = "abort"
```

Point the main `Window` at your existing canvas and enable
`fit_canvas_to_parent`. Give html/body/canvas explicit dimensions and handle
portrait layouts, touch, focus and resize. Do not assume the browser's viewport is
the iframe's size. Run representative gameplay on a phone; desktop WebGL startup
does not establish mobile performance. Keep keyboard/pointer alternatives to
gamepads. Browser audio still needs user interaction.

Bevy's default HTTP AssetReader is blocked by the sandbox. For small resources,
use `include_bytes!`/Bevy embedded assets. For managed external resources:

1. Add original assets using `soyli assets add` or the local manager. Keep its
   inventory and originals so publish/propose uploads them and remixes restore them.
2. Include `docs/examples/napplet_bevy.rs` alongside `napplet.rs`.
3. Register `NappletAssets` **before** DefaultPlugins.
4. Use `asset_server.load("napplet://<sha256>.png")` with a hash from the inventory.
   This adapter calls standard `napplet.resource.bytes("blossom:sha256:<hash>")`;
   the trusted host performs byte/hash/MIME checks and local-preview resolution.

The extension selects Bevy's loader. This flat hash reader has no directory
listing or metadata files. Compound formats with relative dependencies (such as
multi-file glTF) need an explicit mapping/asset loader or a self-contained variant;
do not fall back to raw HTTP. Current managed formats and budgets are in the
[asset guide](https://github.com/zeSchlausKwab/napplet-soy/blob/main/docs/ASSETS.md).
Managed assets also accept verified binary packs, JSON and text under the existing
resource policy. This does not add a Bevy loader or decoder for those formats;
compressed meshes and relative dependencies still need application-side support.

## Sources and verification boundary

- [Bevy 0.19 web build guidance](https://github.com/bevyengine/bevy/blob/v0.19.0/examples/README.md#wasm)
- [Bevy size optimization guidance](https://bevy.org/learn/quick-start/getting-started/setup/)
- [wasm-bindgen browser loader and byte input](https://wasm-bindgen.github.io/wasm-bindgen/examples/without-a-bundler.html)

The selected NIP-5D, shim, SDK and NAP bindings are unchanged. See the
[compatibility record](https://github.com/zeSchlausKwab/napplet-soy/blob/main/docs/COMPATIBILITY.md)
for actual verification evidence; this guide is not a claim of universal engine,
mobile-GPU, independent-client or WASM-native-projection conformance.

### Reproducing the local acceptance specimen

From the soyLI source checkout (Bun, Git, Rustup and the test browser required):

```sh
bun scripts/wasm-fixture.ts .local/wasm-proof
bun run soyli setup --project .local/wasm-proof
bun run soyli build --project .local/wasm-proof
bun run soyli browser install
SPACE_TEST_WASM_PROJECT="$PWD/.local/wasm-proof" bun test tests/services/wasm.test.ts
SPACE_TEST_WASM_PROJECT="$PWD/.local/wasm-proof" bun test tests/services/wasm-publishing.test.ts
```

The second test starts disposable local relay/Blossom/GRASP services, creates test
identities, publishes, clones the Git source and rebuilds a playable proposal. It
does not publish to public services or use your saved creator account. For its
service prerequisites, use the repository's normal local development setup.
The fixture is a test specimen, not a required Bevy starter. Set its build
`features` to `["scene3d"]` and rebuild to exercise the 3D WebGL2 renderer too.
