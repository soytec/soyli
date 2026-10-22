import { AccountError } from '../packages/identity/src/signer';
import { hostEnvironment } from './distribution';

export async function gitAvailable() {
  const git = Bun.which('git');
  if (!git) return false;
  const child = Bun.spawn([git, '--version'], {
    env: hostEnvironment(),
    stdin: 'ignore',
    stdout: 'ignore',
    stderr: 'ignore',
  });
  const timer = setTimeout(() => child.kill('SIGKILL'), 5000);
  try {
    return (await child.exited) === 0;
  } finally {
    clearTimeout(timer);
  }
}
export async function requireGit() {
  if (!(await gitAvailable()))
    throw new AccountError(
      'GIT_REQUIRED',
      process.platform === 'darwin'
        ? 'Git is required. Install Apple Command Line Tools with xcode-select --install, then retry. No project was created.'
        : 'Git is required. Install Git using your operating system package manager, then retry. No project was created.',
    );
}
