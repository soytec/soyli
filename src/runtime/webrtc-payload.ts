/** NAP-WEBRTC #145, decoded binary / UTF-8 JSON bytes, not base64 characters. */
export const WEBRTC_MAX_PAYLOAD = 16 * 1024;
export const WEBRTC_QUEUE_BYTES = 256 * 1024;
export const WEBRTC_QUEUE_MESSAGES = 256;

export function decodeWebrtcBytes(value: unknown): Uint8Array<ArrayBuffer> {
  if (typeof value !== 'string') throw new Error('invalid base64');
  if (value.length > 4 * Math.ceil(WEBRTC_MAX_PAYLOAD / 3))
    throw new Error('payload too large');
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value))
    throw new Error('invalid base64');
  const raw = atob(value);
  // The round trip also rejects non-zero unused pad bits.
  if (btoa(raw) !== value) throw new Error('invalid base64');
  if (raw.length > WEBRTC_MAX_PAYLOAD) throw new Error('payload too large');
  return Uint8Array.from(raw, (c) => c.charCodeAt(0));
}

export function encodeWebrtcBytes(value: ArrayBuffer): string {
  return btoa(String.fromCharCode(...new Uint8Array(value)));
}

export function encodeWebrtcJson(value: unknown) {
  const text = JSON.stringify(value);
  if (text === undefined) throw new Error('payload must be JSON');
  const bytes = new TextEncoder().encode(text).length;
  if (bytes > WEBRTC_MAX_PAYLOAD) throw new Error('payload too large');
  return { text, bytes };
}
