# Controllers — native Gamepad input

soyLI includes a **Controller tester** in the `soyli dev` workshop and a
dependency-free input helper for creators. Ordinary USB/Bluetooth gamepads use the browser's
[Gamepad API](https://www.w3.org/TR/gamepad/), not NAP-SERIAL. No server, CVM,
account, new NAP domain or `requires` entry is needed. No shim/SDK/protocol pin
changes are involved. Existing games must explicitly wire their actions to input.

## Support the whole napplet

Controller support is optional. When implementing controller support, cover the
entire napplet. Wire every existing app-owned screen and action: title/start,
menus, settings/options, gameplay or main interaction, pause/resume,
restart/retry, results/next-level, and back/cancel/exit. A playable main scene
with pointer-only menus is incomplete.
Do not invent screens that the experience does not need.

Give each screen a visible selection and predictable navigation, confirm and back
actions. Make every setting usable, including selections, toggles, sliders and text
entry where needed. Route input only to the active screen or topmost app dialog;
gameplay must not consume the same input behind a menu. Require a fresh press for
confirmation/cancellation across screen or focus changes, so a held button cannot
start, restart or dismiss the next screen accidentally. Keep keyboard and
pointer/touch alternatives and the focus-aware behavior described below.

Use native Gamepad input when the browser exposes it. Respect unavailable/blocked
states and any initial browser focus or activation gesture; report that limit and
retain fallback controls. This requirement covers app-owned UI, not shell menus,
browser prompts or host approvals. Do not inject a Gamepad shim, override browser
policy, capture input while unfocused or invent a host API to force access.

## Try a controller

Pair it in the operating system's settings or plug in a data-capable USB cable.
Run `soyli dev`, expand **Controller tester**, click inside the panel, then press
a controller button. Some browsers withhold devices until that gesture. The
tester runs in the same opaque `allow-scripts` sandbox with the same CSP as a
napplet. It displays slots, raw buttons/axes and mapping, and a small movement,
jump/fire and pause experiment. Keyboard focus must be inside it for active input.
Close it to destroy the test session; click your napplet to return input to it.

Adjust the dead zone to inspect stick drift. **Map buttons & axes** overrides
actions for the selected controller for this session, including unknown layouts.
Changing the dead zone resets these test mappings. These are diagnostics, not edits
to the game. Put the chosen indices in the game's binding table. Device IDs,
readings and mappings are not sent to our services or stored by the tester.

Unavailable or blocked API states are reported separately from an empty controller
list. Empty slots are not connected controllers. A successful test establishes
browser input access, not that a game is playable with it. A cable can be charge-only;
controller/OS/browser support varies. Use HTTPS or localhost. Native hardware on
macOS 12/Intel, Safari, Firefox and mobile needs direct testing; Chromium simulation
does not qualify those combinations. See the [browser API guide](https://developer.mozilla.org/en-US/docs/Web/API/Gamepad_API/Using_the_Gamepad_API).

## Give the agent the tools

New projects include `docs/napplet-controllers.md` and
`docs/examples/gamepad.ts`. After updating soyLI, existing projects receive them
with `soyli skills update`; creator edits are preserved and reported as conflicts.
Import the helper directly from source, or copy it into `src/` to own your changes.
It is bundled with your napplet by Vite, with no external runtime dependency. Legacy
single-HTML projects can inline a compiled copy. Nothing injects this helper into
third-party napplets; they can use the native API directly too.

From a typical `src/main.ts`:

```ts
import { createGamepadInput } from '../docs/examples/gamepad.js';

const input = createGamepadInput({
  moveX: [{ axis: 0 }, { button: 14, scale: -1 }, { button: 15 }],
  moveY: [{ axis: 1 }, { button: 12, scale: -1 }, { button: 13 }],
  jump: [{ button: 0 }],
  fire: [{ button: 7 }],
  pause: [{ button: 9 }],
}, { deadZone: 0.18 });

// In your existing requestAnimationFrame loop, poll exactly once:
const frame = input.poll();
for (const controller of frame.players) {
  const { moveX, moveY, jump, fire, pause } = controller.actions;
  // Route by controller.index to your assigned local player, never by array position.
  // moveX.value / moveY.value: -1..1, dead-zone adjusted; normalize diagonal motion.
  // jump.pressed / pause.pressed: one rising edge, not once per simulation tick.
  // fire.down or fire.value: held/analog input, according to the game's rules.
}
// Clear a departing player's input for each frame.disconnected entry.
// On route/session teardown: cancel your animation loop and input.dispose().
```

`pressed`/`released` are edges; `down` uses a configurable `buttonThreshold`
(default 0.5). Axes are clamped and rescaled outside a per-axis dead zone (default
0.18); analog triggers keep their full 0..1 range. Alternative bindings use the
strongest absolute signal; equal opposing signals cancel. The helper does not
advance physics, repeat menu navigation, assign network players or mix other inputs.
The shipped default action names are an example, not a NAP convention.

On focus loss or a hidden document, values are neutral and pressed edges stop.
Connecting, remapping or regaining focus does not generate a phantom press from
an already-held button. Continuous `down` values resume when focused. If the game
requires explicit resume, keep it paused until the user requests that separately.
Poll while visible to receive changes. `reset()` suppresses press edges on the next
poll (use when opening your own modal); `dispose()` releases helper listeners.

Poll results distinguish `ready`, `waiting`, `inactive`, `unavailable`, `blocked`
and `closed`. `connected`/`disconnected` contain browser slot indices, which may
have gaps. A replacement in the same slot emits both. Clear stale input and ask
to rejoin rather than silently giving a replacement somebody else's character.
Browser IDs are not authenticated identity or guaranteed physical-device IDs.

Only `mapping === 'standard'` gets automatic action mappings. For a nonstandard
controller, inspect its raw indices in the tester and explicitly call
`input.remap(controller.index, bindings)` after discovery. This also permits
per-controller overrides for local co-op. The helper forgets overrides on observed
disconnect or replacement. Games can offer an in-game remapping UI and save user
preferences through optional `napplet.storage`; opaque iframes must not rely on
localStorage. Never assume Xbox/PlayStation lettering has identical names.

## Agent acceptance checklist

Apply this checklist when controller support is included.

- After any initial browser focus/activation gesture, complete a controller-only
  journey through every existing screen: start, main interaction, pause, settings,
  resume, restart/retry, results/next-level and back/exit. Confirm visible focus,
  access to every setting, and no mouse, touch or keyboard-only traps. Mark absent
  screens as not applicable; report blocked input instead of claiming a pass.
- Verify confirm/back once per press, controlled navigation repeat, and no held
  button leaking across screens or into gameplay behind a menu. Test nested dialogs
  and return focus to a useful control. Merge input sources in one layer; clear
  keyboard/touch state on blur as well as controller state.
- Poll once per animation frame and feed the resulting input into the existing
  simulation. Consume an edge once, even when a frame runs several physics steps.
  Multiplayer sends game actions over the game's transport, not every controller
  sample over Nostr/CVM. Keep local prediction/feedback responsive.
- Exercise drift, analog triggers, held versus pressed buttons, focus/visibility,
  pause/resume, disconnect/reconnect, nonstandard mappings and two distinct slots.
  `read` and `active` options allow deterministic tests without hardware.
- Test in both the workshop's actual napplet frame and the deployed shell. Confirm
  physical USB and Bluetooth operation on intended browsers. Record which devices
  were tested; synthetic snapshots and `soyli check` are not hardware certification.
- Do not add `requires: ['gamepad']`, `serial` or an invented `napplet.gamepad` API.
  Browser policy may restrict native Gamepad input; keep useful fallback controls.
  No WebHID, WebUSB, serial-port support, rumble or controller-driven shell navigation
  is promised by this slice. Feature-detected haptics are a possible later addition.
