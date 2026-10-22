import { request as httpsRequest } from 'node:https';
import { request as httpRequest } from 'node:http';
import { lookup } from 'node:dns';
import { isIP } from 'node:net';
import ipaddr from 'ipaddr.js';
import { ISOLATION } from './sandbox';
import { workerExchange } from './worker-process';
import { BackendError } from './contracts';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const publicIP = (address: string) => ipaddr.process(address).range() === 'unicast';
function requestBytes(
  url: URL,
  signal: AbortSignal,
  maximum: number,
  local: boolean,
  body?: string,
): Promise<Buffer> {
  const loopback =
    local && url.protocol === 'http:' && ['127.0.0.1', '[::1]'].includes(url.hostname);
  const host = url.hostname.replace(/^\[|\]$/g, '');
  if (!loopback && (url.protocol !== 'https:' || (isIP(host) && !publicIP(host))))
    throw new BackendError('FORBIDDEN', 'Backend source must resolve to public HTTPS addresses.');
  return new Promise((resolve, reject) => {
    const req = (loopback ? httpRequest : httpsRequest)(
      url,
      {
        signal,
        method: body ? 'POST' : 'GET',
        lookup(hostname, options, callback) {
          lookup(hostname, { all: true }, (error, addresses) => {
            if (error) return callback(error, '', 4);
            if (!addresses.length || addresses.some((a) => !publicIP(a.address)))
              return callback(new Error('Private source destination refused'), '', 4);
            if (options.all) callback(null, addresses);
            else callback(null, addresses[0].address, addresses[0].family);
          });
        },
        headers: {
          'User-Agent': 'soy-backend-builder/1',
          'Accept-Encoding': 'identity',
          ...(body
            ? {
                'Content-Type': 'application/x-git-upload-pack-request',
                'Content-Length': Buffer.byteLength(body),
              }
            : {}),
        },
      },
      (response) => {
        const expected = body
          ? 'application/x-git-upload-pack-result'
          : 'application/x-git-upload-pack-advertisement';
        if (
          response.statusCode !== 200 ||
          response.headers['content-type']?.split(';')[0] !== expected ||
          Number(response.headers['content-length']) > maximum
        ) {
          response.destroy();
          reject(
            new BackendError(
              'BUILD_FAILED',
              `Git source response refused (HTTP ${response.statusCode}); expected bounded smart HTTP. Redirects are not followed.`,
            ),
          );
          return;
        }
        const chunks: Buffer[] = [];
        let length = 0;
        response.on('data', (chunk: Buffer) => {
          length += chunk.length;
          if (length > maximum)
            response.destroy(new Error(`Git source exceeds ${maximum} downloaded bytes.`));
          else chunks.push(chunk);
        });
        response.on('error', reject);
        response.on('end', () => resolve(Buffer.concat(chunks, length)));
      },
    );
    req.on('error', reject);
    req.end(body);
  });
}
export function packet(text: string) {
  return (Buffer.byteLength(text) + 4).toString(16).padStart(4, '0') + text;
}
export function packetLines(bytes: Buffer) {
  const lines: string[] = [];
  let offset = 0;
  while (offset < bytes.length && bytes.subarray(offset, offset + 4).toString() !== 'PACK') {
    const prefix = bytes.subarray(offset, offset + 4).toString();
    if (!/^[a-f0-9]{4}$/i.test(prefix)) throw new Error('Malformed Git response packet.');
    const size = parseInt(prefix, 16);
    if (size === 0) {
      offset += 4;
      continue;
    }
    if (size < 4 || offset + size > bytes.length) throw new Error('Truncated Git response packet.');
    lines.push(bytes.subarray(offset + 4, offset + size).toString());
    offset += size;
  }
  return { lines, offset };
}
export async function downloadPackNative(url: URL, commit: string, local = false) {
  const signal = AbortSignal.timeout(ISOLATION.sourceDeadlineMs);
  const discovery = await requestBytes(
    new URL(url.href + '/info/refs?service=git-upload-pack'),
    signal,
    1024 * 1024,
    local,
  );
  const { lines } = packetLines(discovery);
  if (lines[0] !== '# service=git-upload-pack\n')
    throw new Error('Git source is not a smart HTTP upload-pack service.');
  const caps = (lines.find((line) => line.includes('\0'))?.split('\0')[1] ?? '').trim().split(' ');
  if (
    !lines.some((line) => line.startsWith(commit + ' ')) &&
    !caps.includes('allow-reachable-sha1-in-want') &&
    !caps.includes('allow-tip-sha1-in-want')
  )
    throw new Error(
      'Requested commit is not advertised by Git. Push that commit or a ref to it before building.',
    );
  const request =
    packet(`want ${commit}${caps.includes('ofs-delta') ? ' ofs-delta' : ''}\n`) +
    '0000' +
    packet('done\n');
  const bytes = await requestBytes(
    new URL(url.href + '/git-upload-pack'),
    signal,
    ISOLATION.sourcePackBytes,
    local,
    request,
  );
  const response = packetLines(bytes);
  if (response.lines.some((line) => line.startsWith('ERR ')))
    throw new Error(response.lines.join(' ').slice(0, 512));
  if (bytes.subarray(response.offset, response.offset + 4).toString() !== 'PACK')
    throw new Error('Git source returned no pack for the requested commit.');
  return bytes.subarray(response.offset);
}
export async function downloadPack(url: URL, commit: string, local: boolean) {
  // The deployed baseline Bun loses SNI with guarded DNS lookup. Use the same policy in Node.
  if (typeof Bun !== 'undefined' && Bun.version === '1.3.8' && !local) {
    const directory = process.env.SPACE_DYNAMIC_BUNDLE_DIR;
    if (!directory)
      throw new Error('Configure the prebuilt backend HTTPS worker for the baseline runtime.');
    const value = await workerExchange(
      ['/usr/bin/node', join(directory, 'source-http.js')],
      { url: url.href, commit },
      {
        maximum: ISOLATION.sourcePackBytes * 2,
        timeoutMs: ISOLATION.sourceDeadlineMs + 1000,
      },
    );
    return Buffer.from(String(value), 'base64');
  }
  return downloadPackNative(url, commit, local);
}
if (
  typeof Bun === 'undefined' &&
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  let input = '';
  for await (const chunk of process.stdin) {
    input += chunk;
    if (input.length > 4096) throw new Error('Source request too large');
  }
  try {
    const { url, commit } = JSON.parse(input);
    if (!/^[a-f0-9]{40}$/.test(commit)) throw new Error('Invalid Git commit');
    const pack = await downloadPackNative(new URL(url), commit);
    process.stdout.write(JSON.stringify({ type: 'result', value: pack.toString('base64') }) + '\n');
  } catch (error) {
    process.stdout.write(
      JSON.stringify({ type: 'failure', message: String(error).slice(0, 512) }) + '\n',
    );
  }
}
