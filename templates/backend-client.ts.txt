// Optional NAP-CVM client. Operation names and game rules belong to your project.
export type BackendModule = { napplet: string; name: string };
export type BackendTarget = { module: BackendModule; release: string; instance?: string };
export type BackendIntent = {
  target: BackendTarget; operation: string; input: unknown; requestId: string; expiresAt: number;
};
export type BackendResult<T> = {
  ok: true; release: string; requestId: string; instance: string; revision: number; result: T;
};
export class BackendCallError extends Error {
  constructor(message: string, readonly definitive: boolean, readonly code?: string) { super(message); }
}
export function backendClient(napplet: any) {
  async function call<T>(name: string, args: unknown): Promise<T> {
    let reply: any;
    // First account-bound calls include a host popup and extension/remote signing.
    // This is the UI deadline, not a longer handler execution or retry window.
    const accountCall = ['soy_backend_invoke', 'soy_backend_changes', 'soy_backend_purge_plan', 'soy_backend_purge_confirm'].includes(name);
    try { reply = await napplet.cvm.registry.call('soy.backends.v1', name, args, {timeoutMs:accountCall ? 120000 : 15000}); }
    catch (error) { throw new BackendCallError(error instanceof Error ? error.message : 'Connection interrupted', false); }
    const value = reply.structuredContent ?? JSON.parse(reply.content?.find((item: any) => item.type === 'text')?.text ?? '{}');
    if (reply.isError) throw new BackendCallError(value.error?.message ?? 'Backend rejected this operation', true, value.error?.code);
    return value as T;
  }
  return {
    call,
    describe: (module: BackendModule, release?: string) => call<{
      active: string | null; release?: string; disabled: boolean; schemas?: unknown; receipt?: unknown;
    }>('soy_backend_describe', {module, ...(release ? {release} : {})}),
    // Create this ONCE per user intent. Retain it until the result is known.
    intent: (target: BackendTarget, operation: string, input: unknown): BackendIntent => ({
      target, operation, input, requestId:crypto.randomUUID(), expiresAt:Math.floor(Date.now()/1000)+240,
    }),
    invoke: <T>(intent: BackendIntent) => call<BackendResult<T>>('soy_backend_invoke', intent),
  };
}
