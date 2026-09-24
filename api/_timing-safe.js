// Edge-runtime constant-time string comparison.
//
// node:crypto's timingSafeEqual is unavailable in the Edge Runtime, so we
// compare fixed-length HMAC-SHA256 digests of the two inputs (double-HMAC
// pattern). Because the digests are always 32 bytes, the comparison neither
// early-returns on a length mismatch nor short-circuits on the first differing
// character, so it leaks neither the length nor a matching prefix of the
// secret. Returns true iff a and b are byte-for-byte equal.
//
// Shared by every edge api/*.js handler that compares a caller-supplied value
// against an environment secret (api/cache-purge.js, api/wm-session.js). Edge
// bundling constraint: api/*.js cannot import from ../server or ../shared, so
// this lives under api/ as a sibling _*.js module.
export async function timingSafeEqual(a, b) {
  const encoder = new TextEncoder();
  const aBuf = encoder.encode(typeof a === 'string' ? a : String(a ?? ''));
  const bBuf = encoder.encode(typeof b === 'string' ? b : String(b ?? ''));
  // Random per-call key: works for any input length (importKey rejects a
  // zero-length key, so we cannot key on the inputs themselves) and keeps the
  // attacker from controlling the HMAC key.
  const rawKey = crypto.getRandomValues(new Uint8Array(32));
  const key = await crypto.subtle.importKey('raw', rawKey, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sigA = new Uint8Array(await crypto.subtle.sign('HMAC', key, aBuf));
  const sigB = new Uint8Array(await crypto.subtle.sign('HMAC', key, bBuf));
  let diff = sigA.length ^ sigB.length;
  for (let i = 0; i < sigA.length; i++) diff |= sigA[i] ^ sigB[i];
  return diff === 0;
}

export default timingSafeEqual;
