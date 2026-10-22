/** Native browser input. No NAP domain, host messages, network or storage required. */
export type GamepadBinding = { button: number; scale?: 1 | -1 } | { axis: number; scale?: 1 | -1 };
export type GamepadBindings = Record<string, readonly GamepadBinding[]>;
export type GamepadAction = { value: number; down: boolean; pressed: boolean; released: boolean };
export type Controller = {
  index: number;
  id: string;
  mapping: string;
  mapped: boolean;
  axes: number[];
  buttons: number[];
  actions: Record<string, GamepadAction>;
};
export type ControllerFrame = {
  status: 'ready' | 'waiting' | 'inactive' | 'unavailable' | 'blocked' | 'closed';
  players: Controller[];
  connected: number[];
  disconnected: number[];
};
export type GamepadSample = Pick<
  Gamepad,
  'index' | 'id' | 'mapping' | 'connected' | 'axes' | 'buttons'
>;

/** Standard layout positions, not vendor-specific button lettering. Adapt action names to the game. */
export const standardGamepadBindings: GamepadBindings = {
  moveX: [{ axis: 0 }, { button: 14, scale: -1 }, { button: 15 }],
  moveY: [{ axis: 1 }, { button: 12, scale: -1 }, { button: 13 }],
  aimX: [{ axis: 2 }],
  aimY: [{ axis: 3 }],
  jump: [{ button: 0 }],
  fire: [{ button: 7 }],
  pause: [{ button: 9 }],
};

function checkedBindings(bindings: GamepadBindings): GamepadBindings {
  const copy: GamepadBindings = Object.create(null);
  for (const [name, sources] of Object.entries(bindings)) {
    copy[name] = sources.map((source) => {
      const index = 'button' in source ? source.button : source.axis;
      if (
        !Number.isInteger(index) ||
        index < 0 ||
        (source.scale !== undefined && ![1, -1].includes(source.scale))
      )
        throw new Error(
          'Controller bindings need nonnegative integer indices and a scale of 1 or -1.',
        );
      return { ...source };
    });
  }
  return copy;
}
const finite = (value: number, min = -1) =>
  Number.isFinite(value) ? Math.max(min, Math.min(1, value)) : 0;

/** Poll once per game animation frame. Keep one instance per running napplet; dispose on teardown. */
export function createGamepadInput(
  bindings: GamepadBindings = standardGamepadBindings,
  options: {
    deadZone?: number;
    buttonThreshold?: number;
    /** Dependency injection for deterministic game tests; defaults to the native browser API. */
    read?: () => ArrayLike<GamepadSample | null>;
    active?: () => boolean;
  } = {},
) {
  const defaults = checkedBindings(bindings);
  const deadZone = options.deadZone ?? 0.18,
    threshold = options.buttonThreshold ?? 0.5;
  if (
    !Number.isFinite(deadZone) ||
    deadZone < 0 ||
    deadZone >= 1 ||
    !Number.isFinite(threshold) ||
    threshold <= 0 ||
    threshold > 1
  )
    throw new Error(
      'Use a dead zone from 0 up to (excluding) 1 and a button threshold above 0 through 1.',
    );
  let previous = new Map<number, Controller>(),
    activeLast = false,
    closed = false;
  const overrides = new Map<number, { id: string; bindings: GamepadBindings }>();
  const reset = () => {
    activeLast = false;
  };
  const browserWindow = typeof window !== 'undefined' ? window : undefined;
  browserWindow?.addEventListener('blur', reset);
  browserWindow?.document.addEventListener('visibilitychange', reset);
  const active =
    options.active ??
    (() => !!browserWindow && !browserWindow.document.hidden && browserWindow.document.hasFocus());
  const read =
    options.read ??
    (() => {
      if (typeof navigator === 'undefined' || !navigator.getGamepads)
        throw new Error('Gamepad API unavailable');
      return navigator.getGamepads();
    });
  function empty(status: ControllerFrame['status']): ControllerFrame {
    const disconnected = [...previous.keys()];
    previous.clear();
    overrides.clear();
    activeLast = false;
    return { status, players: [], connected: [], disconnected };
  }
  return {
    poll(): ControllerFrame {
      if (closed) return empty('closed');
      let samples: GamepadSample[];
      try {
        samples = Array.from(read()).filter((pad): pad is GamepadSample => !!pad?.connected);
      } catch (error) {
        return empty(
          error instanceof Error && error.name === 'SecurityError' ? 'blocked' : 'unavailable',
        );
      }
      const enabled = active(),
        next = new Map<number, Controller>();
      const connected: number[] = [],
        disconnected: number[] = [];
      for (const pad of samples) {
        const old = previous.get(pad.index),
          same = old?.id === pad.id && old.mapping === pad.mapping;
        if (!same) {
          connected.push(pad.index);
          overrides.delete(pad.index);
        }
        const override = overrides.get(pad.index);
        const mapped = pad.mapping === 'standard' || override?.id === pad.id;
        const layout = override?.bindings ?? defaults;
        const axes = pad.axes.map((v) => (enabled ? finite(v) : 0));
        const buttons = pad.buttons.map((b) => (enabled ? finite(b.value, 0) : 0));
        const actions: Record<string, GamepadAction> = Object.create(null);
        for (const [name, sources] of Object.entries(layout)) {
          let positive = 0,
            negative = 0;
          if (enabled && mapped)
            for (const source of sources) {
              let input =
                'button' in source ? (buttons[source.button] ?? 0) : (axes[source.axis] ?? 0);
              if ('axis' in source)
                input =
                  Math.sign(input) * Math.max(0, (Math.abs(input) - deadZone) / (1 - deadZone));
              input *= source.scale ?? 1;
              positive = Math.max(positive, input);
              negative = Math.min(negative, input);
            }
          const value = positive === -negative ? 0 : positive > -negative ? positive : negative;
          const down = Math.abs(value) >= threshold,
            wasDown = same && !!old.actions[name]?.down;
          actions[name] = {
            value,
            down,
            pressed: enabled && activeLast && same && down && !wasDown,
            released: wasDown && !down,
          };
        }
        next.set(pad.index, {
          index: pad.index,
          id: pad.id,
          mapping: pad.mapping,
          mapped,
          axes,
          buttons,
          actions,
        });
      }
      for (const [index, old] of previous) {
        const current = next.get(index);
        if (!current || current.id !== old.id || current.mapping !== old.mapping) {
          disconnected.push(index);
          if (!current) overrides.delete(index);
        }
      }
      previous = next;
      activeLast = enabled;
      // Return detached snapshots: a game's mutations cannot corrupt later button edges.
      return {
        status: enabled ? (next.size ? 'ready' : 'waiting') : 'inactive',
        players: structuredClone([...next.values()]),
        connected,
        disconnected,
      };
    },
    /** Explicit mapping for this connected slot. Forgotten on disconnect/replacement; never guessed by vendor ID. */
    remap(index: number, layout: GamepadBindings) {
      const pad = previous.get(index);
      if (!pad || closed) throw new Error('Connect and poll this controller before mapping it.');
      overrides.set(index, { id: pad.id, bindings: checkedBindings(layout) });
      activeLast = false;
    },
    reset,
    dispose() {
      closed = true;
      empty('closed');
      browserWindow?.removeEventListener('blur', reset);
      browserWindow?.document.removeEventListener('visibilitychange', reset);
    },
  };
}
