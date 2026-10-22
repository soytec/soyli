# Controllers — native Gamepad input

soyLI 0.16.0 adds a **Controller tester** in the `soyli dev` workshop and a
dependency-free input helper for creators. These are local source changes until
the release is published. Ordinary USB/Bluetooth gamepads use the browser's
[Gamepad API](https://www.w3.org/TR/gamepad/), not NAP-SERIAL. No server, CVM,
account, new NAP domain or `requires` entry is needed. No shim/SDK/protocol pin
changes are involved. Existing games must explicitly wire their actions to input.

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

- Connect named actions to gameplay and essential menus. Always keep keyboard
  and pointer/touch paths appropriate to the device; controller support is optional.
  Merge sources in one input layer. Clear keyboard/touch state on blur as well.
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
