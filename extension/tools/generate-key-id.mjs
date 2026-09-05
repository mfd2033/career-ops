// Generate an RSA key pair and derive the stable Chrome MV3 extension ID from
// the PUBLIC key (SPKI DER). Chrome's extension ID = first 128 bits of
// SHA-256 over the SPKI DER, hex-mapped onto the alphabet a-p.
//
// Usage: node extension/tools/generate-key-id.mjs
// Prints: manifest `key` (base64 SPKI DER) + the derived chrome-extension:// id.
// Run ONCE; bake the output into extension/manifest.json and the web backend's
// extension-origin constant. Re-running changes the ID — never regenerate after
// the backend whitelist is in place.
import { generateKeyPairSync, createHash } from "node:crypto";

const ALPHABET = "abcdefghijklmnop"; // 0→a, 15→p

function deriveExtensionId(spkiDer) {
  const digest = createHash("sha256").update(spkiDer).digest();
  let id = "";
  for (let i = 0; i < 16; i++) {
    const b = digest[i];
    id += ALPHABET[b >> 4] + ALPHABET[b & 0x0f];
  }
  return id; // 32 chars, all in a-p
}

const { publicKey } = generateKeyPairSync("rsa", {
  modulusLength: 2048,
  publicKeyEncoding: { type: "spki", format: "der" },
});
// publicKey is the SPKI DER as a Buffer (Node 22+) or Uint8Array.
const der = Buffer.from(publicKey.buffer, publicKey.byteOffset, publicKey.byteLength);
const keyB64 = der.toString("base64");
const id = deriveExtensionId(der);

console.log("KEY (manifest.json \"key\"):");
console.log(keyB64);
console.log("EXTENSION ID (chrome-extension://id):");
console.log(id);