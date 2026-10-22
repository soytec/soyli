import { lstat, mkdir, rename, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { DiagnosticError, diagnose, formatDiagnostic } from '../packages/diagnostics/src';
import { projectSchema, type Build } from '../packages/publish/src/config';
import { regularFile } from '../packages/publish/src/project';
import { builtConfiguration } from '../packages/publish/src/artifact';
import { MAX_ARTIFACT_BYTES } from '../packages/protocol/src';
import { validateConfigSchema } from '../packages/runtime/src/config-schema';
import { projectEnvironment, runProjectCommand } from './project-process';

type RustBuild = Extract<Build, { kind: 'rust' }>;
const TARGET = 'wasm32-unknown-unknown';
const MEMORY_BYTES = 256 * 1024 * 1024;
const MAX_MODULE_BYTES = 32 * 1024 * 1024;
const MARKER = '<!-- soyli:wasm -->';
const env = () => ({
  ...projectEnvironment(),
  PATH: process.env.PATH || '/usr/bin:/bin',
  ...(process.env.CARGO_HOME ? { CARGO_HOME: process.env.CARGO_HOME } : {}),
  ...(process.env.RUSTUP_HOME ? { RUSTUP_HOME: process.env.RUSTUP_HOME } : {}),
});
const fail = (code: string, message: string, recovery: string, cause?: unknown) =>
  new DiagnosticError(code, message, { operation: 'build Rust/WASM napplet', recovery, cause });
const rustup = () => Bun.which('rustup') ?? join(homedir(), '.cargo/bin/rustup');
const bindgenPath = (recipe: RustBuild) =>
  join(
    resolve(
      process.env.SPACE_TOOLCHAIN_CACHE ||
        join(
          process.env.XDG_CACHE_HOME ||
            (process.platform === 'darwin'
              ? join(homedir(), 'Library/Caches')
              : join(homedir(), '.cache')),
          'napplet-space/toolchains',
        ),
    ),
    `wasm-bindgen-${recipe.bindgen}`,
    'bin/wasm-bindgen',
  );

export async function readBuildRecipe(directory: string): Promise<Build | undefined> {
  const file = Bun.file(join(directory, 'napplet.json'));
  if (!(await file.exists())) return undefined;
  const project = projectSchema.parse(await file.json());
  if (project.build && project.entry !== 'dist/index.html')
    throw fail(
      'BUILD_CONFIG',
      'A build recipe requires entry: dist/index.html.',
      'Update napplet.json or remove its build recipe.',
    );
  return project.build;
}

async function rustFiles(directory: string, recipe: RustBuild) {
  let pin;
  try {
    pin = Bun.TOML.parse(
      new TextDecoder().decode(await regularFile(directory, 'rust-toolchain.toml', 16384)),
    ) as any;
  } catch (cause) {
    throw fail(
      'RUST_TOOLCHAIN',
      'A pinned rust-toolchain.toml is required.',
      `Add [toolchain] with channel = "${recipe.toolchain}" and targets = ["${TARGET}"].`,
      cause,
    );
  }
  if (pin.toolchain?.channel !== recipe.toolchain || !pin.toolchain?.targets?.includes(TARGET))
    throw fail(
      'RUST_TOOLCHAIN',
      'Rust toolchain pins disagree or the WASM target is missing.',
      'Keep rust-toolchain.toml and napplet.json build.toolchain in sync; declare wasm32-unknown-unknown.',
    );
  await regularFile(directory, 'Cargo.toml', 65536);
}
async function checkLock(directory: string, recipe: RustBuild) {
  let lock;
  try {
    lock = Bun.TOML.parse(
      new TextDecoder().decode(await regularFile(directory, 'Cargo.lock', 1024 * 1024)),
    ) as any;
  } catch (cause) {
    throw fail(
      'RUST_LOCK',
      'Cargo.lock is required for a reproducible build.',
      'Run soyli setup and commit Cargo.lock.',
      cause,
    );
  }
  const versions = (lock.package ?? [])
    .filter((p: any) => p.name === 'wasm-bindgen')
    .map((p: any) => p.version);
  if (versions.length !== 1 || versions[0] !== recipe.bindgen)
    throw fail(
      'WASM_BINDGEN_VERSION',
      'Cargo.lock and the configured wasm-bindgen CLI must use exactly the same version.',
      `Pin wasm-bindgen = "=${recipe.bindgen}" in Cargo.toml, update Cargo.lock deliberately, then run soyli setup.`,
    );
}
async function rustCommand(
  directory: string,
  recipe: RustBuild,
  args: string[],
  signal?: AbortSignal,
  capture = false,
) {
  return runProjectCommand(
    [rustup(), 'run', recipe.toolchain, ...args],
    directory,
    {
      ...env(),
      CARGO_TARGET_DIR: join(directory, '.napplet-space/wasm-target'),
      ...(args.includes('build') && args.includes('--target')
        ? { RUSTFLAGS: `-C link-arg=--max-memory=${MEMORY_BYTES}` }
        : {}),
    },
    signal,
    capture,
    'run pinned Rust toolchain',
    1200000,
  );
}

/** Explicit setup may install the selected Rust toolchain and a private bindgen CLI. */
export async function setupRust(directory: string, recipe: RustBuild, signal?: AbortSignal) {
  directory = resolve(directory);
  await rustFiles(directory, recipe);
  if (!Bun.which('rustup') && !(await Bun.file(rustup()).exists()))
    throw fail(
      'RUST_REQUIRED',
      'Rustup is not installed.',
      'Install Rust from https://rustup.rs, then run soyli setup. Rust is only needed by creators building Rust projects.',
    );
  await runProjectCommand(
    [
      rustup(),
      'toolchain',
      'install',
      recipe.toolchain,
      '--profile',
      'minimal',
      '--target',
      TARGET,
      '--no-self-update',
    ],
    directory,
    env(),
    signal,
    false,
    'prepare pinned Rust toolchain',
    1200000,
  );
  if (!(await Bun.file(join(directory, 'Cargo.lock')).exists()))
    await rustCommand(directory, recipe, ['cargo', 'generate-lockfile'], signal);
  await checkLock(directory, recipe);
  const binary = bindgenPath(recipe);
  if (!(await Bun.file(binary).exists())) {
    console.error(
      `Preparing wasm-bindgen ${recipe.bindgen} (cached; first setup can take several minutes)…`,
    );
    await rustCommand(
      directory,
      recipe,
      [
        'cargo',
        'install',
        'wasm-bindgen-cli',
        '--version',
        recipe.bindgen,
        '--locked',
        '--root',
        resolve(binary, '../..'),
      ],
      signal,
    );
  }
  await checkRustTools(directory, recipe, signal);
}

async function checkRustTools(directory: string, recipe: RustBuild, signal?: AbortSignal) {
  try {
    const compiler = await rustCommand(directory, recipe, ['rustc', '--version'], signal, true);
    if (!compiler.startsWith(`rustc ${recipe.toolchain} `))
      throw new Error('Unexpected Rust compiler version.');
    const libdir = (
      await rustCommand(
        directory,
        recipe,
        ['rustc', '--target', TARGET, '--print', 'target-libdir'],
        signal,
        true,
      )
    ).trim();
    if (!(await lstat(libdir).catch(() => null))?.isDirectory())
      throw new Error('wasm32-unknown-unknown standard library is missing.');
    const version = (
      await runProjectCommand(
        [bindgenPath(recipe), '--version'],
        directory,
        env(),
        signal,
        true,
        'check wasm-bindgen version',
      )
    ).trim();
    if (version !== `wasm-bindgen ${recipe.bindgen}`)
      throw new Error('Unexpected wasm-bindgen CLI version.');
  } catch (cause) {
    if (signal?.aborted) throw cause;
    throw fail(
      'RUST_SETUP',
      'The pinned Rust/WASM tools are not ready.',
      'Run soyli setup in this project, then retry the build.',
      cause,
    );
  }
}

export async function rustToolchainStatus(directory: string, signal?: AbortSignal) {
  const recipe = await readBuildRecipe(directory);
  if (recipe?.kind !== 'rust') return undefined;
  try {
    await rustFiles(directory, recipe);
    await checkLock(directory, recipe);
    await checkRustTools(directory, recipe, signal);
    return `ready: Rust ${recipe.toolchain}, ${TARGET}, wasm-bindgen ${recipe.bindgen}`;
  } catch (error) {
    return formatDiagnostic(diagnose(error, 'check Rust toolchain'));
  }
}

/** The first profile deliberately refuses imported/shared/memory64 or unbounded memories. */
export function inspectWasm(bytes: Uint8Array) {
  if (!WebAssembly.validate(bytes))
    throw fail(
      'WASM_INVALID',
      'The generated WebAssembly module is invalid.',
      'Check compiler/linker output and use wasm32-unknown-unknown.',
    );
  let offset = 8;
  const leb = () => {
    let value = 0,
      shift = 0,
      byte;
    do {
      byte = bytes[offset++];
      value += (byte & 127) * 2 ** shift;
      shift += 7;
      if (shift > 35) throw new Error('Invalid WASM integer');
    } while (byte & 128);
    return value;
  };
  let memories = 0,
    maximum = 0;
  while (offset < bytes.length) {
    const section = bytes[offset++],
      size = leb(),
      end = offset + size;
    if (section === 5) {
      memories = leb();
      for (let i = 0; i < memories; i++) {
        const flags = leb(),
          minimum = leb();
        if (flags !== 1)
          throw fail(
            'WASM_MEMORY',
            'WASM memory must be bounded, 32-bit and unshared.',
            'Disable threads/atomics and use the soyLI Rust build or a linker maximum of 256 MiB.',
          );
        maximum = leb();
        if (minimum > maximum || maximum * 65536 > MEMORY_BYTES)
          throw fail(
            'WASM_MEMORY',
            'WASM memory exceeds the 256 MiB build profile.',
            'Reduce the initial/maximum memory requirement.',
          );
      }
    }
    offset = end;
  }
  if (
    memories !== 1 ||
    WebAssembly.Module.imports(new WebAssembly.Module(new Uint8Array(bytes))).some(
      (i) => i.kind === 'memory',
    )
  )
    throw fail(
      'WASM_MEMORY',
      'Expected one module-owned WASM memory.',
      'Imported/shared memories and multiple memories are outside the initial profile.',
    );
  return { maximumMemoryBytes: maximum * 65536 };
}

export async function buildWithRecipe(directory: string, recipe: Build, signal?: AbortSignal) {
  directory = resolve(directory);
  if (recipe.kind === 'command') {
    await runProjectCommand(
      recipe.command,
      directory,
      env(),
      signal,
      false,
      'build napplet with custom recipe',
      recipe.timeoutSeconds * 1000,
    );
    await regularFile(directory, 'dist/index.html', MAX_ARTIFACT_BYTES);
    return;
  }
  const started = performance.now();
  await rustFiles(directory, recipe);
  await checkLock(directory, recipe);
  await checkRustTools(directory, recipe, signal);
  const template = new TextDecoder('utf-8', { fatal: true }).decode(
    await regularFile(directory, 'index.html', MAX_ARTIFACT_BYTES),
  );
  if (template.split(MARKER).length !== 2)
    throw fail(
      'WASM_TEMPLATE',
      `index.html must contain exactly one ${MARKER} insertion point.`,
      'Put the marker after your canvas/loading UI inside the body. The build replaces it with embedded code.',
    );
  const stage = join(directory, '.napplet-space', `wasm-${crypto.randomUUID()}`);
  await mkdir(stage, { recursive: true });
  try {
    await rustCommand(
      directory,
      recipe,
      [
        'cargo',
        'build',
        '--locked',
        '--target',
        TARGET,
        '--profile',
        recipe.profile,
        ...(recipe.target === 'lib' ? ['--lib'] : ['--bin', recipe.crate]),
        ...(!recipe.defaultFeatures ? ['--no-default-features'] : []),
        ...(recipe.features.length ? ['--features', recipe.features.join(',')] : []),
      ],
      signal,
    );
    const compiled = join(
      directory,
      '.napplet-space/wasm-target',
      TARGET,
      recipe.profile === 'dev' ? 'debug' : recipe.profile,
      `${recipe.target === 'lib' ? recipe.crate.replaceAll('-', '_') : recipe.crate}.wasm`,
    );
    await runProjectCommand(
      [
        bindgenPath(recipe),
        compiled,
        '--target',
        'web',
        '--out-dir',
        stage,
        '--out-name',
        'napplet',
        '--no-typescript',
      ],
      directory,
      env(),
      signal,
      false,
      'generate wasm-bindgen browser bindings',
    );
    const wasmFile = Bun.file(join(stage, 'napplet_bg.wasm'));
    if (wasmFile.size > MAX_MODULE_BYTES)
      throw fail(
        'WASM_SIZE',
        'The decoded WASM module exceeds the 32 MiB build profile.',
        'Disable unused engine features and use size optimization/LTO/strip.',
      );
    const wasm = await regularFile(stage, 'napplet_bg.wasm', MAX_MODULE_BYTES);
    const memory = inspectWasm(wasm);
    const compressed = Bun.gzipSync(wasm, { level: 9 });
    await writeFile(
      join(stage, 'entry.js'),
      `import init, * as api from './napplet.js';
      window.soyliWasmReady = (async () => {
        if (typeof DecompressionStream !== 'function') throw new Error('This browser needs support for DecompressionStream (gzip). Please update it.');
        const encoded = ${JSON.stringify(Buffer.from(compressed).toString('base64'))};
        const packed = Uint8Array.from(atob(encoded), c => c.charCodeAt(0));
        const reader = new Blob([packed]).stream().pipeThrough(new DecompressionStream('gzip')).getReader();
        const chunks = []; let size = 0;
        try { for (;;) { const {value, done} = await reader.read(); if (done) break;
          size += value.length; if (size > ${MAX_MODULE_BYTES}) throw new Error('Decoded WASM exceeds 32 MiB.'); chunks.push(value); }
        } finally { await reader.cancel(); }
        if (size !== ${wasm.length}) throw new Error('Decoded WASM size does not match the build.');
        const bytes = new Uint8Array(size); let offset = 0;
        for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
        await init({ module_or_path: bytes }); return api;
      })();
      window.soyliWasmReady.catch(error => {
        const output = document.createElement('pre'); output.setAttribute('role', 'alert');
        output.textContent = 'Could not start this WASM napplet: ' + (error?.message || String(error));
        document.body.append(output); console.error(error); throw error;
      });`,
    );
    const bundled = await Bun.build({
      entrypoints: [join(stage, 'entry.js')],
      target: 'browser',
      format: 'esm',
      minify: true,
    });
    if (!bundled.success || bundled.outputs.length !== 1)
      throw new DiagnosticError(
        'WASM_BUNDLE',
        'Could not bundle the WASM loader into one inline script.',
        {
          operation: 'package WASM napplet',
          tool: 'Bun bundler',
          detail: bundled.logs.map((l) => l.message).join('\n'),
          recovery:
            'Remove external/dynamic imports; keep local JS snippets available to the build.',
        },
      );
    signal?.throwIfAborted();
    let metadata = '';
    if (await Bun.file(join(directory, 'config.schema.json')).exists()) {
      const schema = validateConfigSchema(
        JSON.parse(
          new TextDecoder().decode(await regularFile(directory, 'config.schema.json', 16384)),
        ),
      );
      metadata = `<meta name="napplet-config-schema" content="${JSON.stringify(schema).replaceAll('&', '&amp;').replaceAll('"', '&quot;').replaceAll('<', '&lt;')}">`;
    }
    // Replace through a callback: generated source may contain replacement tokens such as $&.
    const script = (await bundled.outputs[0].text()).replace(/<\/script/gi, '<\\/script');
    const output = new TextEncoder().encode(
      template.replace(MARKER, () => `${metadata}<script type="module">${script}</script>`),
    );
    if (output.length > MAX_ARTIFACT_BYTES)
      throw fail(
        'WASM_SIZE',
        `Embedded HTML is ${(output.length / 1048576).toFixed(2)} MiB; the limit is ${MAX_ARTIFACT_BYTES / 1048576} MiB (decoded WASM: ${(wasm.length / 1048576).toFixed(2)} MiB).`,
        'Disable unused engine features, use opt-level="s"/LTO/strip, and move media to NAP-RESOURCE. Compressed WASM is base64-embedded; external executable WASM is not supported.',
      );
    await builtConfiguration(output);
    await mkdir(join(directory, 'dist'), { recursive: true });
    const temporary = join(directory, 'dist', `.wasm-${crypto.randomUUID()}.tmp`);
    try {
      await writeFile(temporary, output, { flag: 'wx' });
      await rename(temporary, join(directory, 'dist/index.html'));
    } finally {
      await rm(temporary, { force: true });
    }
    const report = {
      toolchain: recipe.toolchain,
      bindgen: recipe.bindgen,
      wasmBytes: wasm.length,
      compressedWasmBytes: compressed.length,
      htmlBytes: output.length,
      ...memory,
      buildMs: Math.round(performance.now() - started),
    };
    await writeFile(
      join(directory, '.napplet-space/wasm-build.json'),
      JSON.stringify(report, null, 2) + '\n',
    );
    console.error(
      `WASM: ${(wasm.length / 1048576).toFixed(2)} MiB → HTML: ${(output.length / 1048576).toFixed(2)} / ${MAX_ARTIFACT_BYTES / 1048576} MiB; memory ceiling: 256 MiB.`,
    );
  } finally {
    await rm(stage, { recursive: true, force: true });
  }
}

const inputs = [
  'src/**/*',
  'build.rs',
  'Cargo.toml',
  'Cargo.lock',
  'rust-toolchain.toml',
  '.cargo/config.toml',
  '.cargo/config',
  'index.html',
  'config.schema.json',
  'napplet.json',
  'napplet.assets.json',
  'assets/**/*',
  'docs/examples/*.rs',
];
export async function sourceStamp(directory: string, recipe: Build) {
  const files = new Set<string>();
  for (const pattern of recipe.watch ?? inputs) {
    if (pattern.startsWith('/') || pattern.split('/').includes('..'))
      throw fail(
        'BUILD_WATCH',
        'Watch patterns must stay inside the project.',
        'Use relative source globs in build.watch.',
      );
    for await (const file of new Bun.Glob(pattern).scan({
      cwd: directory,
      onlyFiles: true,
      dot: true,
      followSymlinks: false,
    })) {
      if (
        file
          .split('/')
          .some((p) => ['.git', '.napplet-space', 'target', 'dist', 'node_modules'].includes(p))
      )
        continue;
      files.add(file);
      if (files.size > 5000)
        throw fail(
          'BUILD_WATCH',
          'Too many watched source files.',
          'Narrow build.watch to your source and configuration files.',
        );
    }
  }
  return (
    await Promise.all(
      [...files].sort().map(async (file) => {
        const s = await lstat(join(directory, file)).catch((error) => {
          if (error.code === 'ENOENT') return null;
          throw error;
        });
        return `${file}:${s?.mtimeMs}:${s?.size}`;
      }),
    )
  ).join('\n');
}

/** No cargo-watch dependency or detached watcher. Rebuilds are serialized and cancellable. */
export async function watchRecipe(
  directory: string,
  recipe: Build,
  signal: AbortSignal,
  initialStamp?: string,
) {
  const local = new AbortController(),
    combined = AbortSignal.any([signal, local.signal]);
  let previous = initialStamp ?? (await sourceStamp(directory, recipe));
  const exited = (async () => {
    while (!combined.aborted) {
      await new Promise<void>((resolve) => {
        const done = () => {
          clearTimeout(timer);
          combined.removeEventListener('abort', done);
          resolve();
        };
        const timer = setTimeout(done, 500);
        combined.addEventListener('abort', done, { once: true });
        if (combined.aborted) done();
      });
      if (combined.aborted) break;
      const next = await sourceStamp(directory, recipe);
      if (previous === next) continue;
      previous = next;
      try {
        const current = await readBuildRecipe(directory);
        if (!current || current.kind !== recipe.kind)
          throw fail(
            'BUILD_CHANGED',
            'Build type changed.',
            'Restart soyli dev to use the new build type.',
          );
        await buildWithRecipe(directory, current, combined);
        recipe = current;
      } catch (error) {
        if (combined.aborted) break;
        console.error(formatDiagnostic(diagnose(error, 'rebuild napplet')));
        console.error('Keeping the last successful preview. Fix the source and save to retry.');
      }
    }
  })();
  return {
    stop: async () => {
      local.abort();
      await exited;
    },
    exited,
    failure: () =>
      new DiagnosticError('BUILD_WATCH', 'The source watcher stopped.', {
        operation: 'watch project builds',
        recovery: 'Restart soyli dev.',
      }),
  };
}
