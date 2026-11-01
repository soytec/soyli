import { test, expect } from 'bun:test';
import { multiplayerOptions } from '../multiplayer';

test('multiplayer CLI bounds resource use and rejects invalid conditions', () => {
  expect(multiplayerOptions.parse({})).toMatchObject({
    players: 2,
    latencyMs: 0,
    timeoutMs: 60000,
  });
  for (const input of [
    { players: 9 },
    { latencyMs: -1 },
    { jitterMs: 501 },
    { timeoutMs: 300001 },
    { seed: 0 },
  ])
    expect(multiplayerOptions.safeParse(input).success).toBe(false);
});
