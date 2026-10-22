# Give each napplet its own visual language

Start from what people will do and feel in this napplet. The starter is a capability
demo, not an art direction. Choose the look of the game, artwork or working surface
**and** its HUD, menus, forms and controls together. A distinctive scene inside an
untouched demo toolbar is unfinished design.

## Before styling

Respect the user's references and the existing creation when contributing or
remixing. For a new creation without a direction, briefly consider two plausible
directions rooted in its subject or mechanic, choose one, and implement it. This
does not need a separate approval step. Add a short visual-direction section to
the project's design brief (or README if there is no brief):

- **Character:** the mood and one distinguishing visual idea, with a reason it
  suits this particular experience.
- **Main surface:** scene/background, objects, materials or illustration, lighting
  and effects for a game; hierarchy and working content for a tool.
- **Interface:** typography, color roles, shape/edge language, spacing/density,
  icons, control feedback and motion. Explain how these belong to the same world.
- **Theme policy:** app-owned (the default), host-matched interface, or a deliberate
  hybrid. Name the surfaces that may change and those that must retain their colors.
- **Proof:** one representative interaction/state and the small/large/touch layouts
  you will inspect. Include the frame that should make a compelling listing cover.

Translate that direction into a small set of named CSS and renderer tokens. Keep
gameplay colors legible: hazards, teams, scores and selection states must remain
distinguishable. Decorative choices should reinforce the interaction, not obscure it.

There is no required napplet.soy palette, mascot, font, rounded-card treatment or
editor-panel layout. Do not copy the host's cream/green branding or another demo's
look merely because it is visible. Beige, dark, monochrome, saturated and restrained
work can all be right when chosen for the project. Variety comes from the idea,
not random colors or a mandatory new theme pack.

Choose type sizes and density for the task. A drawing tool, a story and an arcade
game need different controls and hierarchy. The starter's 13px text, 28px controls
and settings for them are replaceable examples, not product requirements. Keep
the frame useful and responsive; remove unused demo panes and controls. Menus,
title screens, illustrations and in-world labels are welcome when they serve the
experience. Avoid surrounding the actual app with redundant website navigation
or a marketing page.

## Host theme is optional input

NAP-THEME exposes the shell's colors; it does not require every creation to adopt
the shell's identity. The host does not inject a stylesheet into your napplet.
An SDK theme handler that assigns `--bg`, `--fg` and `--primary` can nevertheless
overwrite your authored CSS and any renderer that reads those variables.

The TypeScript starter keeps `FOLLOW_HOST_THEME = false` in `src/main.ts`. Its local
CSS palette remains active even when the host offers theme data. Replace the demo
palette with your chosen direction. For a utility deliberately designed to match
its host, opt in by setting the constant to `true` and adapting `applyTheme`.
Theme remains optional: keep a complete local palette when it is unavailable.

For a hybrid, scope host-derived tokens to the intended interface region. Give the
scene/artwork and semantic game colors their own tokens; do not let a document-wide
theme handler recolor terrain, pieces, drawings or teams. If you build app-owned
light/dark variants, design both palettes; do not substitute the host's three brand
colors for them. NAP-THEME has no `mode` or `dark` field to assume.

Opted-in regions must handle initial theme data and live changes consistently,
including loading/empty/error states. Validate supplied colors, feature-detect
the optional domain, and close SDK subscriptions on teardown. A theme change must
not recreate the game or lose progress. Font/media assets follow the same asset
and sandbox rules as the rest of the napplet.

## Check the result

Use the real hosted preview. Inspect the main experience and surrounding UI at
`200×160`, `320×560`, `900×600` and full screen, plus touch portrait/landscape checks
from the mobile guide. If a genuinely necessary minimum is declared, show a useful
notice below it and resume intact above it. On large displays, expand the working
area or intentionally compose the scene; do not stretch art or add panels just to
fill space. Use comfortable touch targets, readable contrast, visible keyboard
focus, non-color status cues and reduced-motion alternatives.

Switch the host between light and dark, then test without the optional theme
domain. App-owned palettes should remain intact; host-matched regions should
change coherently; hybrids should change only their chosen regions. Check both
CSS and canvas/WebGL colors, and verify the interaction still works afterward.

Before capture, compare the result with the brief: is it recognizable from its
composition and controls as well as its colors? Remove leftover starter styling.
Inspect the actual screenshot and full clip at gallery size; capture the main
interaction rather than an untouched menu. Report which views and theme policies
were checked and any gaps. These checks establish intent and usability, not an
automated score for originality.

## Existing projects

`soyli skills update` installs this guide as `docs/napplet-visual-design.md` and the
adapted agent guidance, preserving edited managed files as conflicts. It does not
rewrite `AGENTS.md`, source, CSS, configuration or published assets. Older generated
documents may still mandate compact density and whole-surface host colors; those
authoring recommendations are superseded by this guide. Keep their sandbox and
protocol boundaries.

When asked to update a project's look, inspect `themeGet`, `themeOnChanged`,
`applyTheme`, root CSS assignments and renderer palettes, plus the example
`src/napplet-settings.ts` / `config.schema.json` size settings. Choose the theme
policy, remove or scope unwanted overrides, and update project-specific guidance.
Preserve existing art direction unless a redesign was requested. Rebuild, verify,
recapture and publish deliberately; updating skills alone changes no live napplet.
