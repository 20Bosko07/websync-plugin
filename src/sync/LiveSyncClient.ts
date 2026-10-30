import { CollabServerMessageSchema, type CollabClientMessage, type CollabServerMessage, type VaultChangedMessage } from "@websync/shared";

const INITIAL_RECONNECT_DELAY_MS = 2000;
const MAX_RECONNECT_DELAY_MS = 30_000;

/**
 * Live-push companion to the periodic `runIncrementalPoll()` timer in
 * main.ts/SyncEngine.ts. Connects to the server's `/ws` endpoint and calls
 * `onVaultChanged()` whenever the server pushes a `vault_changed` message
 * (i.e. some device - including this one, harmlessly - changed this vault).
 * The 30s poll keeps running regardless, as a fallback safety net; this
 * class only shaves the "up to 30s" delay down to roughly however long a
 * poll round-trip takes.
 *
 * Uses the global `WebSocket` (identical in the Electron renderer and the
 * Capacitor mobile WebView), never Node's `ws` package, so this keeps
 * working on Obsidian mobile.
 *
 * The same socket also carries the live-collaboration traffic (see
 * collab/CollabManager.ts): `send()` writes `collab_*` messages to the server,
 * and everything the server pushes that isn't `vault_changed` is handed to
 * `onCollabMessage`. Collab messages are dropped (send returns false) while
 * the socket is down - the collab layer treats a disconnect as "leave all
 * rooms" and rejoins from `onStatusChange(true)`.
 *
 * Auth is via query params (`token`, `vaultId`) rather than a header, since
 * the browser-standard WebSocket constructor cannot set custom headers on
 * the upgrade request.
 *
 * Reconnects on `close`/`error` with a simple doubling backoff (2s -> 30s
 * cap), reset to 2s after a successful `open`, so a dropped connection or a
 * server restart never turns into a tight reconnect loop and never kills the
 * plugin.
 */
export class LiveSyncClient {
  private socket: WebSocket | null = null;
  private reconnectTimer: ReturnType<typeof window.setTimeout> | null = null;
  private reconnectDelayMs = INITIAL_RECONNECT_DELAY_MS;
  private disposed = false;

  constructor(
    private readonly serverUrl: string,
    private readonly sessionToken: string,
    private readonly vaultId: string,
    private readonly onVaultChanged: () => void,
    /** Optional - lets callers show a "Live-Sync: verbunden/getrennt" indicator. */
    private readonly onStatusChange?: (connected: boolean) => void,
    /** Optional - receives validated `collab_peers` / `collab_relay` messages. */
    private readonly onCollabMessage?: (message: CollabServerMessage) => void,
    /** Optional - the server ended this device's session on purpose (signed out / revoked); the client then stops reconnecting. */
    private readonly onSessionEnded?: () => void,
  ) {
    this.connect();
  }

  /** Closes the socket and cancels any pending reconnect timer. Call from onunload() and whenever the vault is unlinked or the unlocked-state changes. */
  dispose(): void {
    this.disposed = true;
    this.clearReconnectTimer();
    if (this.socket) {
      const socket = this.socket;
      this.socket = null;
      // Drop our own listeners first so a synchronous close doesn't report
      // "disconnected" twice or schedule a pointless reconnect.
      socket.onopen = null;
      socket.onmessage = null;
      socket.onclose = null;
      socket.onerror = null;
      socket.close();
    }
  }

  get connected(): boolean {
    return this.socket !== null && this.socket.readyState === WebSocket.OPEN;
  }

  /** Sends a collaboration message; returns false (and drops it) if the socket isn't open right now. */
  send(message: CollabClientMessage): boolean {
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) return false;
    this.socket.send(JSON.stringify(message));
    return true;
  }

  private connect(): void {
    if (this.disposed) return;
    this.clearReconnectTimer();

    let socket: WebSocket;
    try {
      socket = new WebSocket(this.buildUrl());
    } catch (err) {
      console.error("Syncstone: Live-Sync-Verbindung konnte nicht aufgebaut werden", err);
      this.scheduleReconnect();
      return;
    }
    this.socket = socket;

    socket.onopen = () => {
      this.reconnectDelayMs = INITIAL_RECONNECT_DELAY_MS;
      this.onStatusChange?.(true);
    };

    socket.onmessage = (event: MessageEvent) => {
      this.handleMessage(event.data);
    };

    socket.onclose = (event: CloseEvent) => {
      if (this.socket === socket) this.socket = null;
      this.onStatusChange?.(false);
      // 4401 = the session was ended, 4404 = the vault is gone for this account: trying again can only fail again.
      if (event.code === 4401) {
        this.onSessionEnded?.();
        return;
      }
      if (event.code === 4404) return;
      this.scheduleReconnect();
    };

    // A WebSocket's "close" event always follows "error" for connection
    // failures, so reconnection is scheduled from onclose above - this is
    // just for diagnostics, to avoid double-scheduling a reconnect.
    socket.onerror = () => {
      console.error("Syncstone: Live-Sync-Verbindung getrennt (Fehler)");
    };
  }

  private buildUrl(): string {
    const wsBase = this.serverUrl.replace(/^http/, "ws");
    const base = wsBase.endsWith("/") ? wsBase.slice(0, -1) : wsBase;
    const query = new URLSearchParams({ token: this.sessionToken, vaultId: this.vaultId });
    return `${base}/ws?${query.toString()}`;
  }

  private handleMessage(data: unknown): void {
    if (typeof data !== "string") return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(data);
    } catch {
      return; // not JSON - ignore rather than crash the socket handler
    }
    const message = parsed as Partial<VaultChangedMessage> | null;
    if (message && message.type === "vault_changed") {
      this.onVaultChanged();
      return;
    }
    const collab = CollabServerMessageSchema.safeParse(parsed);
    if (collab.success) this.onCollabMessage?.(collab.data);
  }

  private scheduleReconnect(): void {
    if (this.disposed) return;
    this.clearReconnectTimer();
    this.reconnectTimer = window.setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, this.reconnectDelayMs);
    this.reconnectDelayMs = Math.min(this.reconnectDelayMs * 2, MAX_RECONNECT_DELAY_MS);
  }

  private clearReconnectTimer(): void {
    if (this.reconnectTimer !== null) {
      window.clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }
}
