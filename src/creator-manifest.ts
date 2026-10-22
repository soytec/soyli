import guide from '../docs/NIP5D-CREATOR.md' with { type: 'text' };

/** Adapt generated guidance without rewriting the pinned vendor snapshots. */
function replace(source: string, before: string, after: string) {
  if (source.split(before).length !== 2)
    throw new Error('Upstream manifest guidance changed; review the soyLI adapter.');
  return source.replace(before, after);
}
export const manifestGuide = guide;
export function adaptManifestSkill(path: string, source: string) {
  if (!path.endsWith('/SKILL.md')) return source;
  if (path === 'skills/napplet-build/SKILL.md') {
    source = replace(
      source,
      'The aggregate hash lands in `.nip5a-manifest.json` and the signed event, not in a meta tag. `VITE_DEV_PRIVKEY_HEX` produces a signed manifest in CI; dev builds work without it.',
      'soyLI publishes the HTML SHA-256 in the standalone NIP-5D `x` tag. Keep the existing Vite single-file build; do not set `VITE_DEV_PRIVKEY_HEX` or publish its optional legacy manifest. See docs/napplet-manifest.md for description, required/optional domains, archetypes, intents and icons.',
    );
    source = replace(
      source,
      "| `vite.config.ts` | Hard `requires: [...]`, `archetypes`, optional config schema; keep `artifactMode: 'single-file'` and the `nappletType` fallback |",
      "| `vite.config.ts` | Hard `requires: [...]` and optional config schema; keep `artifactMode: 'single-file'` and the `nappletType` fallback. Put published archetypes, intents and optional domains in `napplet.json`. |",
    );
  }
  if (path === 'skills/napplet-test/SKILL.md')
    source = replace(
      source,
      '- **Manifest problem** — missing/invalid signed manifest tags. Confirm NIP-5A `d`, `path`, and aggregate `x` tags; hard capabilities are `requires` tags on that event.',
      '- **Manifest problem** — check the standalone HTML SHA-256 `x`, nonempty plain-text content and required `R` domains. Only named events carry `d`; `O` is optional. Older `path`/aggregate manifests remain readable. See docs/napplet-manifest.md; do not rewrite signed events or weaken host verification.',
    );
  source = source.replace(/manifest `requires`/gi, 'local `requires` (published as `R`)');
  if (path === 'skills/napplet-make/SKILL.md')
    source = source.replace(
      '`.napplet/config.json` still owns deployment metadata.',
      '`napplet.json` owns portable metadata; use docs/napplet-manifest.md.',
    );
  if (
    [
      'napplet-build',
      'napplet-make',
      'napplet-design',
      'napplet-sdk',
      'napplet-test',
      'napplet-interop',
    ].includes(path.split('/')[1])
  )
    source +=
      '\n## soyLI manifest metadata\n\nBefore publication or changing capabilities/discovery, read docs/napplet-manifest.md. Save metadata in napplet.json; the publisher creates the signed event. Advertise only implemented intents and optional integrations, and verify their absent-domain fallbacks.\n';
  return source;
}
export function adaptManifestBoilerplate(path: string, source: string) {
  if (path === 'docs/nip-5d.md')
    return `# NIP-5D reference\n\nSelected standalone draft: https://github.com/dskvr/nips/blob/4d0fb2e9fa1fdca71be09b17a4c5f382fbca5d51/5D.md\n\nRead docs/napplet-manifest.md for this installed soyLI's authoring and legacy-compatibility contract. The selected draft defines the manifest and sandbox; matching NAPs define domain messages. Package documentation can lag the draft. Do not copy host policy into app code or invent new message envelopes.\n`;
  if (path === 'README.md') {
    source = replace(
      source,
      '`pnpm build` uses `@napplet/vite-plugin` to produce one inlined `index.html` and,\nwhen `VITE_DEV_PRIVKEY_HEX` is set, write a local napplet manifest JSON file for\nhash workflow testing. That file uses NIP-5D kinds with the NIP-5A tag schema.',
      "`soyli build` uses the pinned Vite plugin to produce one inlined `index.html`.\n`soyli publish` signs the standalone NIP-5D manifest; its `x` is the HTML SHA-256.\nDo not use the plugin's optional legacy manifest for publication. Read\n`docs/napplet-manifest.md` for editable capabilities, discovery metadata and icons.",
    );
    source = replace(
      source,
      'The executable `index.html` does **not** carry its own aggregate hash. Before\nexecution, the runtime verifies manifest path blobs and recomputes the NIP-5A\naggregate carried by the manifest `x` tag.',
      'The executable `index.html` does **not** carry its own manifest hash. Before\nexecution, the runtime verifies the signed manifest and the HTML SHA-256 against\nits `x` tag. Earlier manifests remain readable through the legacy validator.',
    );
  }
  if (path === 'docs/package-surfaces.md')
    source = replace(
      source,
      'write a local kind `35129` manifest JSON file when `VITE_DEV_PRIVKEY_HEX` is set;\nthe NIP-5A aggregate covers path tags, while `requires` is a separate NIP-5D\nmanifest tag. Declare only hard domains through the explicit `requires` option',
      'write a legacy local manifest, but soyLI does not use that as its publication.\nDo not set `VITE_DEV_PRIVKEY_HEX`; soyLI signs the standalone HTML-hash manifest.\nIts `R` tags are derived from the explicit local `requires` option',
    );
  if (path === 'docs/authoring-checklist.md')
    source = replace(
      source,
      '- [ ] Manifest changes are intentional: NIP-5A path tags determine the\n  aggregate; hard `requires` entries are separate NIP-5D manifest tags.',
      '- [ ] Manifest metadata matches docs/napplet-manifest.md: raw HTML hash in `x`,\n  plain-text description, required `R`, optional `O`, implemented intents and a\n  verified optional icon. Use soyli publish; do not sign a build-plugin manifest.',
    );
  if (path === 'docs/design-patterns.md')
    source = replace(
      source,
      'Storage is scoped by napplet identity and aggregate hash on the shell side.',
      'Storage is scoped by verified author/application identity and executable bytes on the shell side; ancestry never grants access to another app.',
    );
  if (path === 'vite.config.ts')
    source = replace(
      source,
      '// then content-address it with the NIP-5A tag/hash schema.',
      '// soyLI publishes its raw HTML hash using standalone NIP-5D manifests.',
    );
  return source.replaceAll('manifest `requires`', 'local `requires` (published as `R`)');
}
