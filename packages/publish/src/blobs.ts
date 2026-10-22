import { blossomAuthorization, readBounded, verifyBlob } from '../../blossom/src/client';
import type { CreatorSigner } from '../../identity/src/signer';

export async function ownedBlobs(
  origin: string,
  pubkey: string,
  signer: CreatorSigner,
  signal?: AbortSignal,
) {
  try {
    const response = await fetch(`${origin}/list/${pubkey}?limit=100`, {
      redirect: 'error',
      signal: AbortSignal.any([AbortSignal.timeout(8000), ...(signal ? [signal] : [])]),
      headers: { Authorization: await blossomAuthorization(signer, 'list', origin) },
    });
    if (!response.ok) {
      await response.body?.cancel();
      return new Set<string>();
    }
    const rows: unknown = JSON.parse(new TextDecoder().decode(await readBounded(response, 65536)));
    if (!Array.isArray(rows) || rows.length > 100) return new Set<string>();
    return new Set(
      rows.filter((r) => r && /^[a-f0-9]{64}$/.test(r.sha256)).map((r) => r.sha256 as string),
    );
  } catch {
    return new Set<string>();
  } // Unsupported listing means a verified, signed upload instead.
}
export async function verifiedBlob(
  origin: string,
  hash: string,
  length: number,
  signal?: AbortSignal,
) {
  try {
    return await verifyBlob(origin, hash, length, signal);
  } catch {
    return false;
  }
}
