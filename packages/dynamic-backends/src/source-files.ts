import { sourceGit } from '../../grasp/src/client';
import { DiagnosticError, ToolOutput } from '../../diagnostics/src';
import { BackendError } from './contracts';

export async function blob(
  directory: string,
  commit: string,
  path: string,
  maximum: number,
): Promise<string> {
  const entry = await sourceGit(directory, ['ls-tree', commit, '--', path]);
  if (!entry.startsWith('100644 blob ') && !entry.startsWith('100755 blob '))
    throw new BackendError(
      'BAD_INPUT',
      'Backend build inputs must be regular tracked Git files, not symlinks or submodules.',
    );
  const child = Bun.spawn(
    ['git', '-c', 'core.hooksPath=/dev/null', 'cat-file', 'blob', `${commit}:${path}`],
    {
      cwd: directory,
      env: {
        PATH: process.env.PATH,
        GIT_CONFIG_NOSYSTEM: '1',
        GIT_CONFIG_GLOBAL: '/dev/null',
        GIT_TERMINAL_PROMPT: '0',
        GIT_NO_LAZY_FETCH: '1',
      },
      stdin: 'ignore',
      stdout: 'pipe',
      stderr: 'pipe',
    },
  );
  const timer = setTimeout(() => child.kill('SIGKILL'), 10000),
    diagnostic = new ToolOutput();
  const error = (async () => {
    for await (const chunk of child.stderr) diagnostic.push(chunk);
    diagnostic.finish();
  })();
  try {
    const chunks: Uint8Array[] = [];
    let size = 0;
    for await (const chunk of child.stdout) {
      size += chunk.length;
      if (size > maximum)
        throw new BackendError('BAD_INPUT', `Committed backend file exceeds ${maximum} bytes.`);
      chunks.push(chunk);
    }
    const status = await child.exited;
    await error;
    if (status !== 0)
      throw new DiagnosticError('BACKEND_SOURCE', 'Could not read committed backend source.', {
        operation: 'read backend Git blob',
        tool: 'git',
        exitCode: status,
        detail: diagnostic.text,
      });
    return new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks));
  } finally {
    clearTimeout(timer);
    if (child.exitCode === null) child.kill('SIGKILL');
    await child.exited;
    await error;
  }
}
