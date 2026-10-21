import { t } from "../i18n/index.js";
import { ItemView, TFile, setIcon, type WorkspaceLeaf } from "obsidian";
import { actionIcon, actionLabel, dayLabel, displayPath, entryKind, fromBase64, timeLabel, whoLabel, type RevisionEntry } from "@websync/shared";
import type WebSyncPlugin from "../main.js";
import { baseName, formatBytes } from "./historyFormat.js";

export const HISTORY_VIEW_TYPE = "websync-history";

/**
 * Version history in the sidebar (right by default, movable like any Obsidian view) - the same panel as in the web
 * workspace: the versions of the active file (or of the file picked via t("p.history") in its menu) with diff,
 * restore and "save as copy", or the change log of the whole vault.
 */
export class HistoryView extends ItemView {
  private mode: "file" | "vault" = "file";
  /** A file picked via the file menu; it wins until another file becomes active. */
  private pin: { fileId: string; activePath: string | null } | null = null;
  private entries: RevisionEntry[] = [];
  private nextBefore: number | null = null;
  private retentionDays = 0;
  private loading = false;
  private error: string | null = null;
  private selectedId: string | null = null;
  private loadedFor: string | null = null;
  private query = "";
  private onlyDeleted = false;
  private showSettings = false;
  private request = 0;
  private reloadTimer: number | null = null;

  constructor(
    leaf: WorkspaceLeaf,
    private readonly plugin: WebSyncPlugin,
  ) {
    super(leaf);
  }

  getViewType(): string {
    return HISTORY_VIEW_TYPE;
  }

  getDisplayText(): string {
    return t("p.history");
  }

  getIcon(): string {
    return "history";
  }

  async onOpen(): Promise<void> {
    this.contentEl.addClass("websync-history");
    this.registerEvent(this.app.workspace.on("file-open", () => this.mode === "file" && void this.reload()));
    // After an edit the upload runs a moment later (debounce + transfer): look again once it had time to land.
    this.registerEvent(
      this.app.vault.on("modify", (file) => {
        if (this.mode === "file" && file.path === this.app.workspace.getActiveFile()?.path) this.scheduleReload(5000);
      }),
    );
    await this.reload();
  }

  async onClose(): Promise<void> {
    if (this.reloadTimer !== null) window.clearTimeout(this.reloadTimer);
  }

  /** Called from the file menu / commands: shows `file`'s versions (or the active file's). */
  async showFile(file?: TFile | null): Promise<void> {
    this.mode = "file";
    this.pin = null;
    const active = this.app.workspace.getActiveFile()?.path ?? null;
    if (file && file.path !== active) {
      const id = await this.fileIdOf(file.path);
      if (id) this.pin = { fileId: id, activePath: active };
    }
    await this.reload(true);
  }

  /** Sync (re)started or stopped: the view may have shown "not connected" so far. */
  refresh(): void {
    void this.reload();
  }

  async showVault(): Promise<void> {
    this.mode = "vault";
    await this.reload(true);
  }

  private scheduleReload(ms: number): void {
    if (this.reloadTimer !== null) window.clearTimeout(this.reloadTimer);
    this.reloadTimer = window.setTimeout(() => {
      this.reloadTimer = null;
      void this.reload();
    }, ms);
  }

  // ------------------------------------------------------------------
  // Data
  // ------------------------------------------------------------------

  private get vaultId(): string | null {
    return this.plugin.settings.linkedVault?.vaultId ?? null;
  }

  private async fileIdOf(path: string): Promise<string | null> {
    try {
      return (await this.plugin.localIndex?.getByPath(path))?.fileId ?? null;
    } catch {
      return null;
    }
  }

  /** File id the t("p.modeFile") mode shows, or null (no file / file not synced yet). */
  private async targetFileId(): Promise<string | null> {
    const active = this.app.workspace.getActiveFile()?.path ?? null;
    if (this.pin && this.pin.activePath === active) return this.pin.fileId;
    this.pin = null;
    return active ? this.fileIdOf(active) : null;
  }

  private async reload(force = false): Promise<void> {
    const vaultId = this.vaultId;
    if (!vaultId || !this.plugin.cryptoService.isUnlocked() || !this.plugin.localIndex) {
      this.entries = [];
      this.error = t("p.notConnected");
      this.render();
      return;
    }
    const fileId = this.mode === "file" ? await this.targetFileId() : null;
    const key = this.mode === "file" ? `file:${fileId}` : "vault";
    if (key !== this.loadedFor || force) this.selectedId = null;
    this.loadedFor = key;
    if (this.mode === "file" && !fileId) {
      this.entries = [];
      this.error = null;
      this.loading = false;
      this.render();
      return;
    }
    await this.loadPage(vaultId, fileId ?? undefined);
  }

  private async loadPage(vaultId: string, fileId?: string, before?: number): Promise<void> {
    const id = ++this.request;
    this.loading = true;
    this.error = null;
    this.render();
    try {
      const page = await this.plugin.remoteApi.getHistory(vaultId, fileId, before);
      const decrypted = await Promise.all(
        page.revisions.map(async (r): Promise<RevisionEntry> => {
          let path: string | null = null;
          try {
            path = await this.plugin.cryptoService.decryptPath(fromBase64(r.pathCiphertext), fromBase64(r.pathNonce));
          } catch {
            /* shown as unreadable */
          }
          return {
            id: r.id,
            fileId: r.fileId,
            version: r.version,
            action: r.action,
            path,
            size: r.contentSize,
            hash: r.contentHashBlinded,
            hasContent: r.hasContent,
            deviceName: r.deviceName,
            userEmail: r.userEmail,
            createdAt: r.createdAt,
          };
        }),
      );
      if (id !== this.request) return;
      this.entries = before ? [...this.entries, ...decrypted] : decrypted;
      this.nextBefore = page.nextBefore;
      this.retentionDays = page.retentionDays;
    } catch (err) {
      if (id === this.request) this.error = err instanceof Error ? err.message : t("p.historyLoadFailed");
    } finally {
      if (id === this.request) {
        this.loading = false;
        this.render();
      }
    }
  }

  // ------------------------------------------------------------------
  // Rendering
  // ------------------------------------------------------------------

  private render(): void {
    const el = this.contentEl;
    el.empty();

    const toggle = el.createDiv({ cls: "websync-history-toggle" });
    for (const [mode, label] of [
      ["file", t("p.modeFile")],
      ["vault", t("p.modeVault")],
    ] as const) {
      const button = toggle.createEl("button", { text: label, cls: this.mode === mode ? "is-active" : "" });
      button.onclick = () => {
        this.mode = mode;
        void this.reload(true);
      };
    }

    if (this.mode === "file") this.renderFile(el);
    else this.renderVault(el);

    if (this.loading) el.createDiv({ cls: "websync-history-empty", text: t("p.loading") });
    if (this.error) el.createDiv({ cls: "websync-history-empty mod-error", text: this.error });
    if (this.nextBefore && !this.loading) {
      const more = el.createEl("button", { cls: "websync-history-more", text: t("p.loadOlder") });
      more.onclick = () => {
        const vaultId = this.vaultId;
        if (!vaultId || !this.nextBefore) return;
        void this.targetFileId().then((fileId) => this.loadPage(vaultId, this.mode === "file" ? (fileId ?? undefined) : undefined, this.nextBefore ?? undefined));
      };
    }
    if (this.retentionDays > 0) {
      el.createDiv({
        cls: "websync-history-footer",
        text:
          this.mode === "file"
            ? t("p.footerFile", { days: this.retentionDays })
            : t("p.footerVault", { days: this.retentionDays }),
      });
    }
  }

  private renderFile(el: HTMLElement): void {
    const first = this.entries[0];
    const active = this.app.workspace.getActiveFile();
    if (!first && !this.loading && !this.error) {
      el.createDiv({
        cls: "websync-history-empty",
        text: active ? t("p.noHistory") : t("p.noFile"),
      });
      return;
    }
    if (!first) return;

    const title = el.createDiv({ cls: "websync-history-title" });
    const path = this.pin || !active ? displayPath(first) : active.path;
    title.createSpan({ cls: "websync-history-name", text: baseName(path), attr: { title: path } });
    if (first.action === "delete") title.createSpan({ cls: "websync-history-faint", text: t("p.deletedSuffix") });
    const refresh = title.createDiv({ cls: "clickable-icon", attr: { "aria-label": t("p.reload") } });
    setIcon(refresh, "refresh-cw");
    refresh.onclick = () => void this.reload();

    const accounts = new Set(this.entries.map((e) => e.userEmail).filter(Boolean)).size > 1;
    const list = el.createDiv({ cls: "websync-history-list" });
    this.entries.forEach((entry, index) => {
      const row = list.createDiv({ cls: `websync-history-item${entry.id === this.selectedId ? " is-selected" : ""}` });
      const icon = row.createDiv({ cls: `websync-history-icon is-${entry.action}` });
      setIcon(icon, actionIcon(entry));
      const body = row.createDiv({ cls: "websync-history-body" });
      const head = body.createDiv({ cls: "websync-history-line", text: `${dayLabel(entry.createdAt)}, ${timeLabel(entry.createdAt)}` });
      if (this.mode === "file" && index === 0 && entry.action !== "delete") head.createSpan({ cls: "websync-history-badge", text: t("p.current") });
      const size = entry.action !== "rename" && entry.action !== "delete" ? ` · ${formatBytes(entry.size)}` : "";
      body.createDiv({ cls: "websync-history-note", text: `${actionLabel(entry)} · ${whoLabel(entry, accounts)}${size}` });
      row.onclick = () => {
        this.selectedId = entry.id;
        this.render();
        void this.plugin.openRevisionDiff(entry.fileId, entry.id);
      };
    });
  }

  private renderVault(el: HTMLElement): void {
    const filters = el.createDiv({ cls: "websync-history-filters" });
    const searchRow = filters.createDiv({ cls: "websync-history-title" });
    const search = searchRow.createEl("input", { type: "search", placeholder: t("p.filter"), value: this.query });
    const refresh = searchRow.createDiv({ cls: "clickable-icon", attr: { "aria-label": t("p.reload") } });
    setIcon(refresh, "refresh-cw");
    refresh.onclick = () => void this.reload();
    search.oninput = () => {
      this.query = search.value;
      this.renderVaultList(listHost);
    };
    for (const [key, label] of [
      ["onlyDeleted", t("p.onlyDeleted")],
      ["showSettings", t("p.settings")],
    ] as const) {
      const wrap = filters.createEl("label", { cls: "websync-history-check" });
      const box = wrap.createEl("input", { type: "checkbox" });
      box.checked = this[key];
      box.onchange = () => {
        this[key] = box.checked;
        this.renderVaultList(listHost);
      };
      wrap.appendText(` ${label}`);
    }
    const listHost = el.createDiv({ cls: "websync-history-list" });
    this.renderVaultList(listHost);
  }

  private renderVaultList(host: HTMLElement): void {
    host.empty();
    const q = this.query.trim().toLowerCase();
    const accounts = new Set(this.entries.map((e) => e.userEmail).filter(Boolean)).size > 1;
    let day = "";
    let shown = 0;
    for (const entry of this.entries) {
      const kind = entryKind(entry);
      if (!this.showSettings && kind === "settings") continue;
      if (this.onlyDeleted && entry.action !== "delete") continue;
      const path = displayPath(entry);
      if (q && !path.toLowerCase().includes(q) && !(entry.deviceName ?? "").toLowerCase().includes(q)) continue;
      const label = dayLabel(entry.createdAt);
      if (label !== day) {
        day = label;
        host.createDiv({ cls: "websync-history-day", text: label });
      }
      shown++;
      const row = host.createDiv({ cls: "websync-history-item" });
      setIcon(row.createDiv({ cls: `websync-history-icon is-${entry.action}` }), actionIcon(entry));
      const body = row.createDiv({ cls: "websync-history-body" });
      body.createDiv({ cls: `websync-history-line${entry.action === "delete" ? " is-deleted" : ""}`, text: path, attr: { title: path } });
      body.createDiv({ cls: "websync-history-note", text: `${timeLabel(entry.createdAt)} · ${actionLabel(entry)} · ${whoLabel(entry, accounts)}` });
      if (kind !== "folder") {
        row.onclick = () => {
          this.mode = "file";
          this.pin = { fileId: entry.fileId, activePath: this.app.workspace.getActiveFile()?.path ?? null };
          this.selectedId = entry.id;
          void this.reload(true);
          void this.plugin.openRevisionDiff(entry.fileId, entry.id);
        };
      }
    }
    if (shown === 0 && !this.loading && !this.error) {
      host.createDiv({ cls: "websync-history-empty", text: this.entries.length === 0 ? t("p.noChanges") : t("p.noMatches") });
    }
  }
}
