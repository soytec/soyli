import { tmpdir } from 'node:os';
import { mkdir, writeFile, rmdir } from 'node:fs/promises';
import { join } from 'node:path';
import { BackendError } from './contracts';
import { ToolOutput } from '../../diagnostics/src';

/** Bounded line framing. Never accumulate an unbounded line from a broken worker. */
export async function* jsonLines(stream: ReadableStream<Uint8Array>, maximum: number) {
  let pending = Buffer.alloc(0),
    total = 0;
  for await (const chunk of stream) {
    total += chunk.length;
    if (total > maximum)
      throw new BackendError('QUOTA_EXCEEDED', 'Worker output exceeds its byte budget.');
    pending = Buffer.concat([pending, chunk]);
    let end: number;
    while ((end = pending.indexOf(10)) !== -1) {
      const line = pending.subarray(0, end).toString('utf8');
      pending = pending.subarray(end + 1);
      if (line) yield JSON.parse(line);
    }
  }
  if (pending.length)
    throw new BackendError('RUNTIME_FAILED', 'Worker returned an incomplete response.');
}

export type WorkerCommand = string[] | { argv: string[]; cgroupRoot: string };
async function workerGroup(command: WorkerCommand) {
  if (Array.isArray(command)) return { argv: command, cleanup: async () => {} };
  const directory = join(command.cgroupRoot, 'worker-' + crypto.randomUUID());
  await mkdir(directory);
  const cleanup = async () => {
    await writeFile(join(directory, 'cgroup.kill'), '1');
    for (let attempt = 0; ; attempt++) {
      try {
        await rmdir(directory);
        return;
      } catch (error) {
        if (attempt === 20) throw error;
        await Bun.sleep(10);
      }
    }
  };
  try {
    await writeFile(join(directory, 'memory.max'), String(256 * 1024 * 1024));
    await writeFile(join(directory, 'memory.swap.max'), '0');
    await writeFile(join(directory, 'pids.max'), '32');
    await writeFile(join(directory, 'cpu.max'), '100000 100000');
    // Move before starting Bun/bwrap: no unbounded launch window or inherited secrets.
    return {
      argv: [
        '/bin/sh',
        '-ec',
        'printf %s "$$" > "$1/cgroup.procs"; shift; exec "$@"',
        'soy-worker',
        directory,
        ...command.argv,
      ],
      cleanup,
    };
  } catch (error) {
    await cleanup();
    throw error;
  }
}
export async function workerExchange(
  command: WorkerCommand,
  first: unknown,
  options: {
    maximum: number;
    timeoutMs: number;
    signal?: AbortSignal;
    reply?: (message: any) => unknown;
  },
) {
  const diagnostic = new ToolOutput();
  const group = await workerGroup(command);
  let child;
  try {
    child = Bun.spawn(group.argv, {
      cwd: tmpdir(),
      env: { PATH: '/usr/bin:/bin', LANG: 'C.UTF-8' },
      stdin: 'pipe',
      stdout: 'pipe',
      stderr: 'pipe',
    });
  } catch (error) {
    await group.cleanup();
    throw error;
  }
  let expired = false;
  const stop = () => {
    expired = true;
    child.kill('SIGKILL');
  };
  const timer = setTimeout(stop, options.timeoutMs);
  options.signal?.addEventListener('abort', stop, { once: true });
  if (options.signal?.aborted) stop();
  const errors = (async () => {
    for await (const chunk of child.stderr) diagnostic.push(chunk);
    diagnostic.finish();
  })();
  try {
    child.stdin.write(JSON.stringify(first) + '\n');
    await child.stdin.flush();
    if (!options.reply) child.stdin.end();
    for await (const message of jsonLines(child.stdout, options.maximum)) {
      if (expired) break;
      if (message.type === 'result') return message.value;
      if (message.type === 'failure')
        throw new BackendError('RUNTIME_FAILED', String(message.message).slice(0, 512));
      if (!options.reply) throw new BackendError('RUNTIME_FAILED', 'Unexpected worker response.');
      child.stdin.write(JSON.stringify(options.reply(message)) + '\n');
      await child.stdin.flush();
    }
    const status = await child.exited;
    await errors;
    if (expired)
      throw new BackendError(
        'DEADLINE_EXCEEDED',
        'Backend worker was cancelled or exceeded its deadline.',
      );
    throw new BackendError(
      'RUNTIME_FAILED',
      `Backend worker exited with status ${status}: ${diagnostic.text || 'no result'}. Check the provider sandbox/runtime setup.`,
    );
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener('abort', stop);
    if (child.exitCode === null) child.kill('SIGKILL');
    await child.exited;
    await errors;
    await group.cleanup();
  }
}
