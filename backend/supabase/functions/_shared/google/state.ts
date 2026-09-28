// =====================================================================
// Signs/verifies the OAuth "state" parameter so google-oauth-callback
// (a public endpoint hit by a browser redirect from Google, with no
// Authorization header available) can trust which student it's for
// without needing a session store. Reuses the project's existing
// INTERNAL_API_KEY secret as the HMAC signing key — no new secret needed.
// =====================================================================

function b64url(bytes: Uint8Array): string {
  let s = btoa(String.fromCharCode(...bytes));
  return s.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
function b64urlToBytes(s: string): Uint8Array {
  const pad = s.length % 4 === 0 ? "" : "=".repeat(4 - (s.length % 4));
  const b64 = s.replace(/-/g, "+").replace(/_/g, "/") + pad;
  const bin = atob(b64);
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
}

async function hmacKey(secret: string) {
  return crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]);
}

/** Signs {studentId, exp} into a compact "payload.sig" string good for `ttlSeconds`. */
export async function signState(studentId: string, secret: string, ttlSeconds = 600): Promise<string> {
  const payload = JSON.stringify({ sid: studentId, exp: Date.now() + ttlSeconds * 1000 });
  const payloadB64 = b64url(new TextEncoder().encode(payload));
  const key = await hmacKey(secret);
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(payloadB64));
  return `${payloadB64}.${b64url(new Uint8Array(sig))}`;
}

/** Verifies signature + expiry; returns the student id, or null if invalid/expired. */
export async function verifyState(state: string, secret: string): Promise<string | null> {
  const [payloadB64, sigB64] = (state || "").split(".");
  if (!payloadB64 || !sigB64) return null;
  try {
    const key = await hmacKey(secret);
    const valid = await crypto.subtle.verify("HMAC", key, b64urlToBytes(sigB64) as unknown as BufferSource, new TextEncoder().encode(payloadB64));
    if (!valid) return null;
    const { sid, exp } = JSON.parse(new TextDecoder().decode(b64urlToBytes(payloadB64)));
    if (typeof sid !== "string" || typeof exp !== "number" || Date.now() > exp) return null;
    return sid;
  } catch {
    return null;
  }
}
