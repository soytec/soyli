import { expect, test } from 'bun:test';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { inspectWasm } from '../rust-build';
import { checkSource, inspectProject } from '../../packages/publish/src/project';
const cli = process.env.SPACE_TEST_CLI
  ? [process.env.SPACE_TEST_CLI]
  : [process.execPath, new URL('../index.ts', import.meta.url).pathname];
const recipe = { kind: 'rust', crate: 'fixture', toolchain: '1.97.1', bindgen: '0.2.125' };
const bounded = Buffer.from('0061736d0100000005050101018020', 'hex');

test('WASM profile accepts bounded memory and refuses malformed, shared, missing and unbounded memories', () => {
  expect(inspectWasm(bounded)).toEqual({ maximumMemoryBytes: 268435456 });
  for (const hex of [
    '0061736d01000000',
    '0061736d010000000503010001',
    '0061736d0100000005050103018020',
    '0061736d0100000005050101018040',
    'ff',
  ])
    expect(() => inspectWasm(Buffer.from(hex, 'hex'))).toThrow();
  expect(() => checkSource('target/wasm32-unknown-unknown/release/game.wasm', bounded)).toThrow(
    'build caches',
  );
});

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'soy-rust-'));
  const config = {
    schema: 'space-local-project/v1',
    name: 'Rust fixture',
    entry: 'dist/index.html',
    previewId: crypto.randomUUID(),
    license: 'MIT',
    build: recipe,
  };
  await Bun.write(join(root, 'napplet.json'), JSON.stringify(config));
  await Bun.write(join(root, 'Cargo.toml'), '[package]\nname="fixture"\nversion="0.1.0"\n');
  await Bun.write(
    join(root, 'rust-toolchain.toml'),
    '[toolchain]\nchannel="1.97.1"\ntargets=["wasm32-unknown-unknown"]\n',
  );
  await Bun.write(
    join(root, 'Cargo.lock'),
    'version=4\n[[package]]\nname="wasm-bindgen"\nversion="0.2.125"\n',
  );
  await Bun.write(join(root, 'index.html'), '<canvas></canvas><!-- soyli:wasm -->');
  const bin = join(root, 'bin'),
    cache = join(root, 'cache');
  await mkdir(bin);
  await mkdir(join(root, 'lib'));
  await Bun.write(
    join(cache, 'wasm-bindgen-0.2.125/bin/wasm-bindgen'),
    '#!/bin/sh\nprintf "wasm-bindgen 0.2.125\\n"\n',
  );
  await Bun.$`chmod +x ${join(cache, 'wasm-bindgen-0.2.125/bin/wasm-bindgen')}`.quiet();
  const run = async (command = 'build') => {
    const child = Bun.spawn([...cli, command, '--project', root, '--json'], {
      env: {
        ...process.env,
        PATH: `${bin}:/usr/bin:/bin`,
        SPACE_TOOLCHAIN_CACHE: cache,
        SOYLI_RELEASE_API: 'http://127.0.0.1:1/fixture',
        PLAYWRIGHT_BROWSERS_PATH: join(root, 'no-browser'),
      },
      stdout: 'pipe',
      stderr: 'pipe',
    });
    const [code, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    return { code, stdout, stderr };
  };
  return { root, config, bin, cache, run };
}

test('real CLI reports lock mismatch without installing tools or running a compiler', async () => {
  const f = await fixture();
  try {
    await Bun.write(
      join(f.root, 'Cargo.lock'),
      'version=4\n[[package]]\nname="wasm-bindgen"\nversion="0.2.100"\n',
    );
    const result = await f.run();
    expect(result.code).toBe(1);
    expect(result.stdout + result.stderr).toContain('WASM_BINDGEN_VERSION');
    expect(result.stdout + result.stderr).toContain('Cargo.lock');
    expect(result.stdout + result.stderr).toContain('soyli setup');
    const doctor = await f.run('doctor');
    expect(doctor.code, doctor.stdout + doctor.stderr).toBe(0);
    expect(JSON.parse(doctor.stdout).rust).toContain('WASM_BINDGEN_VERSION');
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});

test('Rust source archives require actual nonempty pins even when a missing file was selected', async () => {
  const f = await fixture();
  try {
    await Bun.write(join(f.root, 'LICENSE'), 'MIT');
    await Bun.write(join(f.root, 'dist/index.html'), '<p>Built fixture</p>');
    const inspected = await inspectProject(f.root, 'local', '0'.repeat(64));
    expect(inspected.contents.has('Cargo.lock')).toBe(true);
    await rm(join(f.root, 'Cargo.lock'));
    await expect(inspectProject(f.root, 'local', '0'.repeat(64))).rejects.toThrow(
      'nonempty Cargo.toml, Cargo.lock',
    );
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});

test('real CLI preserves compiler cause/status and redacts secrets while keeping the last build', async () => {
  const f = await fixture();
  try {
    await Bun.write(
      join(f.bin, 'rustup'),
      `#!/bin/sh
if [ "$3" = rustc ]; then
  if [ "$4" = --version ]; then echo 'rustc 1.97.1 (fixture)'; else printf '%s/lib\\n' "$PWD"; fi
  exit 0
fi
echo 'error[E0308]: expected u32, found String' >&2
echo 'token=not-for-the-log' >&2
exit 17
`,
    );
    await Bun.$`chmod +x ${join(f.bin, 'rustup')}`.quiet();
    await Bun.write(join(f.root, 'dist/index.html'), 'last good build');
    const result = await f.run();
    expect(result.code).toBe(1);
    const output = result.stdout + result.stderr;
    expect(output).toContain('error[E0308]');
    expect(output).toContain('Exit status: 17');
    expect(output).not.toContain('not-for-the-log');
    expect(await Bun.file(join(f.root, 'dist/index.html')).text()).toBe('last good build');
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});

test('real CLI retains safe stdout when a captured toolchain probe fails', async () => {
  const f = await fixture();
  try {
    await Bun.write(
      join(f.bin, 'rustup'),
      '#!/bin/sh\necho "compiler installation damaged"\necho "token=keep-this-private"\nexit 29\n',
    );
    await Bun.$`chmod +x ${join(f.bin, 'rustup')}`.quiet();
    const result = await f.run();
    expect(result.code).toBe(1);
    expect(result.stdout + result.stderr).toContain('compiler installation damaged');
    expect(result.stdout + result.stderr).toContain('Exit status: 29');
    expect(result.stdout + result.stderr).not.toContain('keep-this-private');
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});

test('custom build arguments are literal, and command errors reach the real CLI', async () => {
  const f = await fixture();
  try {
    await Bun.write(
      join(f.root, 'napplet.json'),
      JSON.stringify({
        ...f.config,
        build: {
          kind: 'command',
          command: [process.execPath, 'builder.ts', '$(touch should-not-exist)'],
        },
      }),
    );
    await Bun.write(
      join(f.root, 'builder.ts'),
      `await Bun.write('dist/index.html', '<p>'+process.argv[2]+'</p>');`,
    );
    let result = await f.run();
    expect(result.code, result.stderr).toBe(0);
    expect(await Bun.file(join(f.root, 'dist/index.html')).text()).toContain(
      '$(touch should-not-exist)',
    );
    expect(await Bun.file(join(f.root, 'should-not-exist')).exists()).toBe(false);
    await Bun.write(
      join(f.root, 'builder.ts'),
      `console.error('shader compiler: missing material');process.exit(23);`,
    );
    result = await f.run();
    expect(result.code).toBe(1);
    expect(result.stdout + result.stderr).toContain('missing material');
    expect(result.stdout + result.stderr).toContain('Exit status: 23');
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});

test('custom dev rebuilds, retries after errors and cancels its active compiler on exit', async () => {
  const f = await fixture();
  let child: ReturnType<typeof Bun.spawn> | undefined;
  let output = '',
    errors = '';
  const until = async (condition: () => Promise<boolean>) => {
    for (let i = 0; i < 150; i++) {
      if (await condition()) return;
      await Bun.sleep(50);
    }
    throw new Error('Preview condition timed out: ' + errors.slice(-1500));
  };
  try {
    await Bun.write(join(f.root, 'source.txt'), 'first');
    await Bun.write(
      join(f.root, 'napplet.json'),
      JSON.stringify({
        ...f.config,
        build: {
          kind: 'command',
          command: [process.execPath, 'builder.ts'],
          watch: ['source.txt', 'builder.ts'],
        },
      }),
    );
    await Bun.write(
      join(f.root, 'builder.ts'),
      `
      const source=await Bun.file('source.txt').text();
      if(source==='bad'){console.error('invalid shader on line 9');process.exit(19);}
      if(source==='slow'){await Bun.write('.napplet-space/compiler.pid',String(process.pid));setInterval(()=>{},1000);await new Promise(()=>{});}
      await Bun.write('dist/index.html','<p>'+source+'</p>');
    `,
    );
    child = Bun.spawn([...cli, 'dev', '--project', f.root, '--no-open', '--port', '0', '--json'], {
      env: process.env,
      stdout: 'pipe',
      stderr: 'pipe',
      stdin: 'ignore',
    });
    const drain = async (stream: ReadableStream<Uint8Array>, error: boolean) => {
      for await (const bytes of stream) {
        if (error) errors += new TextDecoder().decode(bytes);
        else output += new TextDecoder().decode(bytes);
      }
    };
    const drained = Promise.all([
      drain(child.stdout as ReadableStream<Uint8Array>, false),
      drain(child.stderr as ReadableStream<Uint8Array>, true),
    ]);
    await until(async () => /"url":/.test(output));
    const url = JSON.parse(
      output
        .trim()
        .split('\n')
        .find((l) => l.includes('"url":'))!,
    ).url;
    await Bun.write(join(f.root, 'source.txt'), 'second');
    await until(async () =>
      (await Bun.file(join(f.root, 'dist/index.html')).text()).includes('second'),
    );
    await Bun.write(join(f.root, 'source.txt'), 'bad');
    await until(async () => errors.includes('invalid shader on line 9'));
    expect(await Bun.file(join(f.root, 'dist/index.html')).text()).toBe('<p>second</p>');
    await Bun.write(join(f.root, 'source.txt'), 'fixed');
    await until(async () =>
      (await Bun.file(join(f.root, 'dist/index.html')).text()).includes('fixed'),
    );
    await Bun.write(join(f.root, 'source.txt'), 'slow');
    await until(async () => Bun.file(join(f.root, '.napplet-space/compiler.pid')).exists());
    const pid = Number(await Bun.file(join(f.root, '.napplet-space/compiler.pid')).text());
    child.kill('SIGHUP');
    await child.exited;
    await drained;
    await until(async () => {
      try {
        process.kill(pid, 0);
        return false;
      } catch {
        return true;
      }
    });
    expect(
      await fetch(url).then(
        () => true,
        () => false,
      ),
    ).toBe(false);
  } finally {
    child?.kill();
    await child?.exited;
    await rm(f.root, { recursive: true, force: true });
  }
}, 30000);
