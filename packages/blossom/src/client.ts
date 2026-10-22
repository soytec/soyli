import { DiagnosticError, diagnose } from '../../diagnostics/src';
import type { EventTemplate } from 'nostr-tools';
import { CLIENT_TIMEOUTS, transferDeadline, type TransferDeadline } from './transfer';
import { sha256, verifiedEvent, type SignedEvent } from '../../protocol/src';
import {
  blossomOrigin,
  HASH,
  MAX_BLOB_BYTES,
  type BlobDescriptor,
  type BlossomAction,
} from './protocol';

export type BlossomSigner = { signEvent(event: EventTemplate): Promise<SignedEvent> | SignedEvent };
export async function blossomAuthorization(
  signer: BlossomSigner,
  action: BlossomAction,
  origin: string,
  hash?: string,
) {
  const now = Math.floor(Date.now() / 1000);
  if (hash !== undefined && !HASH.test(hash)) throw new Error('Invalid blob hash');
  const template: EventTemplate = {
    kind: 24242,
    created_at: now - 1,
    content: `${action === 'upload' ? 'Upload' : action === 'delete' ? 'Delete' : 'List'} ${hash ? `blob ${hash}` : 'my blobs'} on ${new URL(origin).hostname}`,
    tags: [
      ['t', action],
      ['expiration', String(now + 300)],
      ['server', new URL(origin).hostname],
      ...(hash ? [['x', hash]] : []),
    ],
  };
  const event = verifiedEvent(await signer.signEvent(template));
  if (
    event.kind !== template.kind ||
    event.created_at !== template.created_at ||
    event.content !== template.content ||
    JSON.stringify(event.tags) !== JSON.stringify(template.tags)
  )
    throw new Error('Signer changed the requested Blossom authorization');
  return `Nostr ${Buffer.from(JSON.stringify(event)).toString('base64url')}`;
}
/** Shared uploader for CLI publication and local seeds. It verifies the returned descriptor AND bytes. */
export async function uploadBlob(input: {
  origin: string;
  bytes: Uint8Array;
  type: string;
  signer: BlossomSigner;
  local?: boolean;
  signal?: AbortSignal;
  timeouts?: Partial<typeof CLIENT_TIMEOUTS>;
}) {
  const origin = blossomOrigin(input.origin, input.local);
  if (input.bytes.byteLength > MAX_BLOB_BYTES) throw new Error('Blob exceeds upload limit');
  const hash = await sha256(input.bytes);
  const authorization = await blossomAuthorization(input.signer, 'upload', origin, hash);
  const timeouts = { ...CLIENT_TIMEOUTS, ...input.timeouts };
  const upload = transferDeadline({
    totalMs: timeouts.uploadMs,
    signal: input.signal,
    label: 'Blossom upload',
  });
  let response: Response | undefined;
  let result: BlobDescriptor;
  try {
    response = await upload.wait(
      fetch(`${origin}/upload`, {
        method: 'PUT',
        redirect: 'error',
        signal: upload.signal,
        headers: { Authorization: authorization, 'Content-Type': input.type, 'X-SHA-256': hash },
        body: input.bytes as Uint8Array<ArrayBuffer>,
      }),
    );
    if (![200, 201].includes(response.status))
      throw new DiagnosticError('BLOSSOM_REFUSED', `Blossom upload refused (${response.status}).`, {
        operation: 'upload Blossom blob',
        target: origin,
        status: response.status,
        detail: response.headers.get('x-reason') ?? undefined,
        recovery: 'Check the server upload policy, size limit and authorization before retrying.',
      });
    if (Number(response.headers.get('content-length')) > 4096)
      throw new Error('Blossom descriptor exceeds limit');
    // Once upload headers arrive, the small descriptor gets its own bounded read.
    const descriptor = transferDeadline({
      totalMs: timeouts.idleMs,
      signal: upload.signal,
      label: 'Blossom upload response',
    });
    try {
      const text = await readBounded(response, 4096, descriptor);
      result = JSON.parse(new TextDecoder().decode(text)) as BlobDescriptor;
    } finally {
      descriptor.close();
    }
    const url = new URL(result.url);
    if (
      result.sha256 !== hash ||
      result.size !== input.bytes.byteLength ||
      typeof result.type !== 'string' ||
      !Number.isSafeInteger(result.uploaded) ||
      result.uploaded < 0 ||
      url.username ||
      url.password ||
      (url.protocol !== 'https:' &&
        !(
          input.local &&
          url.protocol === 'http:' &&
          ['127.0.0.1', '[::1]'].includes(url.hostname)
        )) ||
      url.search ||
      url.hash ||
      !new RegExp(`^/${hash}\\.[a-z0-9]+$`).test(url.pathname)
    )
      throw new Error('Blossom returned an inconsistent descriptor');
  } catch (error) {
    const cause = upload.signal.aborted ? upload.signal.reason : error;
    if (cause instanceof DiagnosticError) throw cause;
    throw new DiagnosticError('BLOSSOM_UPLOAD', diagnose(cause).message, {
      operation: 'upload Blossom blob',
      target: origin,
      cause,
    });
  } finally {
    upload.close();
    await response?.body?.cancel().catch(() => {});
  }
  // Upload and independent verification do not spend the same timeout budget.
  if (!(await verifyBlob(origin, hash, input.bytes.byteLength, input.signal, timeouts)))
    throw new Error('Uploaded blob could not be independently hash-verified');
  return { descriptor: result, created: response.status === 201 };
}

/** Used after upload and when resuming an already uploaded publication. */
export async function verifyBlob(
  origin: string,
  hash: string,
  length: number,
  signal?: AbortSignal,
  timeouts: Partial<Pick<typeof CLIENT_TIMEOUTS, 'verificationMs' | 'idleMs'>> = {},
) {
  const policy = { ...CLIENT_TIMEOUTS, ...timeouts };
  const deadline = transferDeadline({
    totalMs: policy.verificationMs,
    idleMs: policy.idleMs,
    signal,
    label: 'Blossom verification download',
  });
  let response: Response | undefined;
  try {
    response = await deadline.wait(
      fetch(`${origin}/${hash}`, { redirect: 'error', signal: deadline.signal }),
    );
    if (!response.ok || Number(response.headers.get('content-length')) > length) return false;
    const bytes = await readBounded(response, length, deadline);
    return bytes.length === length && (await sha256(bytes)) === hash;
  } catch (error) {
    if (deadline.signal.aborted) throw deadline.signal.reason;
    throw error;
  } finally {
    deadline.close();
    await response?.body?.cancel().catch(() => {});
  }
}

export async function readBounded(response: Response, limit: number, deadline?: TransferDeadline) {
  if (!response.body) return new Uint8Array();
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const part = await (deadline ? deadline.wait(reader.read()) : reader.read());
      deadline?.signal.throwIfAborted();
      if (part.done) break;
      if (part.value.byteLength) deadline?.progress();
      size += part.value.byteLength;
      if (size > limit) throw new Error('Response exceeds byte limit');
      chunks.push(part.value);
    }
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}
