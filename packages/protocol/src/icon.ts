import { sha256, type SignedEvent } from './index';
import { manifestIcon, type ManifestIcon } from './manifest';

export const MAX_ICON_BYTES = 5 * 1024 * 1024;
export const MAX_ICON_PIXELS = 16_000_000;

/** Only declared origins supply an icon. Other configured stores are not implicit fallbacks. */
export function iconSources(event: Pick<SignedEvent, 'tags'>) {
  const icon = manifestIcon(event);
  if (!icon) return [];
  return [
    ...new Set(
      event.tags
        .filter((t) => t[0] === 'server')
        .flatMap((t) => {
          try {
            const u = new URL(t[1]);
            if (
              !['https:', 'http:'].includes(u.protocol) ||
              u.username ||
              u.password ||
              u.pathname !== '/' ||
              u.search ||
              u.hash
            )
              return [];
            return [`${u.origin}/${icon.hash}`];
          } catch {
            return [];
          }
        }),
    ),
  ].slice(0, 8);
}

export function iconMime(bytes: Uint8Array): ManifestIcon['mime'] | null {
  if (bytes.length >= 8 && [137, 80, 78, 71, 13, 10, 26, 10].every((n, i) => bytes[i] === n))
    return 'image/png';
  if (bytes.length >= 3 && bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255)
    return 'image/jpeg';
  if (
    bytes.length >= 12 &&
    new TextDecoder().decode(bytes.subarray(0, 4)) === 'RIFF' &&
    new TextDecoder().decode(bytes.subarray(8, 12)) === 'WEBP'
  )
    return 'image/webp';
  return null;
}

/** Inspect bounded format headers before an image decoder can allocate a pixel buffer. */
export function iconDimensions(bytes: Uint8Array): { width: number; height: number } {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const ascii = (start: number, length: number) =>
    String.fromCharCode(...bytes.subarray(start, start + length));
  const bounded = (width: number, height: number) => {
    if (!width || !height || width * height > MAX_ICON_PIXELS)
      throw new Error('Icon dimensions exceed the presentation budget');
    return { width, height };
  };
  switch (iconMime(bytes)) {
    case 'image/png':
      if (bytes.length >= 33 && view.getUint32(8) === 13 && ascii(12, 4) === 'IHDR')
        return bounded(view.getUint32(16), view.getUint32(20));
      break;
    case 'image/jpeg': {
      let offset = 2;
      while (offset < bytes.length) {
        if (bytes[offset++] !== 0xff) break;
        while (bytes[offset] === 0xff) offset++;
        const marker = bytes[offset++];
        // A frame header must precede image data. Never scan compressed data as header bytes.
        if (marker === undefined || marker === 0xda || marker === 0xd9 || marker === 0x00) break;
        if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue;
        if (offset + 2 > bytes.length) break;
        const length = view.getUint16(offset);
        if (length < 2 || offset + length > bytes.length) break;
        if (
          [0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf].includes(
            marker,
          )
        ) {
          if (length < 8) break;
          return bounded(view.getUint16(offset + 5), view.getUint16(offset + 3));
        }
        offset += length;
      }
      break;
    }
    case 'image/webp': {
      if (bytes.length < 20 || view.getUint32(4, true) !== bytes.length - 8) break;
      let offset = 12;
      while (offset + 8 <= bytes.length) {
        const type = ascii(offset, 4);
        const length = view.getUint32(offset + 4, true);
        const data = offset + 8;
        if (data + length > bytes.length) break;
        if (type === 'VP8X' && length === 10) {
          const uint24 = (at: number) => bytes[at] | (bytes[at + 1] << 8) | (bytes[at + 2] << 16);
          return bounded(uint24(data + 4) + 1, uint24(data + 7) + 1);
        }
        if (
          type === 'VP8 ' &&
          length >= 10 &&
          (bytes[data] & 1) === 0 &&
          bytes[data + 3] === 0x9d &&
          bytes[data + 4] === 0x01 &&
          bytes[data + 5] === 0x2a
        )
          return bounded(
            view.getUint16(data + 6, true) & 0x3fff,
            view.getUint16(data + 8, true) & 0x3fff,
          );
        if (type === 'VP8L' && length >= 5 && bytes[data] === 0x2f) {
          const dimensions = view.getUint32(data + 1, true);
          return bounded((dimensions & 0x3fff) + 1, ((dimensions >>> 14) & 0x3fff) + 1);
        }
        offset = data + length + (length % 2);
      }
      break;
    }
  }
  throw new Error('Invalid manifest icon dimensions');
}

/** A decoder must also succeed before rendering; a matching MIME header alone is insufficient. */
export async function verifyIconBytes(bytes: Uint8Array, claim: ManifestIcon) {
  if (
    !bytes.length ||
    bytes.length > MAX_ICON_BYTES ||
    iconMime(bytes) !== claim.mime ||
    (await sha256(bytes)) !== claim.hash
  )
    throw new Error('Invalid manifest icon bytes');
  return iconDimensions(bytes);
}
