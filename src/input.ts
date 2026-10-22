import { createInterface } from 'node:readline/promises';
import { AccountError } from '../packages/identity/src/signer';

export async function ask(text: string, signal?: AbortSignal) {
  const input = createInterface({ input: process.stdin, output: process.stderr });
  try {
    return await input.question(text, { signal });
  } catch (error) {
    if (signal?.aborted) throw new AccountError('INPUT_CANCELLED', 'Creator setup cancelled.');
    throw error;
  } finally {
    input.close();
  }
}
export function hiddenInput(label: string, signal?: AbortSignal): Promise<string> {
  if (signal?.aborted)
    return Promise.reject(new AccountError('INPUT_CANCELLED', 'Secret input cancelled.'));
  if (!process.stdin.isTTY)
    throw new AccountError(
      'INTERACTIVE_REQUIRED',
      'Use an interactive terminal, or the explicit --stdin/--passphrase-stdin input option. Never pass secrets as arguments.',
    );
  process.stderr.write(label);
  return new Promise((resolve, reject) => {
    let result = '';
    const previousRaw = process.stdin.isRaw;
    process.stdin.setRawMode(true);
    process.stdin.setEncoding('utf8');
    const cleanup = () => {
      process.stdin.off('data', data);
      process.stdin.off('end', ended);
      signal?.removeEventListener('abort', ended);
      process.stdin.setRawMode(previousRaw);
      process.stdin.pause();
      process.stderr.write('\n');
    };
    const ended = () => {
      cleanup();
      reject(new AccountError('INPUT_CANCELLED', 'Secret input cancelled.'));
    };
    const data = (chunk: string) => {
      for (const character of chunk) {
        if (character === '\u0003' || character === '\u0004') {
          ended();
          return;
        }
        if (character === '\r' || character === '\n') {
          cleanup();
          resolve(result);
          return;
        }
        if (character === '\u007f' || character === '\b')
          result = Array.from(result).slice(0, -1).join('');
        else if (character >= ' ') result += character;
        if (result.length > 4096) {
          cleanup();
          reject(new AccountError('INPUT_LIMIT', 'Secret input exceeds the supported limit.'));
          return;
        }
      }
    };
    process.stdin.on('data', data);
    process.stdin.once('end', ended);
    signal?.addEventListener('abort', ended, { once: true });
    process.stdin.resume();
  });
}
export async function secretStdin() {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of process.stdin) {
    const bytes = Buffer.from(chunk);
    size += bytes.length;
    if (size > 4096)
      throw new AccountError('INPUT_LIMIT', 'Secret input exceeds the supported limit.');
    chunks.push(bytes);
  }
  return Buffer.concat(chunks)
    .toString('utf8')
    .replace(/\r\n/g, '\n')
    .replace(/\n$/, '')
    .split('\n');
}
