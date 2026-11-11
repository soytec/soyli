import { test, expect } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { testMultiplayer } from '../../src/preview/multiplayer-test.ts';

test('NAP-WEBRTC #145 through the real shared host and injected binding in three independent browsers', async () => {
  const root = await mkdtemp(join(tmpdir(), 'soy-webrtc-realtime-'));
  try {
    await Bun.write(
      join(root, 'napplet.json'),
      JSON.stringify({
        schema: 'space-local-project/v1',
        name: 'Realtime fixture',
        description: '',
        license: 'MIT',
        entry: 'index.html',
        previewId: crypto.randomUUID(),
        requires: ['cvm', 'webrtc'],
        backend: { boards: [] },
      }),
    );
    await Bun.write(
      join(root, 'index.html'),
      '<!doctype html><body>Isolated WebRTC acceptance</body>',
    );
    await Bun.write(
      join(root, 'scenario.mjs'),
      await Bun.file(new URL('./webrtc-realtime-scenario.mjs', import.meta.url)).text(),
    );
    const result = await testMultiplayer(root, 'scenario.mjs', {
      players: 3,
      timeoutMs: 120000,
      ...(process.env.SPACE_TEST_TURN_BINARY
        ? { turnBinary: process.env.SPACE_TEST_TURN_BINARY }
        : {}),
    });
    expect(result.status, JSON.stringify(result, null, 2)).toBe('passed');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}, 140000);
