/**
 * vault.ts — crypto core. Pure functions, zero DOM dependencies.
 *
 * Design (per blueprint):
 * - PBKDF2-SHA256, 600k iterations (the brute-force wall)
 * - AES-256-GCM, fresh random nonce on EVERY encrypt (never reuse with GCM)
 * - One encrypted blob; titles/keywords are secret too
 * - Wrong password === failed GCM auth — no password hash is ever stored
 */

export interface Entry {
  id: string;
  title: string;
  username: string;
  password: string;
  keywords: string[];
  notes?: string;
}

export interface VaultFile {
  version: 1;
  kdf: { algo: "PBKDF2-SHA256"; iterations: number; salt: string };
  cipher: { algo: "AES-256-GCM"; nonce: string };
  ciphertext: string;
  updatedAt: number; // ms epoch — last-write-wins sync key
}

export const KDF_ITERATIONS = 600_000;

// --- base64 helpers -------------------------------------------------------

export function toBase64(bytes: Uint8Array): string {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}

export function fromBase64(s: string): Uint8Array {
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

// --- key derivation -------------------------------------------------------

export async function deriveKey(
  masterPassword: string,
  salt: Uint8Array,
  iterations: number = KDF_ITERATIONS,
): Promise<CryptoKey> {
  const material = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(masterPassword),
    "PBKDF2",
    false,
    ["deriveKey"],
  );
  return crypto.subtle.deriveKey(
    { name: "PBKDF2", hash: "SHA-256", salt: salt as BufferSource, iterations },
    material,
    { name: "AES-GCM", length: 256 },
    false, // non-extractable
    ["encrypt", "decrypt"],
  );
}

// --- vault operations -----------------------------------------------------

export function newSalt(): Uint8Array {
  return crypto.getRandomValues(new Uint8Array(16));
}

/** Serialize + encrypt entries into a complete VaultFile. Fresh nonce every call. */
export async function encryptVault(
  entries: Entry[],
  key: CryptoKey,
  salt: Uint8Array,
  iterations: number = KDF_ITERATIONS,
): Promise<VaultFile> {
  const nonce = crypto.getRandomValues(new Uint8Array(12));
  const plaintext = new TextEncoder().encode(JSON.stringify(entries));
  const ct = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv: nonce as BufferSource },
    key,
    plaintext as BufferSource,
  );
  return {
    version: 1,
    kdf: { algo: "PBKDF2-SHA256", iterations, salt: toBase64(salt) },
    cipher: { algo: "AES-256-GCM", nonce: toBase64(nonce) },
    ciphertext: toBase64(new Uint8Array(ct)),
    updatedAt: Date.now(),
  };
}

/**
 * Decrypt a VaultFile. Throws on wrong key (GCM auth failure) —
 * "is the password correct?" and "decrypt" are the same operation.
 */
export async function decryptVault(
  vault: VaultFile,
  key: CryptoKey,
): Promise<Entry[]> {
  const nonce = fromBase64(vault.cipher.nonce);
  const ct = fromBase64(vault.ciphertext);
  const pt = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: nonce as BufferSource },
    key,
    ct as BufferSource,
  );
  return JSON.parse(new TextDecoder().decode(pt)) as Entry[];
}

/** Convenience: derive key from password using the vault's own KDF params. */
export async function keyForVault(
  vault: VaultFile,
  masterPassword: string,
): Promise<CryptoKey> {
  return deriveKey(masterPassword, fromBase64(vault.kdf.salt), vault.kdf.iterations);
}

export function newEntryId(): string {
  return crypto.randomUUID();
}
