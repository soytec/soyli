import { BackendError, LIMITS } from './contracts';
import { jsonBytes } from './schema';
import { workerExchange, type WorkerCommand } from './worker-process';
import type { BackendContext } from './handler-types';

export type HostCall = (method: string, args: Record<string, unknown>) => unknown;
export type RuntimeContext = Omit<BackendContext, 'state' | 'principal' | 'owner'> & {
  principal: string;
  owner: string;
};
export function runtimeCommand() {
  return import.meta.url.includes('/$bunfs/')
    ? [process.execPath, '--internal-backend-worker']
    : [process.execPath, '--no-env-file', new URL('./worker.ts', import.meta.url).pathname];
}
/** Separate one-call process and WASM heap, with bounded IPC and an outer deadline. */
export async function executeHandler(
  code: string,
  context: RuntimeContext,
  input: unknown,
  host: HostCall,
  options: { command?: WorkerCommand; signal?: AbortSignal; compile?: boolean } = {},
) {
  jsonBytes(context);
  jsonBytes(input);
  if (Buffer.byteLength(code) > LIMITS.sourceBytes * 2)
    throw new BackendError('BAD_INPUT', 'Handler artifact exceeds limit.');
  let calls = 0,
    bytes = 0;
  const value = await workerExchange(
    options.command ?? runtimeCommand(),
    options.compile ? { type: 'compile', source: code } : { type: 'run', code, context, input },
    {
      maximum: options.compile ? LIMITS.sourceBytes * 4 : LIMITS.bytesPerCall,
      timeoutMs: LIMITS.lifetimeMs,
      signal: options.signal,
      reply(message) {
        if (
          message.type !== 'state' ||
          ++calls > LIMITS.hostCalls ||
          !Number.isSafeInteger(message.id) ||
          typeof message.method !== 'string' ||
          typeof message.json !== 'string'
        )
          throw new BackendError('QUOTA_EXCEEDED', 'Handler state-call budget exceeded.');
        bytes += Buffer.byteLength(jsonBytes(message));
        const args = JSON.parse(message.json);
        jsonBytes(args);
        const json = jsonBytes(host(message.method, args));
        bytes += Buffer.byteLength(json);
        if (bytes > LIMITS.bytesPerCall)
          throw new BackendError('QUOTA_EXCEEDED', 'Handler state byte budget exceeded.');
        return { type: 'reply', id: message.id, json };
      },
    },
  );
  jsonBytes(value, options.compile ? LIMITS.sourceBytes * 2 : LIMITS.jsonBytes);
  return value;
}

export async function compileHandler(source: string, command?: WorkerCommand) {
  const result = await executeHandler(
    source,
    {
      actor: '',
      account: null,
      principal: '',
      owner: '',
      instance: '',
      release: '',
      operation: '',
      requestId: '',
      now: 0,
    },
    {},
    () => {
      throw new Error('State is unavailable during compilation.');
    },
    { compile: true, command },
  );
  return (result as { code: string }).code;
}
