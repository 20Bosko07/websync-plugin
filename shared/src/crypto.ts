/**
 * E2EE primitives shared by the plugin and the web panel.
 *
 * Everything here uses only native WebCrypto (`crypto.subtle`), which is
 * available identically in the Electron renderer (Obsidian desktop) and in
 * the Capacitor WebView (Obsidian mobile) - no WASM, no Node `crypto`.
 *
 * Key hierarchy: PBKDF2(passphrase, salt) -> root bits -> HKDF -> two
 * independent keys (AES-GCM for encryption, HMAC for the blinded content
 * hash), so the same key material is never reused across purposes.
 */

const PBKDF2_HASH = "SHA-256";
const IV_LENGTH_BYTES = 12;
const SALT_LENGTH_BYTES = 16;

export interface VaultKeyBundle {
  aesKey: CryptoKey;
  hmacKey: CryptoKey;
}

export interface EncryptedPayload {
  ciphertext: Uint8Array;
  iv: Uint8Array;
}

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

export function generateSalt(): Uint8Array {
  return crypto.getRandomValues(new Uint8Array(SALT_LENGTH_BYTES));
}

function generateIv(): Uint8Array {
  return crypto.getRandomValues(new Uint8Array(IV_LENGTH_BYTES));
}

/**
 * The PBKDF2 half of `deriveVaultKeys`: the 256 "root bits" every vault key hangs off. Sharing a vault means handing
 * these bytes to the other person (wrapped, see below); the AES/HMAC CryptoKeys derived from them are not exportable.
 */
export async function deriveRootBits(passphrase: string, salt: Uint8Array, iterations: number): Promise<Uint8Array> {
  const passphraseKey = await crypto.subtle.importKey(
    "raw",
    textEncoder.encode(passphrase.normalize("NFKC")),
    "PBKDF2",
    false,
    ["deriveBits"],
  );

  const rootBits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", salt: toArrayBuffer(salt), iterations, hash: PBKDF2_HASH },
    passphraseKey,
    256,
  );
  return new Uint8Array(rootBits);
}

export async function deriveVaultKeys(
  passphrase: string,
  salt: Uint8Array,
  iterations: number,
): Promise<VaultKeyBundle> {
  return deriveKeysFromRootBits(await deriveRootBits(passphrase, salt, iterations));
}

/** The HKDF half of `deriveVaultKeys`: root bits -> the two independent, non-extractable vault keys. */
export async function deriveKeysFromRootBits(rootBits: Uint8Array): Promise<VaultKeyBundle> {
  const hkdfKey = await crypto.subtle.importKey("raw", toArrayBuffer(rootBits), "HKDF", false, [
    "deriveKey",
  ]);

  const aesKey = await crypto.subtle.deriveKey(
    { name: "HKDF", hash: "SHA-256", salt: new Uint8Array(0), info: textEncoder.encode("websync-aes-gcm-content-v1") },
    hkdfKey,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );

  const hmacKey = await crypto.subtle.deriveKey(
    { name: "HKDF", hash: "SHA-256", salt: new Uint8Array(0), info: textEncoder.encode("websync-content-hash-hmac-v1") },
    hkdfKey,
    { name: "HMAC", hash: "SHA-256", length: 256 },
    false,
    ["sign"],
  );

  return { aesKey, hmacKey };
}

export async function encryptBytes(aesKey: CryptoKey, plaintext: Uint8Array): Promise<EncryptedPayload> {
  const iv = generateIv();
  const ciphertext = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv: toArrayBuffer(iv) },
    aesKey,
    toArrayBuffer(plaintext),
  );
  return { ciphertext: new Uint8Array(ciphertext), iv };
}

export async function decryptBytes(
  aesKey: CryptoKey,
  ciphertext: Uint8Array,
  iv: Uint8Array,
): Promise<Uint8Array> {
  const plaintext = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: toArrayBuffer(iv) },
    aesKey,
    toArrayBuffer(ciphertext),
  );
  return new Uint8Array(plaintext);
}

export async function encryptText(aesKey: CryptoKey, text: string): Promise<EncryptedPayload> {
  return encryptBytes(aesKey, textEncoder.encode(text));
}

export async function decryptText(aesKey: CryptoKey, ciphertext: Uint8Array, iv: Uint8Array): Promise<string> {
  const bytes = await decryptBytes(aesKey, ciphertext, iv);
  return textDecoder.decode(bytes);
}

/** Concatenates iv + ciphertext into a single blob, as stored for file content blobs. */
export function packBlob(payload: EncryptedPayload): Uint8Array {
  const out = new Uint8Array(payload.iv.length + payload.ciphertext.length);
  out.set(payload.iv, 0);
  out.set(payload.ciphertext, payload.iv.length);
  return out;
}

/**
 * Uses `.subarray()`, not `.slice()`: both views share the same underlying
 * ArrayBuffer as `blob` instead of copying it. `crypto.subtle.decrypt`
 * accepts TypedArray views directly, so this avoids allocating a second
 * full-size copy of the (potentially large) ciphertext - meaningful on
 * memory-constrained mobile WebViews where that extra copy can be the
 * difference between decrypting a large attachment and crashing.
 */
export function unpackBlob(blob: Uint8Array): EncryptedPayload {
  const iv = blob.subarray(0, IV_LENGTH_BYTES);
  const ciphertext = blob.subarray(IV_LENGTH_BYTES);
  return { ciphertext, iv };
}

const VERIFICATION_PREFIX = "websync-verify-v1:";

/** Encrypts a known constant so a later device can check a passphrase guess against it. */
export async function makeVerificationPayload(aesKey: CryptoKey, vaultId: string): Promise<EncryptedPayload> {
  return encryptText(aesKey, VERIFICATION_PREFIX + vaultId);
}

export async function verifyPassphrase(
  aesKey: CryptoKey,
  vaultId: string,
  ciphertext: Uint8Array,
  iv: Uint8Array,
): Promise<boolean> {
  try {
    const plaintext = await decryptText(aesKey, ciphertext, iv);
    return plaintext === VERIFICATION_PREFIX + vaultId;
  } catch {
    // AES-GCM auth tag mismatch throws OperationError - wrong passphrase.
    return false;
  }
}

/**
 * HMAC-SHA256(SHA-256(plaintext), vaultHmacKey). The server only ever sees
 * this blinded value, never the raw content hash, so it cannot correlate
 * identical file contents across vaults.
 */
export async function blindContentHash(hmacKey: CryptoKey, plaintext: Uint8Array): Promise<Uint8Array> {
  const rawHash = await crypto.subtle.digest("SHA-256", toArrayBuffer(plaintext));
  const signature = await crypto.subtle.sign("HMAC", hmacKey, rawHash);
  return new Uint8Array(signature);
}

// ---------------------------------------------------------------------------
// Vault sharing
//
// A vault is shared by an invitation link that carries the key, so joining is "open the link from the mail, log in":
//
//  1. Invite blob: the owner's browser seals the vault's root bits with a random INVITE SECRET and stores only that
//     sealed blob on the server. The secret travels in the fragment of the join link (`/invite/<id>#<secret>`); a
//     fragment is never part of an HTTP request, so it does not reach the server through the browser. The server does
//     see it once, when the owner's browser hands it over so the invitation mail can be sent - it does not store or use
//     it. Whoever can read that mail can join until the invitation is accepted, revoked or expired.
//  2. Member blob: on joining, the invitee's browser re-seals the same root bits under a passphrase of their own, so on
//     every other device they unlock the shared vault like their own vaults, and the owner's passphrase is never revealed.
//
// Both blobs are AES-GCM with the vault (and for members the user) bound in as additional authenticated data, so the
// server cannot swap a blob from another vault/user in without decryption failing.
// ---------------------------------------------------------------------------

export const INVITE_SECRET_BYTES = 32; // 256 bit: only ever pasted in a link, never typed, so it can be long
const INVITE_WRAP_SALT_BYTES = 16;
const HKDF_INVITE_INFO = "websync-invite-wrap-v1";
const HKDF_MEMBER_INFO = "websync-member-key-wrap-v1";
const INVITE_SECRET_PATTERN = /^[A-Za-z0-9_-]{20,128}$/;

/** A fresh random invite secret, URL-safe (base64url, no padding) so it can sit in a link fragment as it is. */
export function generateInviteSecret(): string {
  return toBase64(crypto.getRandomValues(new Uint8Array(INVITE_SECRET_BYTES)))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

/** Whether `value` looks like something `generateInviteSecret` made (also what the server accepts into the mail link). */
export function isInviteSecret(value: string): boolean {
  return INVITE_SECRET_PATTERN.test(value);
}

async function hkdfAesKey(ikm: Uint8Array, salt: Uint8Array, info: string): Promise<CryptoKey> {
  const base = await crypto.subtle.importKey("raw", toArrayBuffer(ikm), "HKDF", false, ["deriveKey"]);
  return crypto.subtle.deriveKey(
    { name: "HKDF", hash: "SHA-256", salt: toArrayBuffer(salt), info: textEncoder.encode(info) },
    base,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
}

/** iv || ciphertext+tag */
async function sealWithAad(key: CryptoKey, plaintext: Uint8Array, aad: string): Promise<Uint8Array> {
  const iv = generateIv();
  const sealed = new Uint8Array(
    await crypto.subtle.encrypt(
      { name: "AES-GCM", iv: toArrayBuffer(iv), additionalData: toArrayBuffer(textEncoder.encode(aad)) },
      key,
      toArrayBuffer(plaintext),
    ),
  );
  const out = new Uint8Array(iv.length + sealed.length);
  out.set(iv, 0);
  out.set(sealed, iv.length);
  return out;
}

async function openWithAad(key: CryptoKey, packed: Uint8Array, aad: string): Promise<Uint8Array> {
  if (packed.length <= IV_LENGTH_BYTES) throw new Error("Invalid key block.");
  return new Uint8Array(
    await crypto.subtle.decrypt(
      {
        name: "AES-GCM",
        iv: toArrayBuffer(packed.subarray(0, IV_LENGTH_BYTES)),
        additionalData: toArrayBuffer(textEncoder.encode(aad)),
      },
      key,
      toArrayBuffer(packed.subarray(IV_LENGTH_BYTES)),
    ),
  );
}

/** Owner side: seals the vault's root bits so only someone who knows `inviteSecret` can open them. */
export async function wrapRootBitsForInvite(rootBits: Uint8Array, inviteSecret: string, vaultId: string): Promise<Uint8Array> {
  if (!isInviteSecret(inviteSecret)) throw new Error("Invalid invitation key.");
  const salt = crypto.getRandomValues(new Uint8Array(INVITE_WRAP_SALT_BYTES));
  const key = await hkdfAesKey(textEncoder.encode(inviteSecret), salt, HKDF_INVITE_INFO);
  const sealed = await sealWithAad(key, rootBits, `websync-invite-v1|${vaultId}`);
  const out = new Uint8Array(salt.length + sealed.length);
  out.set(salt, 0);
  out.set(sealed, salt.length);
  return out;
}

/** Friend side: returns the root bits, or throws if the secret is wrong / the blob was tampered with or belongs to another vault. */
export async function unwrapRootBitsFromInvite(blob: Uint8Array, inviteSecret: string, vaultId: string): Promise<Uint8Array> {
  if (!isInviteSecret(inviteSecret)) throw new Error("Invalid invitation key.");
  if (blob.length <= INVITE_WRAP_SALT_BYTES) throw new Error("Invalid key block.");
  const key = await hkdfAesKey(textEncoder.encode(inviteSecret), blob.subarray(0, INVITE_WRAP_SALT_BYTES), HKDF_INVITE_INFO);
  return openWithAad(key, blob.subarray(INVITE_WRAP_SALT_BYTES), `websync-invite-v1|${vaultId}`);
}

async function memberWrapKey(passphrase: string, salt: Uint8Array, iterations: number): Promise<CryptoKey> {
  return hkdfAesKey(await deriveRootBits(passphrase, salt, iterations), new Uint8Array(0), HKDF_MEMBER_INFO);
}

/** Member side: seals the root bits under the member's own passphrase (stored server-side, unlocks on any device). */
export async function wrapRootBitsForMember(
  rootBits: Uint8Array,
  passphrase: string,
  salt: Uint8Array,
  iterations: number,
  vaultId: string,
  userId: string,
): Promise<Uint8Array> {
  return sealWithAad(await memberWrapKey(passphrase, salt, iterations), rootBits, `websync-member-key-v1|${vaultId}|${userId}`);
}

/** Throws (AES-GCM auth failure) on a wrong passphrase. */
export async function unwrapRootBitsForMember(
  wrapped: Uint8Array,
  passphrase: string,
  salt: Uint8Array,
  iterations: number,
  vaultId: string,
  userId: string,
): Promise<Uint8Array> {
  return openWithAad(await memberWrapKey(passphrase, salt, iterations), wrapped, `websync-member-key-v1|${vaultId}|${userId}`);
}

export function toBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  return btoa(binary);
}

export function fromBase64(base64: string): Uint8Array {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}
