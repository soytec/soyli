/** Operator/client transfer policy, independent of Blossom wire formats and byte quotas. */
export const UPLOAD_TIMEOUTS = { idleMs: 30_000, totalMs: 5 * 60_000 };
export const CLIENT_TIMEOUTS = { uploadMs: 6 * 60_000, verificationMs: 5 * 60_000, idleMs: 30_000 };

export function transferDeadline(options: {
  totalMs: number;
  idleMs?: number;
  signal?: AbortSignal;
  label: string;
}) {
  for (const ms of [options.totalMs, options.idleMs])
    if (ms !== undefined && (!Number.isSafeInteger(ms) || ms <= 0))
      throw new Error('Transfer timeouts must be positive integer milliseconds');
  const controller = new AbortController();
  const total = setTimeout(
    () => controller.abort(new Error(`${options.label} exceeded its overall time limit`)),
    options.totalMs,
  );
  let idle: ReturnType<typeof setTimeout> | undefined;
  const progress = () => {
    clearTimeout(idle);
    if (options.idleMs && !controller.signal.aborted)
      idle = setTimeout(
        () => controller.abort(new Error(`${options.label} stalled: no data received`)),
        options.idleMs,
      );
  };
  const abort = () =>
    controller.abort(options.signal?.reason ?? new Error(`${options.label} cancelled`));
  if (options.signal?.aborted) abort();
  else options.signal?.addEventListener('abort', abort, { once: true });
  progress();
  return {
    signal: controller.signal,
    progress,
    /** A body reader need not itself honor AbortSignal (including local streams). */
    async wait<T>(pending: Promise<T>): Promise<T> {
      let fail!: () => void;
      const aborted = new Promise<never>((_, reject) => {
        fail = () => reject(controller.signal.reason);
        if (controller.signal.aborted) fail();
        else controller.signal.addEventListener('abort', fail, { once: true });
      });
      try {
        return await Promise.race([pending, aborted]);
      } finally {
        controller.signal.removeEventListener('abort', fail);
      }
    },
    close() {
      clearTimeout(total);
      clearTimeout(idle);
      options.signal?.removeEventListener('abort', abort);
      controller.abort(new Error(`${options.label} closed`));
    },
  };
}
export type TransferDeadline = ReturnType<typeof transferDeadline>;
