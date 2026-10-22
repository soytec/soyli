# Mobile delivery and promotional media

Build for people opening a shared link on their phone as well as on a desktop.
Read this alongside the upstream napplet skills and the soyLI integration guide.
Mobile support is a product expectation, not an additional protocol requirement.

## Before calling the app finished

- Exercise the built napplet inside `soyli dev`, including its real host capabilities.
  Test a portrait viewport around 390 × 844, a compact 360 × 640 viewport and landscape
  around 844 × 390. Change the browser viewport and input emulation, not only the
  size of a screenshot. Also check the desktop layout.
  Measure the napplet iframe's actual `innerWidth`/`innerHeight`; the outer manager
  viewport is not the app's viewport. The normal preview frame has a 300px minimum
  height. For smaller embedded-frame tests, explicitly size the frame in the test
  harness and assert its inner dimensions before interacting. Record any test-only
  style overrides; do not claim a 160px test from a frame that was really 300px.
- Complete the main task using touch without a keyboard or hover. Games should
  provide comfortable on-screen controls, including simultaneous movement/action
  touches where needed; utilities need usable forms and navigation. Aim for touch
  targets at least 44 CSS pixels wide/high, with space between unrelated actions.
  A visually small control can still have a larger hit area. On coarse pointers,
  expand the clickable area or use larger
  controls without overlapping neighboring targets; compact visuals are not a
  reason to leave phone controls hard to hit.
- Keep essential controls visible around browser chrome, safe areas and changing
  viewport height. Check the shell's corner menu as well as the napplet's controls.
  Avoid disabling scrolling or browser gestures outside the play surface that needs it.
- Handle pointer cancellation, lost focus, pause/resume and orientation changes
  without stuck movement or lost input. Retain keyboard/controller alternatives
  where relevant. Audio starts through an intentional user interaction.
- Check readable text, contrast, reduced motion, loading/error states and startup on
  a slower connection. Resize after starting; don't assume a fixed canvas size.
- Browser emulation is useful but does not prove performance, audio activation or
  behavior on actual iOS/Android devices. Report exactly what was checked and what
  still needs a real phone. `soyli check` does not certify all of this automatically.

## Make assets that show the app doing something

Capture the final build in a useful, representative state: a jump or close call,
a populated board, an edited drawing, a changing visualization or a completed task.
A loading screen, menu or untouched template rarely explains the experience.
For clips, enter the interesting state early and show one understandable interaction.
Inspect both the still image and the entire clip before selecting them in Listing.
Use only visuals, music and other assets you have permission to redistribute.

Aim to deliver:

- A landscape cover and short landscape clip for the listing.
- A portrait screenshot and short portrait clip for mobile sharing, when capture
  tools permit. Compose and operate the actual app at a portrait viewport; don't
  crop away the controls or stretch a landscape recording to suggest mobile support.
- A short caption and a reproducible capture recipe: viewport, starting state,
  interaction, duration and the build being shown. Describe real features only.

Promotional reuse is the creator's choice. Publishing source under an open-source
license does not automatically grant rights to every embedded image, song or logo.

## Current soyLI limits

`soyli screenshot` and the local manager capture a 1200 × 750 PNG. `soyli record`
and its interaction coordinates use a fixed 960 × 600 landscape viewport. Clips
are silent WebM; there is currently no portrait preset, GIF exporter or social MP4
exporter. Do not promise those formats or invent flags/configuration fields.

Keep the supported landscape PNG/clip selected in `napplet.json`. An agent with
browser capture tools can additionally take a real portrait screenshot in the local
host. Keep extra experiments under ignored `.napplet-space/promotion/` and put
reproducible instructions in a tracked document. Do not silently add large binary
exports to Git or assume ignored exports will be included in publication.

If portrait video cannot be captured with available tools, state that limitation
and supply the intended capture recipe. Do not block publication just because an
optional portrait asset is missing. Selecting media through the manager/manifest
still subjects it to the existing format, size and current-build checks; this guide
does not add extra published asset fields or relax those checks.
