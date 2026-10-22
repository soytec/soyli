import type { PeerDiagnostics } from '../../packages/runtime/src/webrtc-diagnostics';

export function setupDiagnostics(read: () => Promise<PeerDiagnostics[]>, signal: AbortSignal) {
  const details = document.querySelector<HTMLDetailsElement>('#connection-details')!;
  const output = document.querySelector<HTMLElement>('#connection-diagnostics')!;
  let previous = new Map<string, PeerDiagnostics>();
  let at = performance.now();
  let busy = false;
  const update = async () => {
    if (busy || signal.aborted || !details.open) return;
    busy = true;
    try {
      const rows = await read();
      if (signal.aborted) return;
      const now = performance.now(),
        seconds = Math.max((now - at) / 1000, 0.001);
      output.textContent = rows.length
        ? rows
            .map((row) => {
              const last = previous.get(`${row.session}:${row.peer}`);
              const rate = (field: 'bytesSent' | 'bytesReceived') =>
                last
                  ? `${(Math.max(0, row[field] - last[field]) / seconds / 1024).toFixed(1)} KiB/s`
                  : '—';
              return (
                `${row.peer.slice(0, 8)} · ${row.state} · ${row.route}\n` +
                `RTT ${row.rttMs === null ? '—' : row.rttMs.toFixed(0) + ' ms'} · queued ${row.bufferedBytes} B\n` +
                `↑ ${rate('bytesSent')} ↓ ${rate('bytesReceived')} · messages ${row.messagesSent}/${row.messagesReceived}`
              );
            })
            .join('\n\n')
        : 'No peer connections yet. Start or join a session inside the napplet.';
      previous = new Map(rows.map((row) => [`${row.session}:${row.peer}`, row]));
      at = now;
    } finally {
      busy = false;
    }
  };
  details.addEventListener(
    'toggle',
    () => {
      void update();
    },
    { signal },
  );
  const timer = setInterval(() => {
    void update();
  }, 1000);
  signal.addEventListener('abort', () => clearInterval(timer), { once: true });
}
