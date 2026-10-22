import { test, expect, afterAll } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { creatorSkills } from '../creator-kit';
import { multiplayerOptions } from '../multiplayer';
import { networkConditions } from '../network-lab';

const example = creatorSkills()['docs/examples/multiplayer-sync.ts'];
const directory = await mkdtemp(join(tmpdir(), 'soy-sync-example-'));
afterAll(() => rm(directory, { recursive: true, force: true }));
await Bun.write(join(directory, 'sync.ts'), example);
const { inputPrediction, snapshotBuffer } = await import(
  pathToFileURL(join(directory, 'sync.ts')).href
);

test('shipped prediction replays only unacknowledged inputs over corrected authority and rejects stale snapshots', () => {
  const prediction = inputPrediction(
    { x: 0 },
    (state: { x: number }, dx: number) => ({ x: state.x + dx }),
    3,
  );
  expect(prediction.advance(2)).toEqual({ sequence: 1, input: 2 });
  prediction.advance(2);
  prediction.advance(2);
  expect(prediction.state()).toEqual({ x: 6 });
  expect(() => prediction.advance(2)).toThrow('backlog');
  expect(prediction.reconcile({ tick: 10, acknowledged: 2, state: { x: 3 } })).toBe(true);
  expect(prediction.state()).toEqual({ x: 5 });
  expect(prediction.reconcile({ tick: 9, acknowledged: 3, state: { x: 99 } })).toBe(false);
  expect(prediction.reconcile({ tick: 11, acknowledged: 4, state: { x: 99 } })).toBe(false);
  expect(prediction.state()).toEqual({ x: 5 });
  const leaked = prediction.state();
  leaked.x = 999;
  expect(prediction.state()).toEqual({ x: 5 });
});

test('shipped interpolation renders between snapshots and bounds missing/stale data', () => {
  const buffer = snapshotBuffer((a: number, b: number, t: number) => a + (b - a) * t, 2);
  expect(buffer.sample(0)).toBeUndefined();
  buffer.push(0, 0);
  buffer.push(3, 30);
  expect(buffer.sample(1)).toBe(10);
  expect(buffer.sample(2)).toBe(20);
  expect(buffer.push(2, 999)).toBe(false);
  expect(buffer.sample(100)).toBe(30);
  buffer.push(6, 60);
  expect(buffer.sample(-1)).toBe(30);
});

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
  expect(networkConditions.safeParse({ latencyMs: NaN }).success).toBe(false);
});
