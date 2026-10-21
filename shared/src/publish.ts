import { decryptBytes, encryptBytes, fromBase64, packBlob, toBase64, unpackBlob } from "./crypto";

/**
 * Public note links. A note is published as an encrypted snapshot (`PublishedBundle`); the key to open it travels only in
 * the #fragment of the link, which browsers never send to a server. The key is derived from the vault (so the owner can
 * rebuild the link on any device) - it is unrelated to the vault's own encryption keys.
 */

export interface PublishedBundle {
  v: 1;
  title: string;
  markdown: string;
  /** Embedded images by the name they are written under in the note, as `data:` URIs. */
  images: Record<string, string>;
  publishedAt: string;
}

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

export function toBase64Url(bytes: Uint8Array): string {
  return toBase64(bytes).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function fromBase64Url(text: string): Uint8Array {
  const padded = text.replace(/-/g, "+").replace(/_/g, "/");
  return fromBase64(padded + "=".repeat((4 - (padded.length % 4)) % 4));
}

/** 32 key bytes for one note: HMAC of the file id under the vault's (non-extractable) HMAC key. Stable, so republishing keeps the link. */
export async function derivePublishKey(hmacKey: CryptoKey, fileId: string): Promise<Uint8Array> {
  const mac = await crypto.subtle.sign("HMAC", hmacKey, textEncoder.encode(`websync-publish-v1:${fileId}`));
  return new Uint8Array(mac);
}

function importKey(keyBytes: Uint8Array): Promise<CryptoKey> {
  const copy = keyBytes.buffer.slice(keyBytes.byteOffset, keyBytes.byteOffset + keyBytes.byteLength) as ArrayBuffer;
  return crypto.subtle.importKey("raw", copy, "AES-GCM", false, ["encrypt", "decrypt"]);
}

/** `iv || ciphertext` of the bundle, ready to upload. */
export async function sealBundle(bundle: PublishedBundle, keyBytes: Uint8Array): Promise<Uint8Array> {
  return packBlob(await encryptBytes(await importKey(keyBytes), textEncoder.encode(JSON.stringify(bundle))));
}

/** Opens a downloaded blob; throws when the key is wrong or the data was altered. */
export async function openBundle(blob: Uint8Array, keyBytes: Uint8Array): Promise<PublishedBundle> {
  const { ciphertext, iv } = unpackBlob(blob);
  const json = textDecoder.decode(await decryptBytes(await importKey(keyBytes), ciphertext, iv));
  const parsed = JSON.parse(json) as Partial<PublishedBundle>;
  if (parsed.v !== 1 || typeof parsed.markdown !== "string") throw new Error("Unsupported note format");
  return { v: 1, title: String(parsed.title ?? ""), markdown: parsed.markdown, images: parsed.images ?? {}, publishedAt: String(parsed.publishedAt ?? "") };
}

/** The shareable address: `<web>/p/<id>#<key>`. */
export function publicNoteUrl(webBase: string, publishId: string, keyBytes: Uint8Array): string {
  return `${webBase.replace(/\/+$/, "")}/p/${publishId}#${toBase64Url(keyBytes)}`;
}
