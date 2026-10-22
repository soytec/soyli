import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { DiagnosticError, ToolOutput } from '../../diagnostics/src';

const bundles = new Map<string, Promise<string>>();

/** Trusted, signer-free networking under Node. No temporary files, draft-relative
 * imports or inherited credentials; both runtimes use the same destination guards. */
export async function publicNodeWorker(
  entry: string,
  input: unknown,
  signal: AbortSignal,
  maxBytes: number,
  operation: string,
  timeoutMs = 30000,
) {
  signal.throwIfAborted();
  const root =
    process.env.SPACE_RELEASE_DIR ?? fileURLToPath(new URL('../../../', import.meta.url));
  const path = resolve(root, entry);
  let bundle = bundles.get(path);
  if (!bundle) {
    bundle = (async () => {
      const result = await Bun.build({
        entrypoints: [path],
        target: 'node',
        format: 'esm',
        packages: 'external',
      });
      if (!result.success)
        throw new DiagnosticError(
          'PUBLIC_NETWORK_WORKER',
          'Could not prepare the public network worker.',
          {
            operation,
            cause: new AggregateError(result.logs, 'Worker compilation failed.'),
          },
        );
      return result.outputs[0].text();
    })();
    bundles.set(path, bundle);
    void bundle.catch(() => bundles.delete(path));
  }
  const code = await bundle;
  signal.throwIfAborted();
  const child = (() => {
    try {
      return Bun.spawn(['node', '--input-type=module', '--eval', code], {
        cwd: root,
        stdin: new Blob([JSON.stringify(input)]),
        stdout: 'pipe',
        stderr: 'pipe',
        env: { PATH: process.env.PATH, NODE_EXTRA_CA_CERTS: process.env.NODE_EXTRA_CA_CERTS },
      });
    } catch (cause) {
      throw new DiagnosticError(
        'PUBLIC_NETWORK_WORKER',
        'Could not start the public network worker.',
        { operation, tool: 'node', cause },
      );
    }
  })();
  const errors = new ToolOutput();
  const stderr = (async () => {
    for await (const chunk of child.stderr) errors.push(chunk);
    errors.finish();
  })();
  const stop = () => child.kill('SIGKILL');
  let timedOut = false;
  const timeout = setTimeout(() => {
    timedOut = true;
    stop();
  }, timeoutMs);
  signal.addEventListener('abort', stop, { once: true });
  if (signal.aborted) stop();
  try {
    const chunks: Uint8Array[] = [];
    let size = 0;
    for await (const chunk of child.stdout) {
      size += chunk.length;
      if (size > maxBytes)
        throw new DiagnosticError(
          'PUBLIC_NETWORK_SIZE',
          'Public network response exceeds byte limit.',
          { operation },
        );
      chunks.push(chunk);
    }
    const exitCode = await child.exited;
    await stderr;
    signal.throwIfAborted();
    if (timedOut || exitCode !== 0)
      throw new DiagnosticError(
        timedOut ? 'ETIMEDOUT' : 'PUBLIC_NETWORK_WORKER',
        timedOut ? 'Public network operation timed out.' : 'Public network worker failed.',
        { operation, tool: 'node', exitCode, detail: errors.text },
      );
    return new Uint8Array(Buffer.concat(chunks, size));
  } finally {
    clearTimeout(timeout);
    signal.removeEventListener('abort', stop);
    if (child.exitCode === null) stop();
    await child.exited;
    await stderr;
  }
}
