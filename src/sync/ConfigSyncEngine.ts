/**
 * Syncs `.obsidian/*` config files (core settings, community plugins,
 * themes, snippets, hotkeys, workspace layout) - like Obsidian Sync's own
 * per-vault settings toggles. Off by default (see `ConfigSyncSettings` in
 * types.ts).
 *
 * Deliberately a SEPARATE engine from the main `SyncEngine`, not a mode of
 * it, because config files live in a fundamentally different part of
 * Obsidian's API:
 *  - `.obsidian/**` is excluded from `vault.getFiles()` and never fires
 *    `vault.on('create'|'modify'|'delete'|'rename', ...)` events - there is
 *    no event-driven change detection available, only `adapter.list()` /
 *    `adapter.stat()` polling.
 *  - Files aren't represented as `TFile` objects, so none of the main
 *    engine's TFile-typed plumbing applies.
 * Keeping this fully isolated (own reconciliation loop, own "last synced
 * version" cursor, no shared local-index table) means it can never interact
 * with - or risk corrupting the behavior of - the already-solid note sync
 * engine. The one deliberate coupling point is that `SyncEngine` explicitly
 * skips any remote item whose decrypted path falls under the config
 * directory, so the two engines never both try to own the same file.
 *
 * FileIds for config files are derived deterministically from their path
 * (see `deterministicFileId`) rather than tracked in a local index table:
 * since config files are rarely "renamed" the way notes are, every device
 * can independently compute the same fileId for the same path without any
 * shared bookkeeping, and reconciliation becomes a live per-path compare
 * (local content hash vs. the remote item's `contentHashBlinded`) instead
 * of needing persisted per-file state.
 */
import { t } from "../i18n/index.js";
import { Notice, Platform, type App } from "obsidian";
import { MOBILE_MAX_SYNC_FILE_SIZE_BYTES, toBase64, unpackBlob } from "@websync/shared";
import type { ConfigSyncSettings } from "../types.js";
import type { CryptoService } from "./CryptoService.js";
import type { DecodedFileListItem, RemoteApiClient } from "./RemoteApiClient.js";
import type { SyncLog } from "./SyncLog.js";

type ConfigCategory = Exclude<keyof ConfigSyncSettings, "enabled" | "lastSyncedGlobalVersion" | "known">;

export interface ConfigSyncEngineDeps {
  app: App;
  vaultId: string;
  pluginDir: string;
  crypto: CryptoService;
  remote: RemoteApiClient;
  getSettings: () => ConfigSyncSettings;
  log?: SyncLog;
  onLastVersionChange: (version: number) => void | Promise<void>;
}

/** Category -> the `.obsidian`-relative files/folders it covers. Folders are scanned recursively. */
function categoryRoots(configDir: string): Record<ConfigCategory, string[]> {
  return {
    coreSettings: [
      `${configDir}/app.json`,
      `${configDir}/appearance.json`,
      `${configDir}/core-plugins.json`,
      `${configDir}/core-plugins-migration.json`,
      `${configDir}/graph.json`,
      `${configDir}/types.json`,
      // Templates core plugin (template folder, date/time format) - the web workspace reads it to offer "Vorlage einfügen".
      `${configDir}/templates.json`,
      // Daily notes core plugin (folder, date format, template) and the bookmarks - the web workspace has both as well.
      `${configDir}/daily-notes.json`,
      `${configDir}/bookmarks.json`,
    ],
    communityPlugins: [`${configDir}/community-plugins.json`, `${configDir}/plugins`],
    themes: [`${configDir}/themes`],
    snippets: [`${configDir}/snippets`],
    hotkeys: [`${configDir}/hotkeys.json`],
    workspace: [`${configDir}/workspace.json`, `${configDir}/workspace-mobile.json`],
  };
}

export class ConfigSyncEngine {
  private syncing = false;
  private readonly configDir: string;
  private readonly warnedOversizedPaths = new Set<string>();
  /**
   * The remote list is only a delta (`since` = cursor), so "not in the list" means "unchanged remotely", not "new". To
   * tell a local file that really needs uploading from one that is simply in sync, remember the modification time each
   * file had when it was last reconciled; a file whose mtime still matches is left alone.
   */
  private readonly reconciledMtimes = new Map<string, number>();
  /** The first run of a session, and every run after the set of synced categories changed, compares against the whole remote list. */
  private fullyListed = false;
  private lastRootsKey = "";

  constructor(private readonly deps: ConfigSyncEngineDeps) {
    this.configDir = deps.app.vault.configDir;
  }

  get isSyncing(): boolean {
    return this.syncing;
  }

  async run(): Promise<void> {
    const settings = this.deps.getSettings();
    if (!settings.enabled || this.syncing) return;

    this.syncing = true;
    try {
      await this.reconcile(settings);
    } finally {
      this.syncing = false;
    }
  }

  private knownKey(path: string): string {
    return `${this.deps.vaultId}|${path}`;
  }

  private remember(settings: ConfigSyncSettings, path: string, hash: Uint8Array): void {
    settings.known[this.knownKey(path)] = toBase64(hash);
  }

  private forget(settings: ConfigSyncSettings, path: string): void {
    delete settings.known[this.knownKey(path)];
  }

  private async reconcile(settings: ConfigSyncSettings): Promise<void> {
    settings.known ??= {};
    const roots = categoryRoots(this.configDir);
    const enabledRootPaths = (Object.keys(roots) as ConfigCategory[])
      .filter((cat) => settings[cat])
      .flatMap((cat) => roots[cat]);

    const localFiles = await this.scanLocal(enabledRootPaths);

    // Without the full list a local file that is missing from the delta could be one the server already has (from
    // before this session, or from a category that was just switched on) and would be uploaded over it blindly.
    const rootsKey = enabledRootPaths.join("|");
    const fullList = !this.fullyListed || rootsKey !== this.lastRootsKey;
    const remoteResp = await this.deps.remote.listFiles(this.deps.vaultId, fullList ? 0 : settings.lastSyncedGlobalVersion, true);
    const configPrefix = `${this.configDir}/`;
    const remoteByPath = new Map<string, DecodedFileListItem>();
    for (const item of remoteResp.files) {
      let path: string;
      try {
        path = await this.deps.crypto.decryptPath(item.pathCiphertext, item.pathNonce);
      } catch {
        continue; // not decryptable with this passphrase's key - ignore, main engine already logs a warning for its own items
      }
      if (!path.startsWith(configPrefix) || this.isOwnPluginPath(path)) continue;
      remoteByPath.set(path, item);
    }

    const handled = new Set<string>();

    for (const [path, item] of remoteByPath) {
      handled.add(path);
      const category = this.categoryFor(path, roots);
      if (!category || !settings[category]) continue; // user turned this category off locally - leave it alone

      if (item.isDeleted) {
        const local = localFiles.get(path);
        if (!local) {
          this.reconciledMtimes.delete(path);
          this.forget(settings, path);
          continue;
        }
        // Never agreed on this file with the server: a deletion there is not ours to apply (nor is the file ours to push).
        if (settings.known[this.knownKey(path)] === undefined) continue;
        const localMtime = await this.statMtime(path);
        if (this.isRemoteNewer(item.updatedAt, localMtime)) {
          await this.deps.app.vault.adapter.remove(path).catch(() => undefined);
          this.reconciledMtimes.delete(path);
          this.forget(settings, path);
        } else {
          const hash = await this.uploadPath(path);
          if (hash) this.remember(settings, path, hash);
          this.reconciledMtimes.set(path, local.mtime);
        }
        continue;
      }

      await this.reconcilePath(settings, path, item, localFiles.get(path));
    }

    for (const [path, { mtime }] of localFiles) {
      if (handled.has(path)) continue;
      // Not in the remote list. On a full list that means the server does not have it; on a delta it only means it did
      // not change remotely, so upload it only if it changed here since it was last reconciled.
      if (!fullList && this.reconciledMtimes.get(path) === mtime) continue;
      const hash = await this.uploadPath(path);
      if (hash) this.remember(settings, path, hash);
      this.reconciledMtimes.set(path, mtime);
    }

    this.fullyListed = true;
    this.lastRootsKey = rootsKey;
    const newVersion = Math.max(settings.lastSyncedGlobalVersion, remoteResp.currentVersion);
    await this.deps.onLastVersionChange(newVersion);
  }

  private async reconcilePath(
    settings: ConfigSyncSettings,
    path: string,
    item: DecodedFileListItem,
    local: { mtime: number } | undefined,
  ): Promise<void> {
    const remoteHash = toBase64(item.contentHashBlinded);
    if (!local) {
      if (await this.downloadPath(path, item)) settings.known[this.knownKey(path)] = remoteHash;
      return;
    }

    const localBytes = await this.deps.app.vault.adapter.readBinary(path).then((b) => new Uint8Array(b));
    const localHash = await this.deps.crypto.hashContent(localBytes);
    const localB64 = toBase64(localHash);
    if (localB64 === remoteHash) {
      settings.known[this.knownKey(path)] = remoteHash;
      this.reconciledMtimes.set(path, local.mtime); // already in sync
      return;
    }

    // `baseline` is what this device and the server last agreed on. With it the side that changed since then is clear,
    // regardless of file times; without it (first contact, e.g. a new device that still has default settings) the
    // server's version is adopted rather than a fresh device overwriting the real settings because its files are newer.
    const baseline = settings.known[this.knownKey(path)];
    let download: boolean;
    if (baseline === undefined) download = true;
    else if (baseline === remoteHash) download = false;
    else if (baseline === localB64) download = true;
    else download = this.isRemoteNewer(item.updatedAt, await this.statMtime(path));

    if (download) {
      if (await this.downloadPath(path, item)) settings.known[this.knownKey(path)] = remoteHash;
    } else {
      const hash = await this.uploadPath(path, localBytes, localHash);
      if (hash) this.remember(settings, path, hash);
      this.reconciledMtimes.set(path, local.mtime);
    }
  }

  private async uploadPath(path: string, precomputedBytes?: Uint8Array, precomputedHash?: Uint8Array): Promise<Uint8Array | null> {
    const bytes = precomputedBytes ?? new Uint8Array(await this.deps.app.vault.adapter.readBinary(path));

    if (Platform.isMobile && bytes.byteLength > MOBILE_MAX_SYNC_FILE_SIZE_BYTES) {
      if (!this.warnedOversizedPaths.has(path)) {
        this.warnedOversizedPaths.add(path);
        new Notice(t("p.sync.tooBigConfig", { path }));
      }
      return null;
    }

    const hash = precomputedHash ?? (await this.deps.crypto.hashContent(bytes));
    const fileId = await deterministicFileId(this.deps.vaultId, path);
    const encryptedContent = await this.deps.crypto.encryptContent(bytes);
    const encryptedPath = await this.deps.crypto.encryptPath(path);

    await this.deps.remote.uploadFile(this.deps.vaultId, fileId, {
      pathCiphertext: encryptedPath.ciphertext,
      pathNonce: encryptedPath.iv,
      contentHashBlinded: hash,
      contentSize: bytes.byteLength,
      contentIv: encryptedContent.iv,
      contentCiphertext: encryptedContent.ciphertext,
    });
    this.deps.log?.add({ kind: "settings-up", path });
    return hash;
  }

  private async downloadPath(path: string, item: DecodedFileListItem): Promise<boolean> {
    if (Platform.isMobile && item.contentSize > MOBILE_MAX_SYNC_FILE_SIZE_BYTES) {
      if (!this.warnedOversizedPaths.has(path)) {
        this.warnedOversizedPaths.add(path);
        new Notice(t("p.sync.tooBigConfig", { path }));
      }
      return false;
    }

    const blob = await this.deps.remote.downloadBlob(this.deps.vaultId, item.id, item.contentSize);
    const { ciphertext, iv } = unpackBlob(blob);
    const plaintext = await this.deps.crypto.decryptContent(ciphertext, iv);
    await this.ensureParentDir(path);
    await this.deps.app.vault.adapter.writeBinary(path, toArrayBuffer(plaintext));
    this.reconciledMtimes.set(path, await this.statMtime(path)); // the write itself changed the mtime
    this.deps.log?.add({ kind: "settings-down", path });
    return true;
  }

  // ============================================================
  // Local filesystem helpers (raw adapter - `.obsidian/**` has no TFile representation)
  // ============================================================

  private async scanLocal(roots: string[]): Promise<Map<string, { mtime: number }>> {
    const out = new Map<string, { mtime: number }>();
    for (const root of roots) {
      await this.walk(root, out);
    }
    return out;
  }

  private async walk(path: string, out: Map<string, { mtime: number }>): Promise<void> {
    if (this.isOwnPluginPath(path)) return;
    const adapter = this.deps.app.vault.adapter;
    if (!(await adapter.exists(path))) return;

    const stat = await adapter.stat(path);
    if (!stat) return;

    if (stat.type === "file") {
      out.set(path, { mtime: stat.mtime });
      return;
    }

    const listing = await adapter.list(path);
    for (const filePath of listing.files) await this.walk(filePath, out);
    for (const folderPath of listing.folders) await this.walk(folderPath, out);
  }

  private async statMtime(path: string): Promise<number> {
    const stat = await this.deps.app.vault.adapter.stat(path);
    return stat?.mtime ?? 0;
  }

  private async ensureParentDir(path: string): Promise<void> {
    const lastSlash = path.lastIndexOf("/");
    if (lastSlash <= 0) return;
    const folder = path.slice(0, lastSlash);
    if (await this.deps.app.vault.adapter.exists(folder)) return;
    try {
      await this.deps.app.vault.adapter.mkdir(folder);
    } catch {
      // Ignore races (folder created concurrently) - a genuine failure surfaces on the writeBinary call right after.
    }
  }

  private isOwnPluginPath(path: string): boolean {
    return path === this.deps.pluginDir || path.startsWith(`${this.deps.pluginDir}/`);
  }

  private categoryFor(path: string, roots: Record<ConfigCategory, string[]>): ConfigCategory | null {
    for (const category of Object.keys(roots) as ConfigCategory[]) {
      for (const root of roots[category]) {
        if (path === root || path.startsWith(`${root}/`)) return category;
      }
    }
    return null;
  }

  private isRemoteNewer(remoteUpdatedAt: string, localMtimeMs: number): boolean {
    return new Date(remoteUpdatedAt).getTime() >= localMtimeMs;
  }
}

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

/**
 * Deterministic, UUID-shaped id derived from the vault id + path, so every
 * device independently computes the same fileId for the same config path
 * without needing a shared local-index table. Not a real random UUID and
 * not a spec-compliant UUIDv5 - just SHA-256 truncated to 16 bytes with the
 * version/variant nibbles fixed up so it passes the server's `z.string().uuid()`
 * validation.
 */
async function deterministicFileId(vaultId: string, path: string): Promise<string> {
  const data = new TextEncoder().encode(`websync-config-fileid-v1:${vaultId}:${path}`);
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", data)).slice(0, 16);
  digest[6] = (digest[6] & 0x0f) | 0x40;
  digest[8] = (digest[8] & 0x3f) | 0x80;
  const hex = Array.from(digest, (b) => b.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}
