// This process receives only code, bounded input/context and scoped state replies.
// Creator code is evaluated exclusively inside the QuickJS WebAssembly heap.
import {
  newQuickJSWASMModuleFromVariant,
  type QuickJSContext,
  type QuickJSDeferredPromise,
} from 'quickjs-emscripten';
import variant from '@jitl/quickjs-singlefile-cjs-release-sync';
import { LIMITS } from './contracts';
import { jsonLines } from './worker-process';

export async function backendWorker() {
  let started = false,
    vm: QuickJSContext | undefined,
    sequence = 0;
  const pending = new Map<number, QuickJSDeferredPromise>();
  const send = (message: unknown) => process.stdout.write(JSON.stringify(message) + '\n');
  const pump = () => {
    if (!vm) return;
    const result = vm.runtime.executePendingJobs();
    if (result.error) {
      const reason = vm.dump(result.error);
      result.error.dispose();
      throw new Error(String(reason?.message ?? 'Handler job failed'));
    }
  };
  const fail = (error: unknown) =>
    send({
      type: 'failure',
      message: String(error instanceof Error ? error.message : error)
        .slice(0, 512)
        .replace(/[\u0000-\u001f\u007f]/g, ' '),
    });
  const receive = (raw: unknown) => {
    const message = raw as Record<string, any>;
    if (message.type === 'reply' && vm) {
      const deferred = pending.get(message.id);
      if (!deferred) return;
      pending.delete(message.id);
      const value = message.error ? vm.newError(String(message.error)) : vm.newString(message.json);
      if (message.error) deferred.reject(value);
      else deferred.resolve(value);
      value.dispose();
      deferred.dispose();
      try {
        pump();
      } catch (error) {
        fail(error);
      }
      return;
    }
    if (!['run', 'compile'].includes(message.type) || started) return;
    started = true;
    if (message.type === 'compile') {
      try {
        if (
          typeof message.source !== 'string' ||
          Buffer.byteLength(message.source) > LIMITS.sourceBytes
        )
          throw new Error('Source exceeds build budget.');
        const compiler = new Bun.Transpiler({ loader: 'ts', target: 'browser' });
        const scan = compiler.scan(message.source);
        if (scan.imports.length)
          throw new Error(
            'This build profile accepts one self-contained TypeScript handler. Bundle dependencies into that source; imports and project build scripts are not supported.',
          );
        if (!scan.exports.includes('handle'))
          throw new Error('Export function handle(context, input) from the backend source.');
        const code = compiler.transformSync(message.source);
        if (Buffer.byteLength(code) > LIMITS.sourceBytes * 2)
          throw new Error('Compiled artifact exceeds build budget.');
        send({ type: 'result', value: { code } });
      } catch (error) {
        fail(error);
      }
      return;
    }
    void (async () => {
      const engine = await newQuickJSWASMModuleFromVariant(variant);
      vm = engine.newContext();
      vm.runtime.setMemoryLimit(LIMITS.memoryBytes);
      vm.runtime.setMaxStackSize(LIMITS.stackBytes);
      const deadline = Date.now() + LIMITS.executionMs;
      let interrupts = 0;
      vm.runtime.setInterruptHandler(
        () => ++interrupts > LIMITS.interruptChecks || Date.now() > deadline,
      );
      // No module loader, WASI, filesystem, HTTP, timers or ambient environment.
      const bridge = vm.newFunction('__state', (method, argumentsJson) => {
        const deferred = vm!.newPromise(),
          id = ++sequence;
        pending.set(id, deferred);
        send({
          type: 'state',
          id,
          method: vm!.getString(method),
          json: vm!.getString(argumentsJson),
        });
        return deferred.handle;
      });
      vm.setProp(vm.global, '__state', bridge);
      bridge.dispose();
      const contextCode = `(() => {
        const bridge = globalThis.__state; delete globalThis.__state;
        const call = async (method, args) => JSON.parse(await bridge(method, JSON.stringify(args)));
        const context = ${JSON.stringify(message.context)};
        return Object.freeze({...context, state: Object.freeze({
          get: (collection, key) => call('get', {collection, key}),
          set: (collection, key, value) => call('set', {collection, key, value}),
          remove: (collection, key) => call('remove', {collection, key}),
          access: () => call('access', {}),
          setAccess: (value) => call('setAccess', {value}),
          setMember: (principal, role) => call('setMember', {principal, role})
        })});
      })()`;
      const context = vm.unwrapResult(vm.evalCode(contextCode));
      const input = vm.unwrapResult(
        vm.evalCode(`JSON.parse(${JSON.stringify(JSON.stringify(message.input))})`),
      );
      const exports = vm.unwrapResult(vm.evalCode(message.code, 'backend.mjs', { type: 'module' }));
      const handle = vm.getProp(exports, 'handle');
      if (vm.typeof(handle) !== 'function')
        throw new Error('Backend must export function handle(context, input).');
      const called = vm.unwrapResult(vm.callFunction(handle, vm.undefined, context, input));
      const settled = vm.resolvePromise(called);
      pump();
      const result = await settled;
      if (result.error) {
        const error = vm.dump(result.error);
        throw new Error(String(error?.message ?? 'Handler failed'));
      }
      // Stringification stays in WASM: getters/toJSON cannot execute in the service.
      const json = vm.getProp(vm.global, 'JSON'),
        stringify = vm.getProp(json, 'stringify');
      const encoded = vm.unwrapResult(vm.callFunction(stringify, json, result.value));
      if (vm.typeof(encoded) !== 'string') throw new Error('Return a JSON object.');
      const output = vm.getString(encoded);
      if (output.length > LIMITS.jsonBytes) throw new Error('Handler output exceeds byte budget.');
      send({ type: 'result', value: JSON.parse(output) });
      // The parent reaps this one-call process. No heap/state survives into another invocation.
    })().catch(fail);
  };
  for await (const message of jsonLines(Bun.stdin.stream(), LIMITS.sourceBytes * 8))
    receive(message);
}
if (import.meta.main) await backendWorker();
