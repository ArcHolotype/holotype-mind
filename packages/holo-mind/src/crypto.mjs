// AES-256-GCM encryption for Holo's private memory, using Web Crypto so the SAME
// code runs in Node (local prototype) and in Cloudflare Workers (production).
// The master key lives in a Secret (local keyfile now, Cloudflare Secret later) and
// is never committed, never sent to the frontend, never logged.
import { readFileSync } from "node:fs";

const enc = new TextEncoder();
const dec = new TextDecoder();
const b64 = {
  encode: (buf) => Buffer.from(buf).toString("base64"),
  decode: (s) => Uint8Array.from(Buffer.from(s, "base64")),
};

// Load the 32-byte master key (hex on disk) into a CryptoKey.
export async function loadMasterKey(keyfilePath) {
  const hex = readFileSync(keyfilePath, "utf8").trim();
  const raw = Uint8Array.from(Buffer.from(hex, "hex"));
  if (raw.length !== 32) throw new Error("master key must be 32 bytes (64 hex chars)");
  return crypto.subtle.importKey("raw", raw, { name: "AES-GCM" }, false, [
    "encrypt",
    "decrypt",
  ]);
}

// Encrypt plaintext -> "iv.ciphertext" (both base64), a single storable string.
export async function encrypt(key, plaintext) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv },
    key,
    enc.encode(String(plaintext)),
  );
  return `${b64.encode(iv)}.${b64.encode(ct)}`;
}

// Decrypt "iv.ciphertext" -> plaintext. Throws if the key is wrong or data tampered
// (GCM auth tag), so a leaked DB without the key is unreadable AND detectably so.
export async function decrypt(key, blob) {
  const [ivB64, ctB64] = String(blob).split(".");
  if (!ivB64 || !ctB64) throw new Error("malformed ciphertext blob");
  const pt = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: b64.decode(ivB64) },
    key,
    b64.decode(ctB64),
  );
  return dec.decode(pt);
}
