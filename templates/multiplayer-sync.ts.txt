/** Application-side examples. Adapt to your physics and validate peer messages before calling. */
export function inputPrediction<State, Input>(initial: State, step: (state: State, input: Input) => State, limit = 120) {
  let state = structuredClone(initial), sequence = 0, acknowledged = 0, tick = -1;
  let pending: { sequence: number; input: Input }[] = [];
  return {
    state: () => structuredClone(state),
    advance(input: Input) {
      if (pending.length >= limit) throw new Error('Prediction backlog full; request a fresh state and resynchronize.');
      const entry = { sequence: ++sequence, input: structuredClone(input) };
      pending.push(entry);
      state = step(structuredClone(state), structuredClone(input));
      return structuredClone(entry);
    },
    reconcile(snapshot: { tick: number; acknowledged: number; state: State }) {
      if (!Number.isSafeInteger(snapshot.tick) || snapshot.tick <= tick ||
          !Number.isSafeInteger(snapshot.acknowledged) || snapshot.acknowledged < acknowledged ||
          snapshot.acknowledged > sequence) return false;
      tick = snapshot.tick; acknowledged = snapshot.acknowledged;
      pending = pending.filter(entry => entry.sequence > acknowledged);
      state = structuredClone(snapshot.state);
      for (const entry of pending) state = step(structuredClone(state), structuredClone(entry.input));
      return true;
    },
  };
}

/** Use host simulation ticks, not wall clocks from different machines. No extrapolation by default. */
export function snapshotBuffer<State>(interpolate: (a: State, b: State, fraction: number) => State, limit = 32) {
  const frames: { tick: number; state: State }[] = [];
  return {
    push(tick: number, state: State) {
      if (!Number.isFinite(tick) || tick < 0 || tick <= (frames.at(-1)?.tick ?? -1)) return false;
      frames.push({ tick, state: structuredClone(state) });
      if (frames.length > limit) frames.shift();
      return true;
    },
    sample(renderTick: number): State | undefined {
      if (!frames.length || !Number.isFinite(renderTick)) return undefined;
      for (let i = 1; i < frames.length; i++) {
        const a = frames[i - 1], b = frames[i];
        if (renderTick <= b.tick) return interpolate(structuredClone(a.state), structuredClone(b.state),
          Math.max(0, Math.min(1, (renderTick - a.tick) / (b.tick - a.tick))));
      }
      return structuredClone(frames.at(-1)!.state);
    },
  };
}
