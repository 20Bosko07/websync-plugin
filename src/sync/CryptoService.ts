import { t } from "../i18n/index.js";
import {
  blindContentHash,
  decryptBytes,
  decryptText,
  deriveVaultKeys,
  derivePublishKey,
  encryptBytes,
  encryptText,
  fromBase64,
  makeVerificationPayload,
  toBase64,
  unwrapRootBitsForMember,
  verifyPassphrase,
  type VaultKeyBundle,
  type VaultMemberKey,
} from "@websync/shared";

const textEncoder = new TextEncoder();

/**
 * These two `info` strings MUST stay byte-for-byte identical to the ones
 * inside `@websync/shared`'s `deriveVaultKeys` (packages/shared/src/crypto.ts).
 * See the big comment on `deriveKeysFromRootBits` below for why they're
 * duplicated here instead of imported.
 */
const HKDF_AES_INFO = "websync-aes-gcm-content-v1";
const HKDF_HMAC_INFO = "websync-content-hash-hmac-v1";

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

/**
 * Re-implements the PBKDF2 half of shared's `deriveVaultKeys`, but returns
 * the raw intermediate "root bits" instead of continuing on to derive
 * non-extractable CryptoKeys from them.
 *
 * Why this exists ("remember key on this device"): `deriveVaultKeys` in
 * shared/crypto.ts calls `crypto.subtle.deriveKey(..., extractable: false,
 * ...)`, so the AES/HMAC CryptoKeys it returns can never be exported or
 * serialized - by design, so a normal caller can't accidentally leak them.
 * That's fine for the RAM-only default, but the plan calls for an opt-in
 * "remember the derived key in data.json" setting so the user isn't asked
 * for their passphrase on every Obsidian restart. Since we can't export a
 * non-extractable CryptoKey, and shared doesn't expose a "give me the raw
 * root bits" helper (deliberately, to keep that plain function safe by
 * default), we duplicate just the PBKDF2 step here to get bytes we CAN
 * cache. PBKDF2's `deriveBits` (as opposed to `deriveKey`) always returns a
 * plain ArrayBuffer, extractable or not - there is no non-extractable
 * variant of deriveBits.
 *
 * The returned bits are one HKDF step away from the actual AES/HMAC vault
 * keys - treat them as sensitive as the passphrase itself. Only used for the
 * opt-in caching path.
 */
async function deriveRootBits(passphrase: string, salt: Uint8Array, iterations: number): Promise<Uint8Array> {
  const passphraseKey = await crypto.subtle.importKey(
    "raw",
    textEncoder.encode(passphrase.normalize("NFKC")),
    "PBKDF2",
    false,
    ["deriveBits"],
  );
  const rootBits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", salt: toArrayBuffer(salt), iterations, hash: "SHA-256" },
    passphraseKey,
    256,
  );
  return new Uint8Array(rootBits);
}

/**
 * Re-implements the HKDF half of shared's `deriveVaultKeys`: takes root bits
 * (either freshly derived via `deriveRootBits`, or read back from the cached
 * `data.json` value) and derives the same non-extractable AES-GCM/HMAC
 * CryptoKey pair `deriveVaultKeys` would have produced from the same
 * passphrase+salt+iterations. This is what lets the cached path skip the
 * expensive (210k-iteration) PBKDF2 step on every plugin startup.
 */
async function deriveKeysFromRootBits(rootBits: Uint8Array): Promise<VaultKeyBundle> {
  const hkdfKey = await crypto.subtle.importKey("raw", toArrayBuffer(rootBits), "HKDF", false, ["deriveKey"]);

  const aesKey = await crypto.subtle.deriveKey(
    { name: "HKDF", hash: "SHA-256", salt: new Uint8Array(0), info: textEncoder.encode(HKDF_AES_INFO) },
    hkdfKey,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );

  const hmacKey = await crypto.subtle.deriveKey(
    { name: "HKDF", hash: "SHA-256", salt: new Uint8Array(0), info: textEncoder.encode(HKDF_HMAC_INFO) },
    hkdfKey,
    { name: "HMAC", hash: "SHA-256", length: 256 },
    false,
    ["sign"],
  );

  return { aesKey, hmacKey };
}

/**
 * Holds the current vault's derived CryptoKey bundle in memory (RAM-only,
 * unless "remember key" is enabled - see the module-level comments above)
 * and exposes the encrypt/decrypt/hash operations the rest of the plugin
 * needs. Nothing outside this class ever sees a raw AES/HMAC CryptoKey.
 */
export class CryptoService {
  private keys: VaultKeyBundle | null = null;

  isUnlocked(): boolean {
    return this.keys !== null;
  }

  lock(): void {
    this.keys = null;
  }

  /** Normal unlock path: derive keys directly from the passphrase (slow, ~210k PBKDF2 iterations). */
  async unlockWithPassphrase(passphrase: string, saltBase64: string, iterations: number): Promise<void> {
    this.keys = await deriveVaultKeys(passphrase, fromBase64(saltBase64), iterations);
  }

  /**
   * Fast unlock path used on startup when "remember key on this device" is
   * enabled: re-derives the AES/HMAC keys from cached root bits without
   * re-running PBKDF2.
   */
  async unlockWithCachedRootBits(rootBitsBase64: string): Promise<void> {
    this.keys = await deriveKeysFromRootBits(fromBase64(rootBitsBase64));
  }

  /**
   * Unlocks with a passphrase AND returns the base64-encoded root bits for
   * caching, in a single PBKDF2 pass (used the first time "remember key" is
   * turned on, e.g. during vault creation/linking).
   */
  async unlockAndDeriveRootBitsForCaching(
    passphrase: string,
    saltBase64: string,
    iterations: number,
  ): Promise<{ rootBitsBase64: string }> {
    const rootBits = await deriveRootBits(passphrase, fromBase64(saltBase64), iterations);
    this.keys = await deriveKeysFromRootBits(rootBits);
    return { rootBitsBase64: toBase64(rootBits) };
  }

  /**
   * Unlock path for a vault somebody shared with the user: opens their own passphrase-wrapped copy of the vault key.
   * Returns the root bits like `unlockAndDeriveRootBitsForCaching` does, so "remember key" works the same way.
   * Throws a plain `Error` with a display-ready message on a wrong passphrase (AES-GCM authentication fails).
   */
  async unlockMemberWithPassphrase(
    passphrase: string,
    vaultId: string,
    memberKey: VaultMemberKey,
  ): Promise<{ rootBitsBase64: string }> {
    let rootBits: Uint8Array;
    try {
      rootBits = await unwrapRootBitsForMember(
        fromBase64(memberKey.wrapped),
        passphrase,
        fromBase64(memberKey.salt),
        memberKey.iterations,
        vaultId,
        memberKey.userId,
      );
    } catch {
      throw new Error(t("p.wrongPass"));
    }
    this.keys = await deriveKeysFromRootBits(rootBits);
    return { rootBitsBase64: toBase64(rootBits) };
  }

  private requireKeys(): VaultKeyBundle {
    if (!this.keys) throw new Error(t("p.vaultLockedErr"));
    return this.keys;
  }

  async encryptPath(path: string): Promise<{ ciphertext: Uint8Array; iv: Uint8Array }> {
    return encryptText(this.requireKeys().aesKey, path);
  }

  async decryptPath(ciphertext: Uint8Array, iv: Uint8Array): Promise<string> {
    return decryptText(this.requireKeys().aesKey, ciphertext, iv);
  }

  async encryptContent(plaintext: Uint8Array): Promise<{ ciphertext: Uint8Array; iv: Uint8Array }> {
    return encryptBytes(this.requireKeys().aesKey, plaintext);
  }

  async decryptContent(ciphertext: Uint8Array, iv: Uint8Array): Promise<Uint8Array> {
    return decryptBytes(this.requireKeys().aesKey, ciphertext, iv);
  }

  /** The key of a note's public link (stays in the link's #fragment; derived from the vault key, so any device rebuilds it). */
  async publishKey(fileId: string): Promise<Uint8Array> {
    return derivePublishKey(this.requireKeys().hmacKey, fileId);
  }

  async hashContent(plaintext: Uint8Array): Promise<Uint8Array> {
    return blindContentHash(this.requireKeys().hmacKey, plaintext);
  }

  /**
   * Creates a verification payload for a vault. IMPORTANT: `bindingName`
   * must be the vault's `name` field, never its server-generated `id` - this
   * is a deliberate cross-client convention shared with the web panel (the
   * id doesn't exist yet at creation time), see the plan's E2EE section.
   */
  async makeVerificationPayload(bindingName: string): Promise<{ ciphertext: Uint8Array; iv: Uint8Array }> {
    return makeVerificationPayload(this.requireKeys().aesKey, bindingName);
  }

  /** Checks the currently-unlocked keys against a stored verification blob. See `makeVerificationPayload` for the `bindingName` convention. */
  async verifyAgainstBlob(bindingName: string, verificationBlobBase64: string, verificationNonceBase64: string): Promise<boolean> {
    const keys = this.requireKeys();
    return verifyPassphrase(keys.aesKey, bindingName, fromBase64(verificationBlobBase64), fromBase64(verificationNonceBase64));
  }
}
