const isNode =
  typeof process !== 'undefined' &&
  process.versions != null &&
  typeof process.versions.node === 'string';

export async function hmacSha256(
  key: Uint8Array,
  message: Uint8Array,
): Promise<Uint8Array> {
  if (isNode) {
    // Dynamic import keeps node:crypto out of browser bundles that tree-shake the false branch.
    const { createHmac } = await import('node:crypto');
    const h = createHmac('sha256', Buffer.from(key));
    h.update(Buffer.from(message));
    return new Uint8Array(h.digest());
  }
  const subtle = globalThis.crypto.subtle;
  const imported = await subtle.importKey(
    'raw',
    key as BufferSource,
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const sig = await subtle.sign('HMAC', imported, message as BufferSource);
  return new Uint8Array(sig);
}

export async function sha256(message: Uint8Array): Promise<Uint8Array> {
  if (isNode) {
    const { createHash } = await import('node:crypto');
    const h = createHash('sha256');
    h.update(Buffer.from(message));
    return new Uint8Array(h.digest());
  }
  const digest = await globalThis.crypto.subtle.digest(
    'SHA-256',
    message as BufferSource,
  );
  return new Uint8Array(digest);
}

export function bytesToHex(bytes: Uint8Array): string {
  let hex = '';
  for (let i = 0; i < bytes.length; i++) {
    hex += bytes[i].toString(16).padStart(2, '0');
  }
  return hex;
}
