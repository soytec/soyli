import { z } from 'zod';

export const networkConditions = z
  .object({
    latencyMs: z.number().int().min(0).max(1000).default(0),
    jitterMs: z.number().int().min(0).max(500).default(0),
    seed: z.number().int().min(1).max(2147483647).default(1),
    lossRatio: z.number().min(0).max(1).default(0),
    retransmitMs: z.number().int().min(0).max(5000).default(200),
  })
  .strict();
export type NetworkConditions = z.infer<typeof networkConditions>;

/** Serialized by Playwright: keep all browser helpers inside this function. Test host only. */
export function installNetworkLab(
  initial: Pick<NetworkConditions, 'latencyMs' | 'jitterMs' | 'seed'> & Partial<NetworkConditions>,
) {
  if (window.parent !== window) return;
  type Queue = {
    bytes: number;
    items: { due: number; data: string | ArrayBuffer; bytes: number }[];
    timer?: ReturnType<typeof setTimeout>;
  };
  let conditions = { lossRatio: 0, retransmitMs: 200, ...initial },
    randomState = initial.seed;
  let delayedMessages = 0,
    peakQueuedBytes = 0,
    droppedMessages = 0,
    retransmissions = 0,
    binaryMessages = 0,
    sentBytes = 0;
  const queues = new Map<RTCDataChannel, Queue>();
  const nativeSend = RTCDataChannel.prototype.send;
  const buffered = Object.getOwnPropertyDescriptor(RTCDataChannel.prototype, 'bufferedAmount');
  if (buffered?.get)
    Object.defineProperty(RTCDataChannel.prototype, 'bufferedAmount', {
      ...buffered,
      get() {
        return buffered.get!.call(this) + (queues.get(this)?.bytes ?? 0);
      },
    });
  const random = () => {
    randomState = (Math.imul(randomState, 1664525) + 1013904223) >>> 0;
    return randomState / 4294967296;
  };
  RTCDataChannel.prototype.send = function (
    this: RTCDataChannel,
    data: string | Blob | ArrayBuffer | ArrayBufferView,
  ) {
    if (data instanceof Blob) {
      (nativeSend as Function).call(this, data);
      return;
    }
    const copy =
      typeof data === 'string'
        ? data
        : data instanceof ArrayBuffer
          ? data.slice(0)
          : new Uint8Array(data.buffer, data.byteOffset, data.byteLength).slice().buffer;
    const bytes =
      typeof copy === 'string' ? new TextEncoder().encode(copy).length : copy.byteLength;
    sentBytes += bytes;
    if (typeof copy !== 'string') binaryMessages++;
    if (
      !conditions.latencyMs &&
      !conditions.jitterMs &&
      !conditions.lossRatio &&
      !queues.get(this)?.items.length
    ) {
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
    const nativeBuffered = buffered?.get ? buffered.get.call(this) : this.bufferedAmount;
    if (queue.bytes + nativeBuffered + bytes > 262144 || queue.items.length >= 4096)
      throw new DOMException('Simulated transport queue full', 'OperationError');
    const lost = random() < conditions.lossRatio;
    if (lost && this.maxRetransmits === 0) {
      droppedMessages++;
      return;
    }
    if (lost) retransmissions++;
    const jitter = (random() * 2 - 1) * conditions.jitterMs;
    // A message-level model, not packet-level SCTP emulation. Reliable loss
    // becomes a retransmission delay; unordered transient messages may overtake/drop.
    const now = performance.now();
    const due = Math.max(
      this.ordered === false ? 0 : (queue.items.at(-1)?.due ?? 0),
      now + Math.max(0, conditions.latencyMs + jitter) + (lost ? conditions.retransmitMs : 0),
    );
    queue.items.push({ due, data: copy, bytes });
    queue.items.sort((a, b) => a.due - b.due);
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
    clearTimeout(queue.timer);
    queue.timer = setTimeout(drain, Math.max(0, Math.ceil(queue.items[0].due - now)));
  } as typeof RTCDataChannel.prototype.send;
  Object.assign(window, {
    soyliNetworkLab: {
      read: () => ({
        ...conditions,
        delayedMessages,
        droppedMessages,
        retransmissions,
        binaryMessages,
        sentBytes,
        peakQueuedBytes,
        queuedBytes: [...queues.values()].reduce((sum, q) => sum + q.bytes, 0),
      }),
      set: (next: typeof initial) => {
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
          next.seed > 2147483647 ||
          (next.lossRatio !== undefined &&
            (!Number.isFinite(next.lossRatio) || next.lossRatio < 0 || next.lossRatio > 1)) ||
          (next.retransmitMs !== undefined &&
            (!Number.isInteger(next.retransmitMs) ||
              next.retransmitMs < 0 ||
              next.retransmitMs > 5000))
        )
          throw new Error('Invalid network conditions');
        conditions = { lossRatio: 0, retransmitMs: 200, ...next };
        randomState = next.seed;
      },
    },
  });
}
