import { test, expect } from 'bun:test';
import { decodeWebrtcBytes, encodeWebrtcBytes, encodeWebrtcJson } from './webrtc-payload.ts';

test('binary uses canonical padded RFC4648 including empty bytes and rejects ambiguous encodings', () => {
  for (const text of ['', 'AA==', '/+8=', 'AAAA'])
    expect(encodeWebrtcBytes(decodeWebrtcBytes(text).buffer)).toBe(text);
  for (const text of [
    'A',
    'AA',
    'AA=',
    'AB==',
    'AAB=',
    ' AA==',
    'AA==\n',
    '_w==',
    'data:AA==',
    3,
    null,
  ])
    expect(() => decodeWebrtcBytes(text)).toThrow();
  expect(decodeWebrtcBytes(btoa('x'.repeat(16384)))).toHaveLength(16384);
  expect(() => decodeWebrtcBytes(btoa('x'.repeat(16385)))).toThrow();
  expect(encodeWebrtcJson('😀').bytes).toBe(6);
  expect(() => encodeWebrtcJson('😀'.repeat(4096))).toThrow('payload too large');
  expect(() => encodeWebrtcJson(undefined)).toThrow('JSON');
});
