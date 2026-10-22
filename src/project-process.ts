import { DiagnosticError, ToolOutput } from '../packages/diagnostics/src';
import { AccountError } from '../packages/identity/src/signer';

export function projectEnvironment() {
  const env: Record<string, string> = {};
  for (const key of [
    'HOME',
    'USER',
    'LOGNAME',
    'TMPDIR',
    'TEMP',
    'TMP',
    'XDG_CACHE_HOME',
    'HTTP_PROXY',
    'HTTPS_PROXY',
    'NO_PROXY',
    'SSL_CERT_FILE',
    'NODE_EXTRA_CA_CERTS',
    'PLAYWRIGHT_BROWSERS_PATH',
  ])
    if (process.env[key]) env[key] = process.env[key]!;
  return env;
}
export async function runProjectCommand(
  args: string[],
  cwd: string,
  env: Record<string, string>,
  signal?: AbortSignal,
  capture = false,
  operation = 'run project tool',
  timeoutMs = 300000,
) {
  if (signal?.aborted) throw new AccountError('BUILD_CANCELLED', 'Project setup/build cancelled.');
  const tool = args[1]?.endsWith('/pnpm.cjs') ? 'pnpm' : args[0].split('/').pop() || 'project tool';
  let child;
  try {
    child = Bun.spawn(args, {
      cwd,
      env,
      stdin: 'ignore',
      stdout: 'pipe',
      stderr: 'pipe',
      detached: true,
    });
  } catch (cause) {
    throw new DiagnosticError('PROJECT_TOOL_START', 'Could not start the project tool.', {
      operation,
      tool,
      cause,
    });
  }
  const kill = (kind: NodeJS.Signals) => {
    try {
      process.kill(-child.pid, kind);
    } catch {
      child.kill(kind);
    }
  };
  let cancelled = false;
  let cancellationTimer: ReturnType<typeof setTimeout> | undefined;
  const stop = () => {
    cancelled = true;
    kill('SIGTERM');
    cancellationTimer ??= setTimeout(() => kill('SIGKILL'), 500);
  };
  signal?.addEventListener('abort', stop, { once: true });
  if (signal?.aborted) stop();
  let timedOut = false;
  const timeout = setTimeout(() => {
    timedOut = true;
    kill('SIGKILL');
  }, timeoutMs);
  const stdoutLog = new ToolOutput(capture ? undefined : (text) => process.stderr.write(text));
  const stderrLog = new ToolOutput((text) => process.stderr.write(text));
  let output = '';
  async function drain(stream: ReadableStream<Uint8Array>, stdout: boolean) {
    for await (const bytes of stream) {
      if (capture && stdout) {
        output += new TextDecoder().decode(bytes);
        stdoutLog.push(bytes);
        if (output.length > 2 * 1024 * 1024) {
          kill('SIGKILL');
          throw new DiagnosticError(
            'PROJECT_TOOL_OUTPUT',
            'Tool output exceeds the 2 MiB capture limit.',
            { operation, tool },
          );
        }
      } else (stdout ? stdoutLog : stderrLog).push(bytes);
    }
    (stdout ? stdoutLog : stderrLog).finish();
  }
  try {
    const [code] = await Promise.all([
      child.exited,
      drain(child.stdout, true),
      drain(child.stderr, false),
    ]);
    if (cancelled) throw new AccountError('BUILD_CANCELLED', 'Project setup/build cancelled.');
    if (timedOut || code)
      throw new DiagnosticError(
        timedOut ? 'PROJECT_TOOL_TIMEOUT' : 'PROJECT_TOOL',
        timedOut
          ? `Project tool exceeded its ${timeoutMs / 1000}-second deadline.`
          : 'The project tool reported a failure.',
        {
          operation,
          tool,
          exitCode: code,
          detail: (stderrLog.text || stdoutLog.text).slice(-2000),
          recovery:
            'Fix the tool error shown above and retry setup/build or the requested project command.',
        },
      );
    return output;
  } finally {
    clearTimeout(timeout);
    clearTimeout(cancellationTimer);
    signal?.removeEventListener('abort', stop);
    if (child.exitCode === null) kill('SIGKILL');
  }
}
