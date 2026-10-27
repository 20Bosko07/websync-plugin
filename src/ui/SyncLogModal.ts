import { Modal, Notice, TFile, setIcon, type App } from "obsidian";
import { currentLocale, t, type MessageKey } from "../i18n/index.js";
import type { LogEntry, LogKind, SyncLog } from "../sync/SyncLog.js";

const ICONS: Record<LogKind, string> = {
  up: "arrow-up",
  down: "arrow-down",
  "delete-up": "trash-2",
  "delete-down": "trash-2",
  "rename-up": "pencil",
  "rename-down": "pencil",
  merged: "git-merge",
  conflict: "alert-triangle",
  skipped: "ban",
  "live-join": "users",
  "live-leave": "users",
  "settings-up": "settings",
  "settings-down": "settings",
  summary: "check",
  error: "alert-circle",
};

/** Rows that need a look: shown in colour. */
const PROBLEMS = new Set<LogKind>(["conflict", "skipped", "error"]);

const isProblem = (entry: LogEntry): boolean => PROBLEMS.has(entry.kind) || (entry.kind === "summary" && Boolean(entry.args?.[2]));

/** The dialog behind "Sync log" in the sync menu: what was synced when, newest first. */
export class SyncLogModal extends Modal {
  private listEl!: HTMLElement;
  private offChange: (() => void) | null = null;
  private renderTimer: number | null = null;
  private onlyProblems = false;

  constructor(
    app: App,
    private readonly log: SyncLog,
  ) {
    super(app);
  }

  onOpen(): void {
    this.modalEl.addClass("websync-log");
    this.titleEl.setText(t("p.log.title"));

    const bar = this.contentEl.createDiv({ cls: "websync-log-bar" });
    const filter = bar.createEl("label", { cls: "websync-log-filter" });
    const box = filter.createEl("input", { type: "checkbox" });
    filter.createSpan({ text: t("p.log.onlyProblems") });
    box.addEventListener("change", () => {
      this.onlyProblems = box.checked;
      this.render();
    });
    const copy = bar.createEl("button", { text: t("p.log.copy") });
    copy.addEventListener("click", () => void this.copy());
    const clear = bar.createEl("button", { text: t("p.log.clear") });
    clear.addEventListener("click", () => this.log.clear());

    this.listEl = this.contentEl.createDiv({ cls: "websync-log-list" });
    this.offChange = this.log.onChange(() => this.scheduleRender());
    this.render();
  }

  onClose(): void {
    this.offChange?.();
    this.offChange = null;
    if (this.renderTimer !== null) window.clearTimeout(this.renderTimer);
    this.contentEl.empty();
  }

  /** A big first sync adds entries by the dozen per second - the list is redrawn at most twice a second. */
  private scheduleRender(): void {
    if (this.renderTimer !== null) return;
    this.renderTimer = window.setTimeout(() => {
      this.renderTimer = null;
      this.render();
    }, 500);
  }

  private render(): void {
    const entries = this.log.list().filter((entry) => !this.onlyProblems || isProblem(entry));
    this.listEl.empty();
    if (entries.length === 0) {
      this.listEl.createDiv({ cls: "websync-log-empty", text: t(this.onlyProblems ? "p.log.noProblems" : "p.log.empty") });
      return;
    }
    let day = "";
    for (const entry of entries) {
      const entryDay = dayLabel(entry.at);
      if (entryDay !== day) {
        day = entryDay;
        this.listEl.createDiv({ cls: "websync-log-day", text: day });
      }
      this.renderRow(entry);
    }
  }

  private renderRow(entry: LogEntry): void {
    const row = this.listEl.createDiv({ cls: "websync-log-row" });
    if (isProblem(entry)) row.addClass("is-problem");
    setIcon(row.createSpan({ cls: "websync-log-icon" }), ICONS[entry.kind]);
    const body = row.createDiv({ cls: "websync-log-body" });
    body.createDiv({ cls: "websync-log-text", text: describe(entry) });
    if (entry.path) {
      const file = this.app.vault.getAbstractFileByPath(entry.path);
      const pathEl = body.createDiv({ cls: "websync-log-path", text: entry.path });
      if (file instanceof TFile) {
        pathEl.addClass("is-link");
        pathEl.addEventListener("click", () => {
          this.close();
          void this.app.workspace.getLeaf(false).openFile(file);
        });
      }
    }
    const extra = detail(entry);
    if (extra) body.createDiv({ cls: "websync-log-detail", text: extra });
    row.createSpan({ cls: "websync-log-time", text: new Date(entry.at).toLocaleTimeString(currentLocale()) });
  }

  private async copy(): Promise<void> {
    const text = this.log
      .list()
      .map((entry) => [new Date(entry.at).toLocaleString(currentLocale()), describe(entry), entry.path ?? "", detail(entry)].filter(Boolean).join(" | "))
      .join("\n");
    try {
      await navigator.clipboard.writeText(text);
      new Notice(t("p.log.copied"));
    } catch {
      new Notice(t("p.log.copyFailed"));
    }
  }
}

function dayLabel(at: number): string {
  const date = new Date(at);
  const today = new Date();
  if (date.toDateString() === today.toDateString()) return t("p.log.today");
  const yesterday = new Date(today.getTime() - 86_400_000);
  if (date.toDateString() === yesterday.toDateString()) return t("p.log.yesterday");
  return date.toLocaleDateString(currentLocale(), { dateStyle: "medium" });
}

function describe(entry: LogEntry): string {
  if (entry.kind === "summary") {
    const [up, down, failed] = entry.args ?? [0, 0, 0];
    if (failed) return t("p.log.summaryFailed", { up, down, failed });
    if (!up && !down) return t("p.log.summaryNone");
    return t("p.log.summary", { up, down });
  }
  return t(`p.log.kind.${entry.kind}` as MessageKey);
}

/** The second line: why it happened, how big it was, the old name, the error. */
function detail(entry: LogEntry): string {
  const parts: string[] = [];
  const first = entry.args?.[0];
  switch (entry.kind) {
    case "up":
    case "down":
      if (entry.why) parts.push(t(`p.log.why.${entry.why}` as MessageKey));
      if (typeof first === "number") parts.push(formatSize(first));
      break;
    case "skipped":
      if (typeof first === "number") parts.push(t("p.log.skippedSize", { size: formatSize(first) }));
      break;
    case "rename-up":
    case "rename-down":
      if (typeof first === "string") parts.push(t("p.log.renamedFrom", { path: first }));
      break;
    case "conflict":
      if (typeof first === "string") parts.push(t("p.log.copySaved", { path: first }));
      break;
    case "error":
      for (const arg of entry.args ?? []) if (typeof arg === "string") parts.push(arg);
      break;
  }
  return parts.join(" · ");
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(bytes < 10 * 1024 ? 1 : 0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
