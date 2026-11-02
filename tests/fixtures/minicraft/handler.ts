// Self-contained example backend. Nothing here is built into the provider.
// State values are validated against the adjacent schemas before commit.
type Context = {
  operation: string;
  principal: string;
  account: string | null;
  instance: string;
  release: string;
  owner: string;
  state: {
    get(collection: string, key: string): Promise<any>;
    set(collection: string, key: string, value: unknown): Promise<unknown>;
    access(): Promise<any>;
    setAccess(value: unknown): Promise<unknown>;
    setMember(principal: string, role: string | null): Promise<unknown>;
  };
};
const palette = ['air', 'stone', 'dirt', 'grass', 'wood', 'glass', 'sand', 'water'];
function key(position: { x: number; y: number; z: number }) {
  return `${position.x},${position.y},${position.z}`;
}
async function chunk(ctx: Context, position: { x: number; y: number; z: number }) {
  return (
    (await ctx.state.get('chunks', key(position))) ?? {
      position,
      revision: 0,
      blocks: Array(512).fill(0),
    }
  );
}
async function inventory(ctx: Context) {
  if (!ctx.account) throw new Error('ACCOUNT_REQUIRED: Survival inventory requires an account.');
  return (
    (await ctx.state.get('inventories', ctx.principal)) ?? {
      revision: 0,
      blocks: [64, 64, 64, 64, 64, 64, 64],
    }
  );
}
export async function handle(ctx: Context, input: any): Promise<Record<string, unknown>> {
  if (ctx.operation === 'createWorld') {
    if (
      input.guestsMayBuild &&
      (input.mode !== 'creative' || input.visibility !== 'public' || input.building !== 'everyone')
    )
      throw new Error(
        'BAD_INPUT: Guest building requires a public creative world open to everyone.',
      );
    await ctx.state.setAccess({
      visibility: input.visibility,
      building: input.building,
      guestsMayBuild: input.guestsMayBuild,
      members: {},
    });
    await ctx.state.set('worlds', 'meta', {
      name: input.name,
      seed: input.seed,
      mode: input.mode,
      owner: ctx.principal,
      release: ctx.release,
    });
    if (input.terrain === 'island') {
      // Four bounded chunks form the demo's initial island. Saved once, by the
      // same transaction as creation; clients never synthesize authoritative land.
      for (let cx = 0; cx < 2; cx++)
        for (let cz = 0; cz < 2; cz++) {
          const record = await chunk(ctx, { x: cx, y: 0, z: cz });
          for (let x = 0; x < 8; x++)
            for (let z = 0; z < 8; z++) {
              const wx = cx * 8 + x,
                wz = cz * 8 + z;
              const distance = Math.hypot(wx - 7.5, wz - 7.5);
              const shore = 6.5 + Math.sin(wx * 1.7 + input.seed) * 0.5;
              const height = distance < 3.5 ? 3 : distance < shore ? 2 : 1;
              for (let y = 0; y < height; y++)
                record.blocks[x + 8 * (z + 8 * y)] =
                  y < height - 1 ? 1 : distance < shore - 1 ? 3 : distance < shore ? 6 : 7;
              // A little tree in the corner leaves the central building site clear.
              if (wx === 4 && wz === 4)
                for (let y = height; y < height + 3; y++) record.blocks[x + 8 * (z + 8 * y)] = 4;
              if (Math.abs(wx - 4) <= 1 && Math.abs(wz - 4) <= 1)
                record.blocks[x + 8 * (z + 8 * 5)] = 3;
            }
          record.revision = 1;
          await ctx.state.set('chunks', key(record.position), record);
        }
    }
    return { world: ctx.instance };
  }
  const world = await ctx.state.get('worlds', 'meta');
  if (!world) throw new Error('BAD_INPUT: World metadata is missing.');
  if (ctx.operation === 'readWorld') return world;
  if (ctx.operation === 'readChunks') {
    const chunks = [];
    for (const position of input.positions) chunks.push(await chunk(ctx, position));
    return { chunks };
  }
  if (ctx.operation === 'readMyInventory') return inventory(ctx);
  if (ctx.operation === 'setMember') {
    await ctx.state.setMember(input.principal, input.role === 'remove' ? null : input.role);
    return { changed: true };
  }
  if (!['placeBlock', 'removeBlock'].includes(ctx.operation))
    throw new Error('BAD_INPUT: Unknown game command.');
  const position = {
    x: Math.floor(input.x / 8),
    y: Math.floor(input.y / 8),
    z: Math.floor(input.z / 8),
  };
  const record = await chunk(ctx, position);
  if (record.revision !== input.expectedChunkRevision)
    throw new Error('CONFLICT: Chunk changed. Refresh it before trying again.');
  const offset = (input.x % 8) + 8 * ((input.z % 8) + 8 * (input.y % 8));
  const before = record.blocks[offset];
  const after = ctx.operation === 'placeBlock' ? palette.indexOf(input.block) : 0;
  if (ctx.operation === 'placeBlock' && before !== 0)
    throw new Error('CONFLICT: There is already a block here.');
  if (ctx.operation === 'removeBlock' && before === 0)
    throw new Error('CONFLICT: This cell is already empty.');
  if (world.mode === 'survival') {
    const bag = await inventory(ctx),
      slot = (ctx.operation === 'placeBlock' ? after : before) - 1;
    if (ctx.operation === 'placeBlock' && bag.blocks[slot] <= 0)
      throw new Error('FORBIDDEN: You do not have that block in your inventory.');
    bag.blocks[slot] += ctx.operation === 'placeBlock' ? -1 : 1;
    bag.revision++;
    await ctx.state.set('inventories', ctx.principal, bag);
  }
  record.blocks[offset] = after;
  record.revision++;
  await ctx.state.set('chunks', key(position), record);
  return { chunkRevision: record.revision };
}
