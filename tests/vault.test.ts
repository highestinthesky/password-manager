import { describe, it, expect } from "vitest";
import {
  deriveKey,
  encryptVault,
  decryptVault,
  keyForVault,
  newSalt,
  newEntryId,
  toBase64,
  fromBase64,
  type Entry,
} from "../src/vault";

// Low iteration count for fast tests — KDF correctness doesn't depend on count.
const TEST_ITERS = 1_000;

const entries: Entry[] = [
  {
    id: newEntryId(),
    title: "GitHub",
    username: "haolun.z",
    password: "correct horse battery staple",
    keywords: ["code", "git"],
  },
  {
    id: newEntryId(),
    title: "school portal",
    username: "hzhang26",
    password: "p@ssw0rd!",
    keywords: ["school"],
    notes: "security question: first pet = 'Mochi'",
  },
];

describe("base64 helpers", () => {
  it("round-trips arbitrary bytes", () => {
    const bytes = crypto.getRandomValues(new Uint8Array(64));
    expect(fromBase64(toBase64(bytes))).toEqual(bytes);
  });
});

describe("vault round-trip", () => {
  it("encrypts and decrypts entries intact", async () => {
    const salt = newSalt();
    const key = await deriveKey("master-pw", salt, TEST_ITERS);
    const vault = await encryptVault(entries, key, salt, TEST_ITERS);
    const out = await decryptVault(vault, key);
    expect(out).toEqual(entries);
  });

  it("round-trips unicode (emoji, CJK) in fields", async () => {
    const salt = newSalt();
    const key = await deriveKey("密码🔐", salt, TEST_ITERS);
    const e: Entry[] = [
      { id: newEntryId(), title: "微信", username: "宁", password: "🦄🌈", keywords: ["聊天"] },
    ];
    const vault = await encryptVault(e, key, salt, TEST_ITERS);
    expect(await decryptVault(vault, key)).toEqual(e);
  });

  it("re-derives the key from the vault's own KDF params", async () => {
    const salt = newSalt();
    const key = await deriveKey("master-pw", salt, TEST_ITERS);
    const vault = await encryptVault(entries, key, salt, TEST_ITERS);
    const key2 = await keyForVault(vault, "master-pw");
    expect(await decryptVault(vault, key2)).toEqual(entries);
  });

  it("handles an empty vault", async () => {
    const salt = newSalt();
    const key = await deriveKey("master-pw", salt, TEST_ITERS);
    const vault = await encryptVault([], key, salt, TEST_ITERS);
    expect(await decryptVault(vault, key)).toEqual([]);
  });
});

describe("wrong password / tampering", () => {
  it("fails cleanly with the wrong password", async () => {
    const salt = newSalt();
    const key = await deriveKey("right", salt, TEST_ITERS);
    const vault = await encryptVault(entries, key, salt, TEST_ITERS);
    const wrong = await keyForVault(vault, "wrong");
    await expect(decryptVault(vault, wrong)).rejects.toThrow();
  });

  it("fails if ciphertext is tampered with (GCM auth)", async () => {
    const salt = newSalt();
    const key = await deriveKey("master-pw", salt, TEST_ITERS);
    const vault = await encryptVault(entries, key, salt, TEST_ITERS);
    const bytes = fromBase64(vault.ciphertext);
    bytes[0]! ^= 0xff;
    vault.ciphertext = toBase64(bytes);
    await expect(decryptVault(vault, key)).rejects.toThrow();
  });
});

describe("nonce hygiene", () => {
  it("uses a fresh nonce on every encrypt", async () => {
    const salt = newSalt();
    const key = await deriveKey("master-pw", salt, TEST_ITERS);
    const v1 = await encryptVault(entries, key, salt, TEST_ITERS);
    const v2 = await encryptVault(entries, key, salt, TEST_ITERS);
    expect(v1.cipher.nonce).not.toEqual(v2.cipher.nonce);
    expect(v1.ciphertext).not.toEqual(v2.ciphertext);
  });
});

describe("vault file format", () => {
  it("records version, KDF params, and updatedAt", async () => {
    const salt = newSalt();
    const key = await deriveKey("master-pw", salt, TEST_ITERS);
    const before = Date.now();
    const vault = await encryptVault(entries, key, salt, TEST_ITERS);
    expect(vault.version).toBe(1);
    expect(vault.kdf.algo).toBe("PBKDF2-SHA256");
    expect(vault.kdf.iterations).toBe(TEST_ITERS);
    expect(vault.cipher.algo).toBe("AES-256-GCM");
    expect(vault.updatedAt).toBeGreaterThanOrEqual(before);
    // survives JSON round-trip (this is what gets stored/synced)
    const revived = JSON.parse(JSON.stringify(vault));
    expect(await decryptVault(revived, key)).toEqual(entries);
  });
});
