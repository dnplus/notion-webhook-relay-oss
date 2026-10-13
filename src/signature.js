// Notion signs the raw request body with HMAC-SHA256 keyed by the subscription's
// verification_token and sends `X-Notion-Signature: sha256=<hex>`.
// Delegate digest verification to WebCrypto instead of comparing it in JavaScript.
export async function verifySignature(body, token, signature) {
  if (!/^sha256=[a-f0-9]{64}$/i.test(signature ?? '')) return false;
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(token),
    { name: 'HMAC', hash: 'SHA-256' }, false, ['verify']);
  const hex = signature.slice(7);
  const digest = new Uint8Array(32);
  for (let i = 0; i < digest.length; i++) {
    digest[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return crypto.subtle.verify('HMAC', key, digest, body);
}
