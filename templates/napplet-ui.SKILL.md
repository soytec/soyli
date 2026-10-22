---
name: napplet-ui
description: Use when creating or changing napplet visuals, markup, CSS, game scenes, HUDs or layout. Choose a visual language suited to the project, implement responsive and accessible controls, and verify the intended optional host-theme policy. Read before napplet-build changes the interface.
---

# Napplet visual design

This is soyLI's visual-authoring adaptation of the pinned upstream skill bundle.
Protocol, sandbox and SDK boundaries still apply. Read
`docs/napplet-visual-design.md` for the design brief, theme policies and review steps.

## 1 — Choose the direction

Follow the user's references or the existing project's character. On a fresh
creation, choose a direction grounded in the actual idea before writing CSS.
Record the visual brief in the project: character, main surface, interface,
theme policy and a representative state to verify. Treat the game or artwork and
its surrounding controls as one design. Do not inherit the starter demo or host
branding as the creation's style.

## 2 — Build for the interaction

Replace the demo panes, typography, spacing, shapes and palette to fit the project.
Define meaningful color roles in CSS and the renderer. Match the HUD, menus,
buttons and feedback to the chosen direction. Density is a product decision:
there is no universal 13px type, 28px button, border radius or no-shadow rule.
Keep controls readable and provide comfortable, non-overlapping touch targets
(aim for 44px), keyboard focus and non-color cues. Honor reduced motion.

The runtime frames the app. Avoid redundant website navigation/marketing chrome,
but use title screens, menus, illustrations and labels where they help the actual
experience. Loading, empty, error and signed-out states must be understandable
and offer a useful next action without unnecessarily hiding the working surface.

## 3 — Resize the actual napplet frame

The iframe is the viewport and may resize live. Use container/media queries or
responsive canvas layout. Choose behavior by content rather than blindly keeping
the starter's editor columns. Prevent overflow and clipped essential controls.
Preserve progress across size/orientation changes. Large frames should offer a
useful working area or intentional composition, not a stretched image.

Check `200×160`, `320×560`, `900×600` and the largest available/full-screen frame.
Declare a minimum only if the core interaction genuinely cannot fit: render a
readable notice below it, and resume the app intact when room returns. Follow
`docs/napplet-mobile.md` for portrait/landscape and real touch interaction checks.

## 4 — Implement the chosen theme policy

App-owned colors are the starter default (`FOLLOW_HOST_THEME = false`). Keep them
through host light/dark changes. Opt into matching the host only when that is the
chosen design; a hybrid scopes host tokens to selected UI regions, leaving scene
and semantic colors independent. Consult the guide before adapting `applyTheme`.

If using NAP-THEME, feature-detect it and retain a complete local fallback. Apply
initial/live data consistently to the opted-in surfaces, validate color strings,
and close SDK subscriptions on teardown. Never reset gameplay for a theme change.
No theme mode field, additional NAP or matching-shell requirement is introduced.

## 5 — Review before delivery

Inspect a meaningful interaction and the surrounding UI in all four frames, both
host themes and with theme unavailable. Confirm app-owned colors stay intact or
that only the opted-in surfaces change. Check readability, keyboard/touch input,
state feedback and reduced motion. Compare the result with the brief; replace
unintended starter styling. Inspect the real cover/clip at gallery size.

Report the chosen direction and theme policy, frames and interactions checked,
and unverified gaps. Build/conformance checks alone do not verify visual quality.
