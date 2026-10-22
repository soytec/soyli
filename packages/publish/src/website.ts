import { encodeAddress } from '../../protocol/src';
import { validateManifest, validateRelease } from '../../protocol/src/manifest';
import { publicationReceiptSchema } from '../../protocol/src/publication';
import type { PublishJob } from './journal';

export type WebsiteCheck = {
  checkedAt: number;
  ready: boolean;
  reason: 'ready' | 'pending' | 'unavailable' | 'superseded';
};
export async function confirmWebsite(
  job: Pick<PublishJob, 'current' | 'snapshot'> & {
    plan: Pick<PublishJob['plan'], 'pubkey' | 'identifier' | 'artifactHash'> & {
      targets: Pick<PublishJob['plan']['targets'], 'site'>;
    };
  },
  options: {
    signal?: AbortSignal;
    timeoutMs?: number;
    wait?: boolean;
    fetch?: (url: URL, init: RequestInit) => Promise<Response>;
  } = {},
): Promise<WebsiteCheck> {
  const signal = AbortSignal.any([
    AbortSignal.timeout(options.timeoutMs ?? 45000),
    ...(options.signal ? [options.signal] : []),
  ]);
  const url = new URL('/api/publications', job.plan.targets.site);
  url.searchParams.set(
    'address',
    encodeAddress({ kind: 35129, pubkey: job.plan.pubkey, identifier: job.plan.identifier }),
  );
  url.searchParams.set('current', job.current!.id);
  if (job.snapshot) url.searchParams.set('snapshot', job.snapshot.id);
  let reason: WebsiteCheck['reason'] = 'unavailable';
  while (!signal.aborted) {
    try {
      const response = await (options.fetch ?? fetch)(url, {
        signal: AbortSignal.any([signal, AbortSignal.timeout(5000)]),
        redirect: 'error',
        cache: 'no-store',
      });
      // Old websites/foreign handlers must not be treated as an indexing queue.
      if (!response.ok || !response.body || Number(response.headers.get('content-length')) > 150000)
        break;
      const reader = response.body.getReader();
      let length = 0;
      const chunks: Uint8Array[] = [];
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          length += value.length;
          if (length > 150000) throw new Error('Website receipt exceeds limit');
          chunks.push(value);
        }
      } finally {
        await reader.cancel();
      }
      const receipt = publicationReceiptSchema.parse(
        JSON.parse(Buffer.concat(chunks).toString('utf8')),
      );
      if (Math.abs(Date.now() - receipt.checkedAt) > 60000) break;
      if (receipt.status === 'ready') {
        const release = job.snapshot
          ? await validateRelease(receipt.current, receipt.snapshot)
          : await validateManifest(receipt.current);
        const current = 'current' in release ? release.current : release.manifest;
        if (
          current.id !== job.current!.id ||
          (job.snapshot
            ? !('snapshot' in release) || release.snapshot.id !== job.snapshot.id
            : receipt.snapshot !== null) ||
          release.artifactHash !== job.plan.artifactHash ||
          receipt.artifactHash !== release.artifactHash
        )
          throw new Error('Website confirmed a different publication');
        return { checkedAt: Date.now(), ready: true, reason: 'ready' };
      }
      if (receipt.status === 'superseded') {
        reason = 'superseded';
        break;
      }
      reason = 'pending';
      if (options.wait === false) break;
      await new Promise<void>((resolve) => {
        if (signal.aborted) return resolve();
        const finish = () => {
          clearTimeout(timer);
          signal.removeEventListener('abort', finish);
          resolve();
        };
        const timer = setTimeout(finish, 1000);
        signal.addEventListener('abort', finish, { once: true });
      });
    } catch {
      break;
    }
  }
  return { checkedAt: Date.now(), ready: false, reason };
}
