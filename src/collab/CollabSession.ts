import { Awareness, applyAwarenessUpdate, encodeAwarenessUpdate, removeAwarenessStates } from "y-protocols/awareness";
import * as Y from "yjs";
import { CollabKind } from "./protocol.js";

/** Origin for updates that came from a peer - never echoed back out. */
const REMOTE_ORIGIN = Symbol("websync-remote");
/** Origin for the initial text the host puts into a fresh document - joiners get it via the state reply, not as a broadcast. */
const SEED_ORIGIN = Symbol("websync-seed");
/** y-protocols' own origin for "this device changed its awareness state". */
const LOCAL_AWARENESS_ORIGIN = "local";
/** Origin we pass when removing a departed peer's states - must not be mistaken for a peer id. */
const PEER_LEFT_ORIGIN = "peer-left";

/** Cursor moves fire on every keystroke/arrow key; coalescing them keeps traffic (and encryptions) modest. */
const AWARENESS_SEND_DELAY_MS = 60;

export interface CollabSessionUser {
  name: string;
  color: string;
}

export type CollabSend = (kind: CollabKind, payload: Uint8Array, to?: string) => void;

/**
 * The live state of ONE note while at least two devices have it open: a Yjs
 * document holding the text plus the awareness (who is where) that
 * y-codemirror.next renders as coloured cursors. It knows nothing about
 * Obsidian or the socket - the manager feeds it decrypted remote messages and
 * gets outgoing ones through `send`.
 *
 * Sessions are ephemeral by design: the note itself keeps living in the normal
 * file sync (Obsidian saves the editor content to disk, SyncEngine uploads
 * it), the Y document is only the transport that keeps the open editors
 * identical in between. When the last other device leaves the session is
 * simply dropped.
 */
export class CollabSession {
  readonly doc = new Y.Doc();
  readonly ytext = this.doc.getText("content");
  readonly awareness = new Awareness(this.doc);

  /** peerId -> the awareness client ids that peer announced, so its cursor can be removed when it leaves. */
  private readonly awarenessClientsByPeer = new Map<string, Set<number>>();
  private awarenessTimer: ReturnType<typeof window.setTimeout> | null = null;
  private destroyed = false;

  constructor(
    private readonly send: CollabSend,
    user: CollabSessionUser,
  ) {
    this.doc.on("update", (update: Uint8Array, origin: unknown) => {
      if (this.destroyed || origin === REMOTE_ORIGIN || origin === SEED_ORIGIN) return;
      this.send(CollabKind.Update, update);
    });

    this.awareness.on("update", ({ added, updated }: { added: number[]; updated: number[]; removed: number[] }, origin: unknown) => {
      if (this.destroyed) return;
      if (origin === LOCAL_AWARENESS_ORIGIN) {
        this.scheduleAwarenessSend();
      } else if (typeof origin === "string" && origin !== PEER_LEFT_ORIGIN) {
        // Applied from a peer's message: remember which client ids belong to it.
        const clients = this.awarenessClientsByPeer.get(origin) ?? new Set<number>();
        for (const id of [...added, ...updated]) clients.add(id);
        this.awarenessClientsByPeer.set(origin, clients);
      }
    });

    this.awareness.setLocalStateField("user", { name: user.name, color: user.color, colorLight: `${user.color}33` });
  }

  /** Host only: puts the current editor text into the (still empty) document without broadcasting it. */
  seed(text: string): void {
    this.doc.transact(() => {
      this.ytext.insert(0, text);
    }, SEED_ORIGIN);
  }

  text(): string {
    return this.ytext.toString();
  }

  encodeStateVector(): Uint8Array {
    return Y.encodeStateVector(this.doc);
  }

  /** Everything a peer with state vector `stateVector` is missing. */
  encodeStateSince(stateVector: Uint8Array): Uint8Array {
    return Y.encodeStateAsUpdate(this.doc, stateVector);
  }

  applyRemoteUpdate(update: Uint8Array): void {
    Y.applyUpdate(this.doc, update, REMOTE_ORIGIN);
  }

  applyRemoteAwareness(peerId: string, update: Uint8Array): void {
    applyAwarenessUpdate(this.awareness, update, peerId);
  }

  /** Removes a departed peer's cursor right away instead of waiting for the 30s awareness timeout. */
  forgetPeer(peerId: string): void {
    const clients = this.awarenessClientsByPeer.get(peerId);
    if (!clients) return;
    this.awarenessClientsByPeer.delete(peerId);
    removeAwarenessStates(this.awareness, [...clients], PEER_LEFT_ORIGIN);
  }

  /** This device was renamed while the session is running - peers see the new name on the cursor flag. */
  setUserName(name: string): void {
    const user = (this.awareness.getLocalState()?.user ?? {}) as { name?: string };
    if (user.name === name) return;
    this.awareness.setLocalStateField("user", { ...user, name });
  }

  /** Re-announces this device's cursor/name (e.g. because a new peer just joined and hasn't seen it yet). */
  announce(): void {
    this.awareness.setLocalState({ ...this.awareness.getLocalState() });
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    if (this.awarenessTimer !== null) window.clearTimeout(this.awarenessTimer);
    this.awarenessTimer = null;
    this.awareness.destroy();
    this.doc.destroy();
  }

  private scheduleAwarenessSend(): void {
    if (this.awarenessTimer !== null) return;
    this.awarenessTimer = window.setTimeout(() => {
      this.awarenessTimer = null;
      if (this.destroyed) return;
      this.send(CollabKind.Awareness, encodeAwarenessUpdate(this.awareness, [this.doc.clientID]));
    }, AWARENESS_SEND_DELAY_MS);
  }
}
