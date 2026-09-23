// AES-256-GCM for the private memory, using Web Crypto (crypto.subtle) so the SAME
// code runs locally and in workerd. Blobs are stored as hex(iv).hex(ciphertext+tag)
// to avoid any Buffer/base64 runtime assumptions. The master key lives in a Secret and
// is never committed, never sent to a client, never logged.

const enc = new TextEncoder();
const dec = new TextDecoder();

function toHex(buf: ArrayBuffer | Uint8Array): string {
  const b = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  let s = "";
  for (let i = 0; i < b.length; i++) s += b[i].toString(16).padStart(2, "0");
  return s;
}

function fromHex(hex: string): Uint8Array {
  const clean = hex.trim();
  if (clean.length % 2 !== 0) throw new Error("malformed hex string");
  const out = new Uint8Array(clean.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  return out;
}

// Import the 32-byte master key (64 hex chars on disk / in the Secret).
export async function loadMasterKey(hex: string): Promise<CryptoKey> {
  const raw = fromHex(hex);
  if (raw.length !== 32) throw new Error("master key must be 32 bytes (64 hex chars)");
  return crypto.subtle.importKey("raw", raw, { name: "AES-GCM" }, false, [
    "encrypt",
    "decrypt",
  ]);
}

// Encrypt plaintext -> "hex(iv).hex(ct)" with a fresh random 12-byte IV.
export async function encrypt(key: CryptoKey, plaintext: string): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, enc.encode(String(plaintext)));
  return `${toHex(iv)}.${toHex(ct)}`;
}

// Decrypt "hex(iv).hex(ct)" -> plaintext. Throws if the key is wrong or data was
// tampered with (GCM auth tag), so a leaked DB without the key is unreadable AND
// detectably so.
export async function decrypt(key: CryptoKey, blob: string): Promise<string> {
  const [ivHex, ctHex] = String(blob).split(".");
  if (!ivHex || !ctHex) throw new Error("malformed ciphertext blob");
  const pt = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: fromHex(ivHex) },
    key,
    fromHex(ctHex),
  );
  return dec.decode(pt);
}

// Constant-time-ish string compare for the admin token (avoids trivial timing leaks).
export function safeEqual(a: string, b: string): boolean {
  if (typeof a !== "string" || typeof b !== "string") return false;
  const ab = enc.encode(a);
  const bb = enc.encode(b);
  if (ab.length !== bb.length) return false;
  let diff = 0;
  for (let i = 0; i < ab.length; i++) diff |= ab[i] ^ bb[i];
  return diff === 0;
}
