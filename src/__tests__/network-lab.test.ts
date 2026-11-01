import { expect, test } from 'bun:test';
import { networkConditions } from '../network-lab';

test('network conditions reject non-finite latency', () => {
  expect(networkConditions.safeParse({ latencyMs: NaN }).success).toBe(false);
});
