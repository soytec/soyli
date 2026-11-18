import { test, expect } from 'bun:test';
import { encodeAddress } from '#src/protocol/events.ts';
import { Rooms } from './rooms.ts';
import { directoryPage } from './directory.ts';
test('only explicit host listings cross games; reads do not renew a lease or reveal peer IDs', () => {
  let now = 50000;
  const rooms = new Rooms(() => now);
  const provider = 'a'.repeat(64),
    napplet = encodeAddress({ kind: 35129, pubkey: '1'.repeat(64), identifier: 'game' });
  const args = { napplet, protocol: 'v1', capacity: 2, name: 'INTERNAL-PEER-KEY' };
  const { room } = rooms.create('host', args);
  rooms.create('other', args);
  expect(rooms.directory(provider, {}).rooms).toHaveLength(0);
  const listing = { title: 'First room', phase: 'lobby', accepting: true, badges: ['One'] };
  expect(() => rooms.advertise('other', { room, listing })).toThrow();
  rooms.advertise('host', { room, listing });
  const page = directoryPage.parse(rooms.directory(provider, {})),
    ref = page.rooms[0].entry;
  expect(page.rooms).toHaveLength(1);
  expect(JSON.stringify(page)).not.toContain('INTERNAL');
  expect(page.rooms[0]).not.toHaveProperty('peers');
  expect(() => rooms.enter('guest', provider, { ...ref, provider: 'b'.repeat(64) })).toThrow();
  expect(() => rooms.enter('guest', provider, { ...ref, protocol: 'v2' })).toThrow();
  now += 10000;
  rooms.enter('guest', provider, ref);
  expect(() => rooms.enter('full', provider, ref)).toThrow('full');
  rooms.advertise('host', { room, listing: null });
  expect(() => rooms.enter('guest', provider, ref)).toThrow();
  rooms.advertise('host', { room, listing: { ...listing, accepting: false } });
  expect(() => rooms.enter('guest', provider, ref)).toThrow('not accepting');
  now += 50001;
  expect(rooms.directory(provider, {}).rooms).toHaveLength(0);
  expect(rooms.access('guest', { room }, false).peers).toEqual(['guest']);
});
