import { Notice, Platform, TFile, TFolder, type TAbstractFile } from "obsidian";
import {
  FOLDER_MARKER_FILENAME,
  HISTORY_EDIT_SESSION_IDLE_MS,
  LOCAL_CHANGE_DEBOUNCE_MS,
  MOBILE_MAX_SYNC_FILE_SIZE_BYTES,
  merge3,
  toBase64,
  unpackBlob,
} from "@websync/shared";
import type { CryptoService } from "./CryptoService.js";
import type { DecodedFileListItem, RemoteApiClient } from "./RemoteApiClient.js";
import type { LocalIndex, LocalIndexRecord } from "./LocalIndex.js";
import type { FileSystemAdapter } from "./FileSystemAdapter.js";
import type { TransferTracker } from "../ui/TransferProgress.js";
import { t } from "../i18n/index.js";
import { WebSyncApiError } from "./httpClient.js";

/** Notes up to this size are kept as merge base and can be merged when edited on two devices. */
const MERGE_MAX_BYTES = 1024 * 1024;
const isMergeablePath = (path: string): boolean => /\.(md|txt)$/i.test(path);
const textDecoder = new TextDecoder("utf-8", { fatal: true });
const textEncoder = new TextEncoder();

function decodeText(bytes: Uint8Array): string | null {
  try {
    return textDecoder.decode(bytes);
  } catch {
    return null;
  }
}

export interface SyncEngineDeps {
  vaultId: string;
  crypto: CryptoService;
  remote: RemoteApiClient;
  fs: FileSystemAdapter;
  localIndex: LocalIndex;
  isPaused: () => boolean;
  /** True for any path owned by ConfigSyncEngine instead (`.obsidian/**`) - skipped here so the two engines never both try to handle the same remote item. */
  isConfigPath: (path: string) => boolean;
  /**
   * True while a note is being co-edited live (collab/CollabManager.ts). Its
   * content then reaches this device through the live session, so the file
   * version from the server must NOT be written over the open editor - that
   * would overwrite what the other device typed a moment ago. Uploads and
   * renames/deletes are unaffected. Optional so the engine works without collab.
   */
  isCollabLive?: (fileId: string) => boolean;
  /** Receives the progress of uploads/downloads (explorer rings). Optional so the engine works without UI. */
  transfers?: TransferTracker;
  /** The vault-wide `currentVersion` this device last fully applied - the `since=` cursor for incremental polling. */
  initialGlobalVersion: number;
  onStateChange: (state: { lastSyncAt: string; globalVersion: number }) => void | Promise<void>;
  /** True while the account is read-only (trial / subscription over): uploads are skipped instead of being refused one by one. */
  isReadOnly?: () => boolean;
  /** The server refused a write because the account is read-only (402) or the storage quota is used up (413). */
  onWriteRefused?: (reason: "read-only" | "storage-full") => void;
}

type LocalEventType = "create" | "modify" | "delete";

/**
 * Empty folders are synced through one hidden marker file per folder (see FOLDER_MARKER_FILENAME). These helpers
 * recognise such paths; the marker is never a TFile (Obsidian ignores dot-files), so it is handled separately.
 */
function isMarkerPath(path: string): boolean {
  return path === FOLDER_MARKER_FILENAME || path.endsWith(`/${FOLDER_MARKER_FILENAME}`);
}

function markerPathFor(folderPath: string): string {
  return `${folderPath}/${FOLDER_MARKER_FILENAME}`;
}

function isHiddenFolder(folderPath: string): boolean {
  return folderPath.split("/").some((segment) => segment.startsWith("."));
}

/**
 * The core sync engine. Three entry points drive it:
 *  - `runFullSync()`: initial reconciliation against the whole remote file
 *    list (called on startup and from the "Jetzt synchronisieren" button).
 *  - `handleLocalEvent()` / `handleLocalRename()`: registered against
 *    Obsidian's vault `create`/`modify`/`delete`/`rename` events, debounced
 *    per path.
 *  - `runIncrementalPoll()`: called on an interval (and once on load/focus)
 *    to pick up changes made by other devices.
 *
 * A per-fileId async lock (`withFileLock`) makes sure a local upload and a
 * remote download of the *same* file can never race each other, regardless
 * of which of the three entry points triggered them.
 */
export class SyncEngine {
  private readonly debounceTimers = new Map<string, ReturnType<typeof window.setTimeout>>();
  private readonly fileLocks = new Map<string, Promise<unknown>>();
  /** File ids already warned about as oversized-for-mobile this session, so the Notice doesn't repeat on every poll/full-sync pass. */
  private readonly warnedOversizedIds = new Set<string>();
  /** "Still editing this file" session ids (by fileId), folding a burst of saves into one history entry. */
  private readonly editSessions = new Map<string, { id: string; at: number }>();
  private syncing = false;
  private currentGlobalVersion: number;

  /** Read by the status bar UI - true while a full sync or incremental poll is in flight. */
  get isSyncing(): boolean {
    return this.syncing;
  }

  constructor(private readonly deps: SyncEngineDeps) {
    this.currentGlobalVersion = deps.initialGlobalVersion;
  }

  dispose(): void {
    for (const timer of this.debounceTimers.values()) window.clearTimeout(timer);
    this.debounceTimers.clear();
  }

  /**
   * The id of the "still editing this file" session used to fold a burst of saves into one history entry - see
   * `HISTORY_EDIT_SESSION_IDLE_MS`. Refreshed on every upload; `endEditSession` starts a fresh one on the next one
   * (called by main.ts when a different note becomes active in the workspace).
   */
  private touchEditSession(fileId: string): string {
    const now = Date.now();
    const existing = this.editSessions.get(fileId);
    if (existing && now - existing.at < HISTORY_EDIT_SESSION_IDLE_MS) {
      existing.at = now;
      return existing.id;
    }
    const fresh = { id: crypto.randomUUID(), at: now };
    this.editSessions.set(fileId, fresh);
    return fresh.id;
  }

  /** Ends the edit session for `fileId` early (it stopped being the active note) - its next edit starts a new history entry. */
  endEditSession(fileId: string): void {
    this.editSessions.delete(fileId);
  }

  // ============================================================
  // Public entry points
  // ============================================================

  async runFullSync(): Promise<void> {
    if (this.deps.isPaused() || this.syncing) return;
    this.syncing = true;
    // A full sync moves the cursor while it works. If it dies half way, the files it did not reach must be fetched
    // again by the next poll - so the cursor goes back to where it was instead of staying at the newest version seen.
    const cursorBefore = this.currentGlobalVersion;
    try {
      await this.doFullSync();
      await this.persistState();
    } catch (err) {
      this.currentGlobalVersion = cursorBefore;
      throw err;
    } finally {
      this.syncing = false;
    }
  }

  async runIncrementalPoll(): Promise<void> {
    if (this.deps.isPaused() || this.syncing) return;
    this.syncing = true;
    try {
      await this.doIncrementalPoll();
      await this.persistState();
    } finally {
      this.syncing = false;
    }
  }

  handleLocalEvent(type: LocalEventType, file: TAbstractFile): void {
    if (this.deps.isPaused()) return;
    if (file instanceof TFolder) {
      if (type === "modify" || file.isRoot() || isHiddenFolder(file.path)) return;
      const path = file.path;
      this.scheduleDebounced(`folder:${path}`, () => (type === "delete" ? this.processFolderDelete(path) : this.processFolderCreate(path)));
      return;
    }
    if (!(file instanceof TFile)) return;
    this.scheduleDebounced(file.path, () => this.processLocalChange(type, file.path));
  }

  handleLocalRename(file: TAbstractFile, oldPath: string): void {
    if (this.deps.isPaused()) return;
    if (file instanceof TFolder) {
      if (file.isRoot() || isHiddenFolder(file.path)) return;
      const newPath = file.path;
      this.scheduleDebounced(`folder:${newPath}`, () => this.processFolderRename(oldPath, newPath));
      return;
    }
    if (!(file instanceof TFile)) return;
    this.clearDebounce(oldPath);
    this.scheduleDebounced(file.path, () => this.processLocalRename(oldPath, file.path));
  }

  // ============================================================
  // Debounce (per local path)
  // ============================================================

  private scheduleDebounced(key: string, action: () => Promise<void>): void {
    this.clearDebounce(key);
    const timer = window.setTimeout(() => {
      this.debounceTimers.delete(key);
      action().catch((err) => {
        if ((err as { status?: unknown } | null)?.status === 402) this.deps.onWriteRefused?.("read-only");
        console.error(`WebSync: lokale Änderung an "${key}" konnte nicht synchronisiert werden`, err);
      });
    }, LOCAL_CHANGE_DEBOUNCE_MS);
    this.debounceTimers.set(key, timer);
  }

  private clearDebounce(key: string): void {
    const timer = this.debounceTimers.get(key);
    if (timer !== undefined) {
      window.clearTimeout(timer);
      this.debounceTimers.delete(key);
    }
  }

  // ============================================================
  // Per-file async lock, so a local upload and a remote download of the
  // same fileId can never interleave.
  // ============================================================

  private async withFileLock<T>(fileId: string, action: () => Promise<T>): Promise<T> {
    const previous = this.fileLocks.get(fileId) ?? Promise.resolve();
    const run = previous.then(action, action);
    // Store a settle-tracking promise (never rejects) so the NEXT queued
    // operation on this fileId always runs, even if this one failed.
    this.fileLocks.set(
      fileId,
      run.then(
        () => undefined,
        () => undefined,
      ),
    );
    return run;
  }

  // ============================================================
  // Local event handling
  // ============================================================

  private async processLocalChange(type: LocalEventType, path: string): Promise<void> {
    if (type === "delete") {
      const record = await this.deps.localIndex.getByPath(path);
      if (!record) return; // never synced, nothing to tell the server
      // Some delete events are not real deletes (e.g. a case-only rename on a case-insensitive disk): trust the disk.
      if (await this.deps.fs.existsOnDisk(path)) return;
      await this.withFileLock(record.fileId, () => this.deleteRemote(record));
      return;
    }

    const file = this.deps.fs.getFileByPath(path);
    if (!file) return; // vanished again before the debounce fired

    const record = await this.deps.localIndex.getByPath(path);
    const fileId = record?.fileId ?? crypto.randomUUID();

    await this.withFileLock(fileId, async () => {
      const plaintext = await this.deps.fs.readBinary(file);
      const hash = await this.deps.crypto.hashContent(plaintext);
      if (record && record.lastContentHashBlinded === toBase64(hash)) return; // no real content change (e.g. mtime-only touch)
      await this.uploadFile(file, fileId, { plaintext, hash });
    });
  }

  private async processLocalRename(oldPath: string, newPath: string): Promise<void> {
    const record = await this.deps.localIndex.getByPath(oldPath);
    if (!record) {
      // We never knew the old path (e.g. created+renamed within one
      // debounce window) - treat it as a fresh upload at the new path.
      await this.processLocalChange("create", newPath);
      return;
    }
    await this.withFileLock(record.fileId, async () => {
      const encryptedPath = await this.deps.crypto.encryptPath(newPath);
      await this.deps.remote.renameFile(this.deps.vaultId, record.fileId, encryptedPath.ciphertext, encryptedPath.iv);
      await this.deps.localIndex.put({ ...record, localPath: newPath, lastSyncedAt: new Date().toISOString() });
    });
  }

  // ============================================================
  // Empty folders (marker files)
  // ============================================================

  /** A folder appeared locally: if it is (still) empty, give it a marker so it exists on the other devices, too. */
  private async processFolderCreate(path: string): Promise<void> {
    const folder = this.deps.fs.getFolderByPath(path);
    if (!folder || folder.children.length > 0) return;
    const markerPath = markerPathFor(path);
    if (await this.deps.localIndex.getByPath(markerPath)) return;
    const fileId = crypto.randomUUID();
    await this.withFileLock(fileId, () => this.uploadMarker(fileId, markerPath));
  }

  /**
   * A folder was deleted locally: remove its marker and every synced file below it, so it disappears on the other devices,
   * too. Obsidian does not reliably send a delete event for each file inside a deleted folder (on mobile often only the
   * folder's own event arrives), so the files are looked up in the index instead of waiting for their events.
   */
  private async processFolderDelete(path: string): Promise<void> {
    if (this.deps.fs.getFolderByPath(path)) return; // re-created in the meantime
    const prefix = `${path}/`;
    const inside = (await this.deps.localIndex.getAll()).filter((record) => record.localPath.startsWith(prefix));
    for (const record of inside) {
      if (await this.deps.fs.existsOnDisk(record.localPath)) continue; // moved back / re-created meanwhile
      await this.withFileLock(record.fileId, () => this.deleteRemote(record));
    }
  }

  private async processFolderRename(oldPath: string, newPath: string): Promise<void> {
    const record = await this.deps.localIndex.getByPath(markerPathFor(oldPath));
    if (!record) return;
    const newMarker = markerPathFor(newPath);
    await this.withFileLock(record.fileId, async () => {
      const encryptedPath = await this.deps.crypto.encryptPath(newMarker);
      await this.deps.remote.renameFile(this.deps.vaultId, record.fileId, encryptedPath.ciphertext, encryptedPath.iv);
      await this.deps.localIndex.put({ ...record, localPath: newMarker, lastSyncedAt: new Date().toISOString() });
    });
  }

  private async uploadMarker(fileId: string, markerPath: string): Promise<void> {
    const plaintext = new Uint8Array(0);
    const hash = await this.deps.crypto.hashContent(plaintext);
    const encryptedContent = await this.deps.crypto.encryptContent(plaintext);
    const encryptedPath = await this.deps.crypto.encryptPath(markerPath);
    const result = await this.deps.remote.uploadFile(this.deps.vaultId, fileId, {
      pathCiphertext: encryptedPath.ciphertext,
      pathNonce: encryptedPath.iv,
      contentHashBlinded: hash,
      contentSize: 0,
      contentIv: encryptedContent.iv,
      contentCiphertext: encryptedContent.ciphertext,
    });
    await this.deps.fs.writeMarker(markerPath);
    await this.deps.localIndex.put({
      fileId,
      localPath: markerPath,
      lastKnownVersion: result.version,
      lastContentHashBlinded: toBase64(hash),
      lastSyncedAt: new Date().toISOString(),
    });
    this.noteOwnWrite(result.version);
  }

  /** Runs inside the file's lock; the record is looked up again because a folder delete and the file's own event race. */
  private async deleteRemote(record: LocalIndexRecord): Promise<void> {
    if (!(await this.deps.localIndex.get(record.fileId))) return; // already handled
    await this.deps.remote.deleteFile(this.deps.vaultId, record.fileId);
    await this.deps.localIndex.delete(record.fileId);
  }

  // ============================================================
  // Full sync (initial reconciliation)
  //
  // Three phases, in order:
  //  A. Reconcile everything the local index already knows about, by
  //     fileId (covers the common "normal restart" case).
  //  B. Remote files with no local-index entry yet, matched by decrypted
  //     path against local files (covers "new device links an existing
  //     vault whose files are already present locally").
  //  C. Local files nobody above accounted for -> brand-new uploads.
  // ============================================================

  private async doFullSync(): Promise<void> {
    const localFiles = this.deps.fs.listAllFiles();
    const localByPath = new Map(localFiles.map((f) => [f.path, f] as const));

    const indexRecords = await this.deps.localIndex.getAll();
    const knownFileIds = new Set(indexRecords.map((r) => r.fileId));

    const remoteResp = await this.deps.remote.listFiles(this.deps.vaultId, 0, true);
    const remoteById = new Map(remoteResp.files.map((item) => [item.id, item] as const));
    this.bumpGlobalVersion(remoteResp.currentVersion);

    const handledPaths = new Set<string>();

    // Files the index knows but that are gone locally were deleted while the plugin could not see it (app closed, or on
    // mobile suspended before the debounced delete ran). Those deletes are pushed below - unless so much is missing that
    // it looks like a broken or moved vault rather than a user action; then the files are restored instead.
    const tracked = indexRecords.filter((r) => !isMarkerPath(r.localPath) && !this.deps.isConfigPath(r.localPath));
    const missing = tracked.filter((r) => !localByPath.has(r.localPath)).length;
    const allowLocalDeletes = missing <= 10 || missing <= tracked.length / 2;
    if (!allowLocalDeletes) {
      console.warn(`WebSync: ${missing} von ${tracked.length} Dateien fehlen lokal - sie werden wiederhergestellt statt gelöscht.`);
      new Notice(t("p.sync.missingLocal", { count: missing }));
    }

    // --- Phase A ---
    for (const record of indexRecords) {
      await this.withFileLock(record.fileId, () =>
        this.reconcileIndexedRecord(record, remoteById, localByPath, handledPaths, allowLocalDeletes),
      );
    }

    // --- Phase B ---
    for (const item of remoteResp.files) {
      if (item.isDeleted || knownFileIds.has(item.id)) continue;

      let path: string;
      try {
        path = await this.deps.crypto.decryptPath(item.pathCiphertext, item.pathNonce);
      } catch (err) {
        console.error(`WebSync: Pfad für Datei ${item.id} konnte nicht entschlüsselt werden - übersprungen.`, err);
        continue;
      }
      if (this.deps.isConfigPath(path) || handledPaths.has(path)) continue;

      await this.withFileLock(item.id, async () => {
        const localFile = localByPath.get(path);
        if (localFile) {
          await this.reconcileExisting(item, path, localFile);
        } else {
          await this.downloadFile(item, path);
        }
      });
      handledPaths.add(path);
    }

    // --- Phase C ---
    for (const [path, file] of localByPath) {
      if (handledPaths.has(path)) continue;
      const fileId = crypto.randomUUID();
      await this.withFileLock(fileId, () => this.uploadFile(file, fileId));
      handledPaths.add(path);
    }

    // --- Phase D: empty local folders get a marker so they exist on the other devices as well ---
    for (const folder of this.deps.fs.listEmptyFolders()) {
      const markerPath = markerPathFor(folder.path);
      if (handledPaths.has(markerPath) || (await this.deps.localIndex.getByPath(markerPath))) continue;
      const fileId = crypto.randomUUID();
      await this.withFileLock(fileId, () => this.uploadMarker(fileId, markerPath));
      handledPaths.add(markerPath);
    }
  }

  private async reconcileIndexedRecord(
    record: LocalIndexRecord,
    remoteById: Map<string, DecodedFileListItem>,
    localByPath: Map<string, TFile>,
    handledPaths: Set<string>,
    allowLocalDeletes: boolean,
  ): Promise<void> {
    const remoteItem = remoteById.get(record.fileId);
    const localFile = localByPath.get(record.localPath);
    handledPaths.add(record.localPath);

    if (!remoteItem) {
      // Server has no memory of this fileId at all (e.g. vault reset server-side).
      if (localFile) await this.uploadFile(localFile, record.fileId);
      else await this.deps.localIndex.delete(record.fileId);
      return;
    }

    if (remoteItem.isDeleted) {
      if (isMarkerPath(record.localPath)) {
        await this.applyRemoteDelete(record.fileId, record.localPath);
      } else if (!localFile) {
        await this.deps.localIndex.delete(record.fileId);
        await this.deps.fs.pruneEmptyParents(record.localPath); // the file is gone already, but its folder may be left empty
      } else if (await this.remoteDeleteWins(record, localFile, remoteItem.updatedAt)) {
        await this.applyRemoteDelete(record.fileId, record.localPath);
      } else {
        await this.uploadFile(localFile, record.fileId); // local edit after remote delete wins (LWW) - resurrects it server-side
      }
      this.bumpGlobalVersion(remoteItem.version);
      return;
    }

    let path: string;
    try {
      path = await this.deps.crypto.decryptPath(remoteItem.pathCiphertext, remoteItem.pathNonce);
    } catch (err) {
      console.error(`WebSync: Pfad für Datei ${remoteItem.id} konnte nicht entschlüsselt werden - übersprungen.`, err);
      return;
    }

    if (path !== record.localPath) {
      await this.deps.fs.renamePath(record.localPath, path); // no-op if the local file is already missing
      handledPaths.add(path);
    }

    const currentLocalFile = this.deps.fs.getFileByPath(path) ?? localByPath.get(path);
    if (!currentLocalFile) {
      const remoteUnchanged = toBase64(remoteItem.contentHashBlinded) === record.lastContentHashBlinded;
      const samePath = path === record.localPath;
      if (isMarkerPath(path)) {
        // The marker is a dot-file Obsidian never indexes. Its folder being gone means the folder was deleted here.
        if (allowLocalDeletes && remoteUnchanged && samePath && !(await this.deps.fs.existsOnDisk(parentOf(path)))) {
          await this.deleteRemote(record);
        } else {
          await this.downloadFile(remoteItem, path);
        }
        return;
      }
      if (await this.deps.fs.existsOnDisk(path)) {
        // On disk but not in Obsidian's index (unknown extension): only fetch it when another device changed it.
        if (!remoteUnchanged) await this.downloadFile(remoteItem, path);
        return;
      }
      if (allowLocalDeletes && remoteUnchanged && samePath) {
        // Deleted here while the plugin was not running, and nobody changed it since: the delete goes to the server.
        await this.deleteRemote(record);
        return;
      }
      // Changed on another device since the last sync (that edit wins over the delete), or renamed remotely: restore it.
      await this.downloadFile(remoteItem, path);
      return;
    }

    await this.reconcileExisting(remoteItem, path, currentLocalFile);
  }

  // ============================================================
  // Incremental poll (picks up changes made by other devices since
  // `currentGlobalVersion`)
  // ============================================================

  private async doIncrementalPoll(): Promise<void> {
    const since = this.currentGlobalVersion;
    const remoteResp = await this.deps.remote.listFiles(this.deps.vaultId, since, true);
    // Oldest first, and the cursor follows item by item: if one of them throws, everything after it is still ahead of
    // the cursor and gets fetched again by the next poll instead of being skipped for good.
    const changes = [...remoteResp.files].sort((a, b) => a.version - b.version);
    for (const item of changes) {
      await this.withFileLock(item.id, () => this.applyRemoteChange(item));
      this.bumpGlobalVersion(item.version);
    }
    this.bumpGlobalVersion(remoteResp.currentVersion);
  }

  private async applyRemoteChange(item: DecodedFileListItem): Promise<void> {
    const record = await this.deps.localIndex.get(item.id);

    if (item.isDeleted) {
      if (record) {
        const localFile = this.deps.fs.getFileByPath(record.localPath);
        if (isMarkerPath(record.localPath)) {
          await this.applyRemoteDelete(item.id, record.localPath);
        } else if (!localFile) {
          await this.deps.localIndex.delete(item.id);
          await this.deps.fs.pruneEmptyParents(record.localPath); // the file is gone already, but its folder may be left empty
        } else if (await this.remoteDeleteWins(record, localFile, item.updatedAt)) {
          await this.applyRemoteDelete(item.id, record.localPath);
        } else {
          await this.uploadFile(localFile, item.id); // local edit after remote delete wins (LWW)
        }
      }
      this.bumpGlobalVersion(item.version);
      return;
    }

    let path: string;
    try {
      path = await this.deps.crypto.decryptPath(item.pathCiphertext, item.pathNonce);
    } catch (err) {
      console.error(`WebSync: Pfad für Datei ${item.id} konnte nicht entschlüsselt werden - übersprungen.`, err);
      return;
    }
    if (this.deps.isConfigPath(path)) return;

    if (record && record.localPath !== path) {
      await this.deps.fs.renamePath(record.localPath, path);
    }

    const localFile = this.deps.fs.getFileByPath(path);
    if (!localFile) {
      await this.downloadFile(item, path);
      return;
    }
    await this.reconcileExisting(item, path, localFile);
  }

  // ============================================================
  // Shared reconciliation / transfer primitives
  // ============================================================

  /**
   * --- Conflict resolution policy ---
   * Both a local file and a remote (non-deleted) file exist for the same
   * path/fileId. If their content hashes already match, there's nothing to
   * do. Otherwise content differs on at least one side since the last sync:
   * there is no merge UI and no `expected_version` check anywhere in this
   * codebase. If the local index remembers what was synced last, a side that
   * did not change since then never overwrites the one that did. Only when both
   * changed (or nothing is known) does the strictly newer timestamp win, and
   * the other side is silently overwritten. Ties (identical millisecond
   * timestamps) favor the remote side, arbitrarily but deterministically.
   * Exception: for Markdown/text notes both-changed is first tried as a three-way merge against the text of the last
   * sync (`LocalIndex` keeps it), see `tryMerge`. Only when that cannot combine the edits does the newer side win -
   * and the other one is then saved as a conflict copy next to the note instead of being thrown away.
   */
  private async reconcileExisting(item: DecodedFileListItem, path: string, localFile: TFile): Promise<void> {
    const localBytes = await this.deps.fs.readBinary(localFile);
    const localHash = await this.deps.crypto.hashContent(localBytes);
    const localHashBase64 = toBase64(localHash);
    const remoteHashBase64 = toBase64(item.contentHashBlinded);

    if (localHashBase64 === remoteHashBase64) {
      // Both sides already agree on content - just refresh bookkeeping.
      await this.deps.localIndex.put({
        fileId: item.id,
        localPath: path,
        lastKnownVersion: item.version,
        lastContentHashBlinded: remoteHashBase64,
        lastSyncedAt: new Date().toISOString(),
      });
      await this.rememberBase(item.id, path, localBytes, localHashBase64);
      this.bumpGlobalVersion(item.version);
      return;
    }

    // What both sides looked like at the last sync tells who actually changed something. Timestamps alone are wrong
    // here: a rename on another device bumps the server's `updatedAt` without touching the content and would make
    // that side "newer" than a local edit that was not uploaded yet, and the clocks of the devices are not in step.
    const lastHash = (await this.deps.localIndex.get(item.id))?.lastContentHashBlinded;
    let remoteWins: boolean;
    if (lastHash === remoteHashBase64) remoteWins = false; // the server content is the one we last synced: only the local side changed
    else if (lastHash === localHashBase64) remoteWins = true; // the local file is the one we last synced: only the remote side changed
    else remoteWins = this.isRemoteNewer(item.updatedAt, this.deps.fs.getMtime(localFile)); // both changed (or no history): newer wins

    const bothChanged = lastHash !== remoteHashBase64 && lastHash !== localHashBase64;
    const live = this.deps.isCollabLive?.(item.id) ?? false;
    if (bothChanged && !live && isMergeablePath(path) && (await this.tryMerge(item, path, localFile, localBytes, lastHash, remoteWins))) return;

    if (remoteWins) {
      if (live) return; // the live session already carries this content
      await this.downloadFile(item, path);
    } else {
      await this.uploadFile(localFile, item.id, { plaintext: localBytes, hash: localHash });
    }
  }

  /** Remembers the text of a small note as the merge base for its next conflict (best effort - merging just stays off without it). */
  private async rememberBase(fileId: string, path: string, plaintext: Uint8Array, hashBase64: string): Promise<void> {
    if (!isMergeablePath(path) || plaintext.byteLength > MERGE_MAX_BYTES) {
      await this.deps.localIndex.deleteBase(fileId).catch(() => undefined);
      return;
    }
    const text = decodeText(plaintext);
    try {
      if (text === null) await this.deps.localIndex.deleteBase(fileId);
      else await this.deps.localIndex.putBase({ fileId, hash: hashBase64, text });
    } catch (err) {
      console.warn("WebSync: Merge-Basis konnte nicht gespeichert werden", err);
    }
  }

  private async fetchRemotePlaintext(item: DecodedFileListItem): Promise<Uint8Array> {
    const blob = await this.deps.remote.downloadBlob(this.deps.vaultId, item.id, item.contentSize);
    const { ciphertext, iv } = unpackBlob(blob);
    return this.deps.crypto.decryptContent(ciphertext, iv);
  }

  /**
   * Both sides edited a note since the last sync. With the text of that sync as common ancestor the two edits are merged
   * (and the result written here and uploaded), so nothing is lost. Without an ancestor, or when the same lines were
   * changed differently, nothing is merged: the loser of the timestamp rule is then saved as a conflict copy and `false`
   * is returned so the caller applies the usual "newer wins".
   */
  private async tryMerge(
    item: DecodedFileListItem,
    path: string,
    localFile: TFile,
    localBytes: Uint8Array,
    lastHash: string | undefined,
    remoteWins: boolean,
  ): Promise<boolean> {
    if (localBytes.byteLength > MERGE_MAX_BYTES || item.contentSize > MERGE_MAX_BYTES) return false;
    let remoteBytes: Uint8Array;
    try {
      remoteBytes = await this.fetchRemotePlaintext(item);
    } catch (err) {
      console.warn("WebSync: Server-Version für den Merge nicht ladbar", err);
      return false;
    }
    const localText = decodeText(localBytes);
    const remoteText = decodeText(remoteBytes);
    if (localText === null || remoteText === null) return false;

    const base = lastHash ? await this.deps.localIndex.getBase(item.id).catch(() => undefined) : undefined;
    const merged = base && base.hash === lastHash ? merge3(base.text, localText, remoteText) : null;

    if (merged === null) {
      await this.saveConflictCopy(path, remoteWins ? localText : remoteText);
      return false;
    }
    if (merged === remoteText) {
      await this.downloadFile(item, path);
    } else if (merged === localText) {
      await this.uploadFile(localFile, item.id, { plaintext: localBytes, hash: await this.deps.crypto.hashContent(localBytes) });
    } else {
      const bytes = textEncoder.encode(merged);
      await this.deps.fs.writeBinary(path, bytes);
      const file = this.deps.fs.getFileByPath(path) ?? localFile;
      await this.uploadFile(file, item.id, { plaintext: bytes, hash: await this.deps.crypto.hashContent(bytes) });
      new Notice(t("merge.merged", { path }), 8000);
    }
    return true;
  }

  /** Puts the text that is about to lose against the other version next to the note (it syncs like any new note). */
  private async saveConflictCopy(path: string, text: string): Promise<void> {
    const base = path.replace(/\.(md|txt)$/i, "");
    const ext = path.slice(base.length) || ".md";
    const stamp = new Date().toISOString().slice(0, 16).replace("T", " ").replace(":", "-");
    let candidate = `${base} (${t("merge.conflictStamp")} ${stamp})${ext}`;
    for (let counter = 2; (await this.deps.fs.existsOnDisk(candidate)); counter++) {
      candidate = `${base} (${t("merge.conflictStamp")} ${stamp} ${counter})${ext}`;
    }
    try {
      await this.deps.fs.writeBinary(candidate, textEncoder.encode(text));
      new Notice(t("merge.conflictCopy", { path, copy: candidate }), 12_000);
    } catch (err) {
      console.error("WebSync: Konfliktkopie konnte nicht erstellt werden", err);
    }
  }

  /**
   * A file was deleted on the server but still exists here. If it is exactly what was synced last, nobody edited it, so
   * the delete is the only change and must win - whatever the timestamps say (a re-downloaded file has a fresh mtime and
   * device clocks differ; going by time alone brought deleted folders back). Only a local edit made after the last sync
   * is weighed against the delete by timestamp.
   */
  private async remoteDeleteWins(record: LocalIndexRecord, localFile: TFile, remoteUpdatedAt: string): Promise<boolean> {
    const localHash = toBase64(await this.deps.crypto.hashContent(await this.deps.fs.readBinary(localFile)));
    if (localHash === record.lastContentHashBlinded) return true;
    return this.isRemoteNewer(remoteUpdatedAt, this.deps.fs.getMtime(localFile));
  }

  private isRemoteNewer(remoteUpdatedAt: string, localMtimeMs: number): boolean {
    return new Date(remoteUpdatedAt).getTime() >= localMtimeMs;
  }

  private async uploadFile(
    file: TFile,
    fileId: string,
    precomputed?: { plaintext: Uint8Array; hash: Uint8Array },
  ): Promise<void> {
    if (Platform.isMobile && file.stat.size > MOBILE_MAX_SYNC_FILE_SIZE_BYTES) {
      if (!this.warnedOversizedIds.has(fileId)) {
        this.warnedOversizedIds.add(fileId);
        new Notice(
          t("p.sync.tooBigMobile", { path: file.path, size: formatBytes(file.stat.size) }),
        );
      }
      return;
    }

    // Read-only account: every write would be refused, so don't even encrypt and send. The file stays un-synced and
    // is picked up by the full sync that runs when the account can write again.
    if (this.deps.isReadOnly?.()) return;

    const transferPath = file.path;
    this.deps.transfers?.begin(transferPath);
    let result: { version: number };
    let hash: Uint8Array;
    let uploadedPlaintext: Uint8Array;
    try {
      const plaintext = precomputed?.plaintext ?? (await this.deps.fs.readBinary(file));
      uploadedPlaintext = plaintext;
      hash = precomputed?.hash ?? (await this.deps.crypto.hashContent(plaintext));
      const encryptedContent = await this.deps.crypto.encryptContent(plaintext);
      const encryptedPath = await this.deps.crypto.encryptPath(file.path);

      result = await this.deps.remote.uploadFile(
        this.deps.vaultId,
        fileId,
        {
          pathCiphertext: encryptedPath.ciphertext,
          pathNonce: encryptedPath.iv,
          contentHashBlinded: hash,
          contentSize: plaintext.byteLength,
          contentIv: encryptedContent.iv,
          contentCiphertext: encryptedContent.ciphertext,
          editSessionId: this.touchEditSession(fileId),
        },
        (loaded, total) => this.deps.transfers?.progress(transferPath, loaded, total),
      );
    } catch (err) {
      // A refused upload must not abort the whole sync run (the other files still have to go through).
      if (this.handleRefusedUpload(err, file)) return;
      throw err;
    } finally {
      this.deps.transfers?.end(transferPath);
    }

    await this.deps.localIndex.put({
      fileId,
      localPath: file.path,
      lastKnownVersion: result.version,
      lastContentHashBlinded: toBase64(hash),
      lastSyncedAt: new Date().toISOString(),
    });
    await this.rememberBase(fileId, file.path, uploadedPlaintext, toBase64(hash));
    this.noteOwnWrite(result.version);
  }

  /**
   * The server says "not this file": account read-only (402), file over the size limit or storage full (413 with a
   * `code`). Tells the user once and lets the sync carry on. Returns false for every other error.
   */
  private handleRefusedUpload(err: unknown, file: TFile): boolean {
    if (!(err instanceof WebSyncApiError)) return false;
    const body = (err.body ?? {}) as { code?: string; maxFileBytes?: number };
    if (err.status === 402) {
      this.deps.onWriteRefused?.("read-only");
      return true;
    }
    if (err.status === 413 && body.code === "file_too_large") {
      if (!this.warnedOversizedIds.has(file.path)) {
        this.warnedOversizedIds.add(file.path);
        new Notice(t("p.sync.tooBigServer", { path: file.path, size: formatBytes(file.stat.size), limit: formatBytes(body.maxFileBytes ?? 0) }), 15_000);
      }
      return true;
    }
    if (err.status === 413 && body.code === "quota_exceeded") {
      this.deps.onWriteRefused?.("storage-full");
      return true;
    }
    return false;
  }

  private async downloadFile(item: DecodedFileListItem, path: string): Promise<void> {
    if (isMarkerPath(path)) {
      // Folder marker: nothing to download, just make sure the (empty) folder exists here.
      await this.deps.fs.writeMarker(path);
      await this.deps.localIndex.put({
        fileId: item.id,
        localPath: path,
        lastKnownVersion: item.version,
        lastContentHashBlinded: toBase64(item.contentHashBlinded),
        lastSyncedAt: new Date().toISOString(),
      });
      this.bumpGlobalVersion(item.version);
      return;
    }

    if (Platform.isMobile && item.contentSize > MOBILE_MAX_SYNC_FILE_SIZE_BYTES) {
      if (!this.warnedOversizedIds.has(item.id)) {
        this.warnedOversizedIds.add(item.id);
        new Notice(
          t("p.sync.tooBigMobile", { path, size: formatBytes(item.contentSize) }),
        );
      }
      return;
    }

    this.deps.transfers?.begin(path);
    let downloaded: Uint8Array;
    try {
      const blob = await this.deps.remote.downloadBlob(this.deps.vaultId, item.id, item.contentSize, (loaded, total) =>
        this.deps.transfers?.progress(path, loaded, total),
      );
      const { ciphertext, iv } = unpackBlob(blob);
      const plaintext = await this.deps.crypto.decryptContent(ciphertext, iv);
      await this.deps.fs.writeBinary(path, plaintext);
      downloaded = plaintext;
    } finally {
      this.deps.transfers?.end(path);
    }
    await this.deps.localIndex.put({
      fileId: item.id,
      localPath: path,
      lastKnownVersion: item.version,
      lastContentHashBlinded: toBase64(item.contentHashBlinded),
      lastSyncedAt: new Date().toISOString(),
    });
    await this.rememberBase(item.id, path, downloaded, toBase64(item.contentHashBlinded));
    this.bumpGlobalVersion(item.version);
  }

  private async applyRemoteDelete(fileId: string, path: string): Promise<void> {
    await this.deps.fs.deleteByPath(path);
    await this.deps.localIndex.delete(fileId);
  }

  private bumpGlobalVersion(version: number): void {
    if (version > this.currentGlobalVersion) this.currentGlobalVersion = version;
  }

  /**
   * The server numbers every write of the vault consecutively, so our own write may only move the cursor when it is the
   * very next number. Anything else means another device wrote in between; jumping over that version would make the next
   * poll (`since=cursor`) miss the change for good. Our own write is then simply fetched again by the next poll, where it
   * turns out to match the local file.
   */
  private noteOwnWrite(version: number): void {
    if (version === this.currentGlobalVersion + 1) this.currentGlobalVersion = version;
  }

  private async persistState(): Promise<void> {
    await this.deps.onStateChange({
      lastSyncAt: new Date().toISOString(),
      globalVersion: this.currentGlobalVersion,
    });
  }
}

/** `"a/b/c"` -> `"a/b"`, `""` at the top level. */
function parentOf(path: string): string {
  const slash = path.lastIndexOf("/");
  return slash <= 0 ? "" : path.slice(0, slash);
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB"];
  let value = bytes / 1024;
  let unitIndex = 0;
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex++;
  }
  return `${value.toFixed(1)} ${units[unitIndex]}`;
}

export type { LocalIndexRecord };
