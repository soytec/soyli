import uiSkill from '../templates/napplet-ui.SKILL.md' with { type: 'text' };

// Keep vendored snapshots intact. Fail on upstream drift rather than silently
// reintroducing conflicting authoring rules when the pins are refreshed.
function replace(source: string, before: string, after: string): string {
  if (source.split(before).length !== 2)
    throw new Error(
      `Upstream visual guidance changed; review the adapter for: ${before.slice(0, 80)}`,
    );
  return source.replace(before, after);
}

function section(source: string, start: string, end: string, body: string): string {
  const from = source.indexOf(start),
    to = source.indexOf(end, from + start.length);
  if (from < 0 || to < 0) throw new Error(`Upstream visual section changed: ${start}`);
  return replace(source, source.slice(from, to), body + '\n\n');
}

export function adaptVisualSkill(path: string, source: string): string {
  switch (path) {
    case 'skills/napplet-ui/SKILL.md':
      return uiSkill;
    case 'skills/napplet-design/SKILL.md':
      source = replace(
        source,
        'compact applet, any size',
        'project-specific visual direction, any size',
      );
      source = section(
        source,
        '## Step 4 — Form factor plan (mandatory)',
        '## Step 5 — Write the spec',
        `## Step 4 — Visual direction and form factor

Use napplet-ui and docs/napplet-visual-design.md. Choose a direction fitted to the
idea (or preserve the existing creation), covering both content/game scene and
UI/HUD. Record character, palette roles, type, shapes, density, motion and one
representative state. Starter tokens and host branding are not product defaults.

- Plan tiny, phone, regular, wide and short-height layouts around the interaction.
- Declare a minimum only when genuinely needed, with a useful notice below it.
- Choose app-owned colors (default), host-matched UI or a scoped hybrid. State
  which surfaces may change; test host light/dark and missing theme support.
- Plan usable loading, empty, error and signed-out states and touch/keyboard input.`,
      );
      source = replace(
        source,
        'density: compact | <deviation + reason>',
        'visual direction: <character; main surface; UI/HUD palette, type, shapes, motion>\ndensity: <suited to the interaction and input devices>',
      );
      return replace(
        source,
        'theme: optional | required; fallback palette <bg/fg/primary>',
        'theme policy: app-owned (default) | host-matched UI | scoped hybrid; <affected surfaces and local palette>',
      );
    case 'skills/napplet-make/SKILL.md':
      source = replace(
        source,
        'working, conformant, compact, any-size applet',
        'working, conformant, responsive applet with its own visual direction',
      );
      source = replace(
        source,
        'form factor: compact applet; sizes it must survive; minimum (if any)',
        'visual direction: main experience and surrounding UI; see docs/napplet-visual-design.md\nform factor: sizes it must survive; minimum (if any)',
      );
      source = replace(
        source,
        '- **Applet, not website.** No title header / tagline; compact density; fills the frame; good at tiny and huge sizes; declared minimum only when the UI truly breaks (`napplet-ui`).',
        '- **Project-specific design.** Design the content/scene and UI together; choose density and composition for the interaction. Keep it responsive and avoid redundant website chrome (`napplet-ui`).',
      );
      source = replace(
        source,
        '- **Theme covers the whole surface**, including `html` / `body` / root backgrounds, in dark and light.',
        '- **Theme is a design choice.** Keep app-owned colors by default. Opt into host matching or a scoped hybrid deliberately; test the chosen policy using docs/napplet-visual-design.md.',
      );
      return replace(
        source,
        'in dark and light: no title header, no overflow, frame filled, minimum notice correct if declared.',
        'in dark and light: intended palette preserved or opted-in surfaces updated, no clipped controls, minimum notice correct if declared.',
      );
    case 'skills/napplet-build/SKILL.md':
      source = replace(
        source,
        "Replace the starter's page layout (`.app-shell { padding: 2rem }`, `.workspace { width: min(1040px, 100%) }`, `body { min-width: 320px }`) with the compact, full-frame, container-query layout from `napplet-ui`",
        'Replace demo styling with the project visual direction from `napplet-ui`; keep responsive layout and comfortable controls',
      );
      source = replace(
        source,
        'Lay out `index.html` + `styles.css` per `napplet-ui`: full-frame root, compact tokens, tier rules, theme application, inline states, no title header.',
        'Lay out `index.html` + `styles.css` per the visual brief and `napplet-ui`: project-specific scene/content and UI tokens, responsive behavior, chosen theme policy and usable states.',
      );
      source = replace(
        source,
        'each renders a compact inline state, never a blank frame.',
        'each renders useful feedback and a recovery action, never an unexplained blank frame.',
      );
      return replace(
        source,
        "- Leaving the starter masthead, eyebrow, or `<h1>` in place, or shipping the starter's centered 1040px column — see `napplet-ui`.",
        '- Shipping untouched demo styling or recoloring an authored scene through an inherited theme handler — see `napplet-ui`.',
      );
    case 'skills/napplet-test/SKILL.md':
      source = replace(
        source,
        'no title header, four frame sizes, both themes, minimum notice',
        'visual direction, four frame sizes, chosen theme policy, minimum notice',
      );
      source = section(
        source,
        '## Step 5 — Applet UI checks (`napplet-ui`)',
        '## Step 6 — Scenario smoke tests',
        `## Step 5 — Visual and responsive checks (napplet-ui)

Use the actual hosted frame at 200×160, 320×560, 900×600 and full screen, plus
the touch checks in docs/napplet-mobile.md. Check the main interaction, UI/HUD,
legibility, focus, reduced motion, state feedback and any minimum-size notice.
Large frames should have intentional composition or useful additional workspace.

Compare with the project brief using docs/napplet-visual-design.md: remove unintended
demo styling. Switch host light/dark and remove the optional theme domain.
App-owned colors remain intact; host-matched surfaces update consistently; hybrids
change only chosen regions. Inspect CSS and rendered game/artwork colors. Record
frames, theme policy, interactions and gaps, including actual cover/clip review.`,
      );
      return replace(
        source,
        '- **Theme change:** emit a theme change; the whole surface repaints. A dark card on a white page is a failed integration.',
        '- **Theme change:** emit a theme change; verify the chosen policy. App-owned art stays intact, opted-in UI updates coherently, and gameplay/state does not reset.',
      );
    case 'skills/napplet-sdk/SKILL.md':
      return replace(
        source,
        'Whole-surface application rules live in `napplet-ui`.',
        'This example is opt-in host matching. App-owned palettes are the soyLI default; choose the scope with `napplet-ui` and `docs/napplet-visual-design.md`.',
      );
    case 'skills/napplet-port/SKILL.md':
      source = replace(
        source,
        'Compact, full-frame, tiered layout (`napplet-ui`)',
        'Responsive, project-specific layout preserving the original art direction (`napplet-ui`)',
      );
      return replace(
        source,
        'form factor: compact; tiers; minimum (if any)',
        'visual direction: preserve existing character unless redesign requested; scene + UI\nform factor: product-appropriate density; tiers; minimum (if any)',
      );
    default:
      return source;
  }
}

export function adaptVisualBoilerplate(path: string, source: string): string {
  switch (path) {
    case 'AGENTS.md':
      return section(
        source,
        '## Applet, Not Web Page',
        '## Verification',
        `## Visual direction and layout

Read docs/napplet-visual-design.md and the installed napplet-ui skill before
styling. Choose a visual direction for both the main experience and surrounding
UI/HUD; record it in the project's brief. Replace the capability demo's styling
and example size settings to fit the task. Keep existing art direction on a port
or contribution unless redesign was requested.

The frame can resize live. Check 200×160, 320×560, 900×600 and full screen, plus
touch portrait/landscape. If a minimum is genuinely needed, show a useful notice
below it. Controls must stay readable and reachable.

App-owned colors are the default: FOLLOW_HOST_THEME is false in src/main.ts.
Host matching or a scoped hybrid is an explicit design choice. Verify the chosen
policy in both host themes and without the optional theme domain. Keep gameplay
and semantic colors independent from host branding unless intentionally designed
otherwise. Theme data never implies a mandatory shell palette or density.`,
      );
    case 'README.md':
      return replace(
        source,
        '- An applet-shaped starter layout: no title header (the runtime shows the\n  name), compact density, container-query tiers from a tiny widget to a\n  full-screen pane, and whole-surface runtime theming.',
        "- A responsive capability demo with a replaceable local palette and opt-in host\n  theming. Choose the creation's own scene/content and UI direction using\n  `docs/napplet-visual-design.md`; the demo is not a required visual style.",
      );
    case 'docs/design-patterns.md':
      return section(
        source,
        '## Applet Layout',
        '## Text Selection',
        `## Applet Layout

The starter demonstrates responsive tool panes. Replace their composition and
styling with the project's visual direction, keeping usable resize behavior.
See docs/napplet-visual-design.md and napplet-ui for scene/content, UI/HUD, input,
frame-size and theme-policy checks. Only declare a minimum when genuinely needed.

The starter's local CSS palette is active by default. FOLLOW_HOST_THEME in
src/main.ts opts into applying the host colors; leave it false for app-owned art.
For hybrids, scope host tokens to the intended interface regions and keep scene
and semantic colors separate. Host theme availability is not a styling mandate.`,
      );
    case 'docs/authoring-checklist.md':
      return section(
        source,
        '## Layout',
        '## Lifecycle',
        `## Layout

- [ ] The brief names a visual direction for the main experience and UI/HUD;
  no unintended starter styling remains. See docs/napplet-visual-design.md.
- [ ] Density, composition and controls fit the task and input devices.
- [ ] Checked at 200×160, 320×560, 900×600 and full screen, plus touch layouts;
  essential controls are reachable and readable without clipping.
- [ ] Host light/dark and missing-theme checks confirm the chosen policy:
  app-owned colors stay intact, or only intentionally opted-in surfaces change.
- [ ] A necessary minimum size shows a useful notice; enlarging resumes intact.`,
      );
    case 'src/styles.css':
      return section(
        source,
        '/*',
        ':root {',
        `/*
  Capability-demo styling, not a required look for your creation.
  Choose scene/content AND UI tokens using docs/napplet-visual-design.md.
  Replace this palette, type, density and pane layout to fit the project.
  The local palette remains active unless FOLLOW_HOST_THEME is enabled.
  The iframe is the viewport; preserve usable resize and touch behavior.
*/`,
      );
    case 'src/main.ts':
      source = section(
        source,
        '/**\n * NAP-THEME covers the whole surface:',
        'function applyTheme',
        `// Keep app-owned colors unless matching the host is the chosen visual direction.
// For hybrids, scope applyTheme to the selected UI region; keep scene colors separate.
// See docs/napplet-visual-design.md. This is an app choice, not a NAP requirement.
const FOLLOW_HOST_THEME = false;`,
      );
      return replace(
        source,
        'if (!runtimeHasDomain(THEME_DOMAIN)) return;',
        'if (!FOLLOW_HOST_THEME || !runtimeHasDomain(THEME_DOMAIN)) return;',
      );
    default:
      return source;
  }
}
