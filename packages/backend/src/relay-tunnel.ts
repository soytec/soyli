import { connect, createServer, type Socket } from 'node:net';
import { timingSafeEqual } from 'node:crypto';
import { RelayPool, type RelayOptions } from 'applesauce-relay';
import { publicLookup } from './blossom';
import { publicRelayUrl, loopbackRelayUrl } from '../../nostr/src/relay-policy';

/** A single-destination, authenticated loopback CONNECT tunnel. Bun performs TLS
 * for the original hostname; the TCP peer is pinned after guarded DNS resolution.
 * This avoids Bun's broken node:https WebSocket upgrade without weakening TLS. */
export async function relayTunnel(
  authority: string,
  address: string,
  port: number,
  signal: AbortSignal,
) {
  const password = crypto.randomUUID();
  const authorization = Buffer.from(`Basic ${Buffer.from(`relay:${password}`).toString('base64')}`);
  const sockets = new Set<Socket>();
  let accepted = false;
  const server = createServer((client) => {
    sockets.add(client);
    client.on('error', () => client.destroy());
    client.on('close', () => sockets.delete(client));
    if (accepted || signal.aborted) return client.destroy();
    let header = Buffer.alloc(0);
    client.setTimeout(3000, () => client.destroy());
    const handshake = (data: Buffer) => {
      header = Buffer.concat([header, data]);
      if (header.length > 4096) return client.destroy();
      const end = header.indexOf('\r\n\r\n');
      if (end < 0) return;
      client.removeListener('data', handshake);
      const [line, ...fields] = header.toString('latin1', 0, end).split('\r\n');
      const auth = fields.filter((s) => /^proxy-authorization:/i.test(s));
      const provided = Buffer.from(auth[0]?.split(':').slice(1).join(':').trim() ?? '');
      if (
        line !== `CONNECT ${authority} HTTP/1.1` ||
        auth.length !== 1 ||
        provided.length !== authorization.length ||
        !timingSafeEqual(provided, authorization)
      )
        return client.destroy();
      accepted = true;
      client.pause();
      const upstream = connect({ host: address, port });
      sockets.add(upstream);
      const stop = () => {
        client.destroy();
        upstream.destroy();
      };
      upstream.on('error', stop);
      upstream.on('close', () => {
        sockets.delete(upstream);
        client.destroy();
      });
      client.on('close', () => upstream.destroy());
      let bytes = 0;
      upstream.on('data', (data) => {
        if ((bytes += data.length) > 8 * 1024 ** 2) stop();
      });
      upstream.once('connect', () => {
        client.setTimeout(0);
        client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
        const remainder = header.subarray(end + 4);
        if (remainder.length) upstream.write(remainder);
        client.pipe(upstream);
        upstream.pipe(client);
        client.resume();
      });
    };
    client.on('data', handshake);
  });
  const close = () => {
    signal.removeEventListener('abort', close);
    sockets.forEach((socket) => socket.destroy());
    if (server.listening) server.close();
  };
  try {
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', resolve);
    });
    signal.addEventListener('abort', close, { once: true });
    if (signal.aborted) throw new Error('Relay read cancelled');
    const port = (server.address() as { port: number }).port;
    return { proxy: `http://relay:${password}@127.0.0.1:${port}`, close };
  } catch (error) {
    close();
    throw error;
  }
}

export async function openPlaybackRelay(value: string, signal: AbortSignal) {
  const url = new URL(value);
  if (url.protocol === 'ws:') {
    loopbackRelayUrl(value); // Only the preview's separately admitted exact local URL reaches here.
    return new RelayPool();
  }
  publicRelayUrl(value);
  if (typeof Bun === 'undefined') {
    const { PreviewWebSocket } = await import('./preview-relay');
    return new RelayPool({ WebSocket: PreviewWebSocket as unknown as RelayOptions['WebSocket'] });
  }
  const address = await new Promise<string>((resolve, reject) => {
    const stop = () => {
      cleanup();
      reject(new Error('Relay DNS cancelled'));
    };
    const timeout = setTimeout(stop, 3000);
    const cleanup = () => {
      clearTimeout(timeout);
      signal.removeEventListener('abort', stop);
    };
    signal.addEventListener('abort', stop, { once: true });
    if (signal.aborted) return stop();
    publicLookup(url.hostname.replace(/^\[|\]$/g, ''), {}, (error, ip) => {
      cleanup();
      error ? reject(error) : resolve(ip as string);
    });
  });
  if (signal.aborted) throw new Error('Relay read cancelled');
  const tunnel = await relayTunnel(`${url.hostname}:443`, address, 443, signal);
  const BunWebSocket = WebSocket as unknown as {
    new (url: string, options: Bun.WebSocketOptions): WebSocket;
  };
  class PinnedWebSocket extends BunWebSocket {
    constructor(target: string) {
      if (target !== url.href) throw new Error('Relay destination changed');
      super(target, { proxy: tunnel.proxy, perMessageDeflate: false });
    }
  }
  const pool = new RelayPool({ WebSocket: PinnedWebSocket as RelayOptions['WebSocket'] });
  const close = pool.close.bind(pool);
  pool.close = () => {
    close();
    tunnel.close();
  };
  return pool;
}
