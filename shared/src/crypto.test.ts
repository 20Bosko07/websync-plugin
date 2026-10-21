import { describe, expect, it } from "vitest";
import {
  blindContentHash,
  deriveKeysFromRootBits,
  deriveRootBits,
  deriveVaultKeys,
  encryptBytes,
  decryptBytes,
  encryptText,
  decryptText,
  fromBase64,
  generateSalt,
  generateInviteSecret,
  isInviteSecret,
  makeVerificationPayload,
  packBlob,
  toBase64,
  unpackBlob,
  unwrapRootBitsForMember,
  unwrapRootBitsFromInvite,
  verifyPassphrase,
  wrapRootBitsForInvite,
  wrapRootBitsForMember,
} from "./crypto";

const ITERATIONS = 10_000; // low for fast tests, prod uses PBKDF2_ITERATIONS_DEFAULT

describe("vault crypto", () => {
  it("derives the same keys for the same passphrase+salt+iterations", async () => {
    const salt = generateSalt();
    const a = await deriveVaultKeys("correct horse battery staple", salt, ITERATIONS);
    const b = await deriveVaultKeys("correct horse battery staple", salt, ITERATIONS);

    const plaintext = new TextEncoder().encode("hello vault");
    const encrypted = await encryptBytes(a.aesKey, plaintext);
    const decrypted = await decryptBytes(b.aesKey, encrypted.ciphertext, encrypted.iv);
    expect(new TextDecoder().decode(decrypted)).toBe("hello vault");
  });

  it("fails to decrypt with a key derived from the wrong passphrase", async () => {
    const salt = generateSalt();
    const good = await deriveVaultKeys("right passphrase", salt, ITERATIONS);
    const bad = await deriveVaultKeys("wrong passphrase", salt, ITERATIONS);

    const encrypted = await encryptText(good.aesKey, "secret note content");
    await expect(decryptText(bad.aesKey, encrypted.ciphertext, encrypted.iv)).rejects.toThrow();
  });

  it("round-trips text encryption for paths", async () => {
    const salt = generateSalt();
    const { aesKey } = await deriveVaultKeys("pw", salt, ITERATIONS);
    const encrypted = await encryptText(aesKey, "Folder/Sub Folder/Note.md");
    const decrypted = await decryptText(aesKey, encrypted.ciphertext, encrypted.iv);
    expect(decrypted).toBe("Folder/Sub Folder/Note.md");
  });

  it("packs and unpacks iv+ciphertext blobs losslessly", async () => {
    const salt = generateSalt();
    const { aesKey } = await deriveVaultKeys("pw", salt, ITERATIONS);
    const payload = await encryptBytes(aesKey, new TextEncoder().encode("file content"));
    const blob = packBlob(payload);
    const { iv, ciphertext } = unpackBlob(blob);
    const decrypted = await decryptBytes(aesKey, ciphertext, iv);
    expect(new TextDecoder().decode(decrypted)).toBe("file content");
    expect(iv).toEqual(payload.iv);
  });

  it("verifies a correct passphrase against a verification payload and rejects a wrong one", async () => {
    const salt = generateSalt();
    const vaultId = "11111111-1111-1111-1111-111111111111";
    const { aesKey: rightKey } = await deriveVaultKeys("right", salt, ITERATIONS);
    const { aesKey: wrongKey } = await deriveVaultKeys("wrong", salt, ITERATIONS);

    const payload = await makeVerificationPayload(rightKey, vaultId);
    expect(await verifyPassphrase(rightKey, vaultId, payload.ciphertext, payload.iv)).toBe(true);
    expect(await verifyPassphrase(wrongKey, vaultId, payload.ciphertext, payload.iv)).toBe(false);
  });

  it("produces a stable blinded content hash for identical content and a different one for different content", async () => {
    const salt = generateSalt();
    const { hmacKey } = await deriveVaultKeys("pw", salt, ITERATIONS);
    const h1 = await blindContentHash(hmacKey, new TextEncoder().encode("same content"));
    const h2 = await blindContentHash(hmacKey, new TextEncoder().encode("same content"));
    const h3 = await blindContentHash(hmacKey, new TextEncoder().encode("different content"));
    expect(toBase64(h1)).toBe(toBase64(h2));
    expect(toBase64(h1)).not.toBe(toBase64(h3));
  });

  it("base64 round-trips arbitrary bytes", () => {
    const bytes = crypto.getRandomValues(new Uint8Array(64));
    expect(fromBase64(toBase64(bytes))).toEqual(bytes);
  });
});

describe("vault sharing", () => {
  const vaultId = "11111111-1111-1111-1111-111111111111";
  const otherVaultId = "22222222-2222-2222-2222-222222222222";
  const userId = "33333333-3333-3333-3333-333333333333";

  it("derives the very same vault keys from root bits as deriveVaultKeys does", async () => {
    const salt = generateSalt();
    const rootBits = await deriveRootBits("owner passphrase", salt, ITERATIONS);
    const viaRoot = await deriveKeysFromRootBits(rootBits);
    const direct = await deriveVaultKeys("owner passphrase", salt, ITERATIONS);

    // What the owner encrypted, a friend holding only the root bits must be able to read (and vice versa).
    const sealed = await encryptText(direct.aesKey, "shared note");
    expect(await decryptText(viaRoot.aesKey, sealed.ciphertext, sealed.iv)).toBe("shared note");
    const data = new TextEncoder().encode("same content");
    expect(toBase64(await blindContentHash(viaRoot.hmacKey, data))).toBe(toBase64(await blindContentHash(direct.hmacKey, data)));
  });

  it("generates URL-safe, random invite secrets", () => {
    const a = generateInviteSecret();
    const b = generateInviteSecret();
    expect(a).toMatch(/^[A-Za-z0-9_-]{43}$/); // 32 bytes as base64url, so it can sit in a link fragment untouched
    expect(a).not.toBe(b);
    expect(isInviteSecret(a)).toBe(true);
    expect(isInviteSecret("short")).toBe(false);
    expect(isInviteSecret(`${a}#`)).toBe(false);
    expect(isInviteSecret(`${a} <b>`)).toBe(false);
  });

  it("hands the root bits over via an invite blob only to someone who has the secret", async () => {
    const rootBits = crypto.getRandomValues(new Uint8Array(32));
    const secret = generateInviteSecret();
    const blob = await wrapRootBitsForInvite(rootBits, secret, vaultId);

    expect(await unwrapRootBitsFromInvite(blob, secret, vaultId)).toEqual(rootBits);
    await expect(unwrapRootBitsFromInvite(blob, generateInviteSecret(), vaultId)).rejects.toThrow();
    // A blob made for one vault does not open as another vault (server swapping blobs around).
    await expect(unwrapRootBitsFromInvite(blob, secret, otherVaultId)).rejects.toThrow();
    // Not a well-formed secret at all: refused before any crypto happens.
    await expect(unwrapRootBitsFromInvite(blob, "nope", vaultId)).rejects.toThrow();
    await expect(wrapRootBitsForInvite(rootBits, "nope", vaultId)).rejects.toThrow();
  });

  it("detects a tampered invite blob", async () => {
    const rootBits = crypto.getRandomValues(new Uint8Array(32));
    const secret = generateInviteSecret();
    const blob = await wrapRootBitsForInvite(rootBits, secret, vaultId);
    const tampered = blob.slice();
    tampered[tampered.length - 1] ^= 1;
    await expect(unwrapRootBitsFromInvite(tampered, secret, vaultId)).rejects.toThrow();
  });

  it("does not put the root bits into the invite blob in the clear", async () => {
    const rootBits = crypto.getRandomValues(new Uint8Array(32));
    const blob = await wrapRootBitsForInvite(rootBits, generateInviteSecret(), vaultId);
    expect(toBase64(blob)).not.toContain(toBase64(rootBits));
    expect(blob.length).toBeGreaterThan(rootBits.length);
  });

  it("stores the member's key under their own passphrase, bound to vault and user", async () => {
    const rootBits = crypto.getRandomValues(new Uint8Array(32));
    const salt = generateSalt();
    const wrapped = await wrapRootBitsForMember(rootBits, "friend passphrase", salt, ITERATIONS, vaultId, userId);

    expect(await unwrapRootBitsForMember(wrapped, "friend passphrase", salt, ITERATIONS, vaultId, userId)).toEqual(rootBits);
    await expect(unwrapRootBitsForMember(wrapped, "wrong passphrase", salt, ITERATIONS, vaultId, userId)).rejects.toThrow();
    await expect(unwrapRootBitsForMember(wrapped, "friend passphrase", salt, ITERATIONS, otherVaultId, userId)).rejects.toThrow();
    await expect(
      unwrapRootBitsForMember(wrapped, "friend passphrase", salt, ITERATIONS, vaultId, "44444444-4444-4444-4444-444444444444"),
    ).rejects.toThrow();
  });
});
