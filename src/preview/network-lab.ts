import { z } from 'zod';

export const networkConditions = z
  .object({
    latencyMs: z.number().int().min(0).max(1000).default(0),
    jitterMs: z.number().int().min(0).max(500).default(0),
    seed: z.number().int().min(1).max(2147483647).default(1),
  })
  .strict();
export type NetworkConditions = z.infer<typeof networkConditions>;

/** Serialized by Playwright: keep all browser helpers inside this function. Test host only. */
export function installNetworkLab(initial: NetworkConditions) {
  if (window.parent !== window) return;
  type Queue = {
    bytes: number;
    items: { due: number; data: string; bytes: number }[];
    timer?: ReturnType<typeof setTimeout>;
  };
  let conditions = { ...initial },
    randomState = initial.seed;
  let delayedMessages = 0,
    peakQueuedBytes = 0;
  const queues = new Map<RTCDataChannel, Queue>();
  const nativeSend = RTCDataChannel.prototype.send;
  RTCDataChannel.prototype.send = function (
    this: RTCDataChannel,
    data: string | Blob | ArrayBuffer | ArrayBufferView,
  ) {
    if (!conditions.latencyMs && !conditions.jitterMs && !queues.get(this)?.items.length) {
      (nativeSend as Function).call(this, data);
      return;
    }
    // The pinned host sends JSON strings. Leave other traffic untouched.
    if (typeof data !== 'string') {
      (nativeSend as Function).call(this, data);
      return;
    }
    if (this.readyState !== 'open') throw new Error('WebRTC is connecting');
    let queue = queues.get(this);
    if (!queue) {
      queue = { bytes: 0, items: [] };
      queues.set(this, queue);
      this.addEventListener(
        'close',
        () => {
          clearTimeout(queue!.timer);
          queue!.items = [];
          queue!.bytes = 0;
          queues.delete(this);
        },
        { once: true },
      );
    }
    const bytes = new TextEncoder().encode(data).length;
    if (queue.bytes + this.bufferedAmount + bytes > 262144 || queue.items.length >= 4096)
      throw new Error('WebRTC backpressure in simulated network; skip obsolete updates');
    randomState = (Math.imul(randomState, 1664525) + 1013904223) >>> 0;
    const jitter = ((randomState / 4294967296) * 2 - 1) * conditions.jitterMs;
    // Preserve reliable ordered semantics, even when the sampled jitter would reorder messages.
    const now = performance.now();
    const due = Math.max(
      queue.items.at(-1)?.due ?? 0,
      now + Math.max(0, conditions.latencyMs + jitter),
    );
    queue.items.push({ due, data, bytes });
    queue.bytes += bytes;
    delayedMessages++;
    peakQueuedBytes = Math.max(peakQueuedBytes, queue.bytes);
    const drain = () => {
      queue!.timer = undefined;
      while (queue!.items.length && queue!.items[0].due <= performance.now()) {
        const item = queue!.items.shift()!;
        queue!.bytes -= item.bytes;
        if (this.readyState === 'open') {
          try {
            (nativeSend as Function).call(this, item.data);
          } catch {
            /* Peer closed during delivery. */
          }
        }
      }
      if (queue!.items.length)
        queue!.timer = setTimeout(
          drain,
          Math.max(1, Math.ceil(queue!.items[0].due - performance.now())),
        );
    };
    if (queue.timer === undefined)
      queue.timer = setTimeout(drain, Math.max(0, Math.ceil(due - now)));
  } as typeof RTCDataChannel.prototype.send;
  Object.assign(window, {
    soyliNetworkLab: {
      read: () => ({
        ...conditions,
        delayedMessages,
        peakQueuedBytes,
        queuedBytes: [...queues.values()].reduce((sum, q) => sum + q.bytes, 0),
      }),
      set: (next: NetworkConditions) => {
        // Only the trusted runner calls this; enforce bounds in both entry points.
        if (
          !Number.isInteger(next.latencyMs) ||
          next.latencyMs < 0 ||
          next.latencyMs > 1000 ||
          !Number.isInteger(next.jitterMs) ||
          next.jitterMs < 0 ||
          next.jitterMs > 500 ||
          !Number.isInteger(next.seed) ||
          next.seed < 1 ||
          next.seed > 2147483647
        )
          throw new Error('Invalid network conditions');
        conditions = { ...next };
        randomState = next.seed;
      },
    },
  });
}
