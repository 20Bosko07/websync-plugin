import { fromBase64, packBlob, toBase64, unpackBlob } from "@websync/shared";
import type { CryptoService } from "../sync/CryptoService.js";

/**
 * What travels inside a `collab_relay` message. The server forwards these
 * opaquely; the plugin seals every one with the vault's AES key (same key and
 * scheme as file content), so document text and cursor positions stay
 * end-to-end encrypted.
 */
export const CollabKind = {
  /** joiner -> host: "here is my Yjs state vector, send me everything I miss". */
  StateRequest: 0,
  /** anybody -> everybody: an incremental Yjs document update. */
  Update: 1,
  /** anybody -> everybody: a y-protocols awareness update (name, colour, cursor, selection). */
  Awareness: 2,
  /** host -> joiner: the answer to a StateRequest (a Yjs update); completes the join. */
  StateReply: 3,
} as const;
export type CollabKind = (typeof CollabKind)[keyof typeof CollabKind];

/** Plaintext layout: [kind: 1 byte][fileId: 36 ASCII bytes][payload]. */
const FILE_ID_LENGTH = 36;
const HEADER_LENGTH = 1 + FILE_ID_LENGTH;

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

export interface OpenedCollabMessage {
  kind: CollabKind;
  payload: Uint8Array;
}

/**
 * The file id is part of the encrypted plaintext (and checked on open) so a
 * malicious/buggy server can't replay a payload sealed for one note into
 * another note's room - AES-GCM alone would authenticate it just fine.
 */
export async function sealCollabMessage(
  crypto: CryptoService,
  fileId: string,
  kind: CollabKind,
  payload: Uint8Array,
): Promise<string> {
  const plaintext = new Uint8Array(HEADER_LENGTH + payload.length);
  plaintext[0] = kind;
  plaintext.set(textEncoder.encode(fileId), 1);
  plaintext.set(payload, HEADER_LENGTH);
  const encrypted = await crypto.encryptContent(plaintext);
  return toBase64(packBlob(encrypted));
}

/** Returns null for anything that doesn't decrypt, is malformed, or was sealed for a different file. */
export async function openCollabMessage(
  crypto: CryptoService,
  fileId: string,
  data: string,
): Promise<OpenedCollabMessage | null> {
  try {
    const { ciphertext, iv } = unpackBlob(fromBase64(data));
    const plaintext = await crypto.decryptContent(ciphertext, iv);
    if (plaintext.length < HEADER_LENGTH) return null;
    if (textDecoder.decode(plaintext.subarray(1, HEADER_LENGTH)) !== fileId) return null;

    const kind = plaintext[0];
    if (kind !== CollabKind.StateRequest && kind !== CollabKind.Update && kind !== CollabKind.Awareness && kind !== CollabKind.StateReply) {
      return null;
    }
    return { kind, payload: plaintext.slice(HEADER_LENGTH) };
  } catch {
    return null; // wrong key, tampered, or not one of ours
  }
}
