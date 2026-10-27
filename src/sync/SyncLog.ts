/**
 * What the sync did, newest last: the model behind the "Sync log" dialog (ui/SyncLogModal.ts). It stores codes and
 * arguments instead of finished sentences, so the dialog speaks the interface language of the moment, not the one the
 * entry was written in. The last entries are kept in `sync-log.json` next to the plugin so they survive a restart.
 */
import type { App } from "obsidian";

export type LogKind =
  | "up"
  | "down"
  | "delete-up"
  | "delete-down"
  | "rename-up"
  | "rename-down"
  | "merged"
  | "conflict"
  | "skipped"
  | "live-join"
  | "live-leave"
  | "settings-up"
  | "settings-down"
  | "summary"
  | "error";

/** Why a file went up or down - what the sync saw, so "why did my phone download this again?" has an answer. */
export type LogReason = "new" | "local" | "remote" | "newer" | "restored";

export interface LogEntry {
  at: number;
  kind: LogKind;
  path?: string;
  why?: LogReason;
  /** Kind-specific: the old path of a rename, the name of a conflict copy, the two counts of a summary, an error message. */
  args?: (string | number)[];
}

export type NewLogEntry = Omit<LogEntry, "at">;

const MAX_ENTRIES = 500;
const SAVE_DELAY_MS = 3000;
const MAX_ARG_LENGTH = 300;

export class SyncLog {
  private entries: LogEntry[] = [];
  private readonly listeners = new Set<() => void>();
  private readonly totals = new Map<LogKind, number>();
  private saveTimer: ReturnType<typeof setTimeout> | null = null;
  private dirty = false;

  constructor(
    private readonly app: App,
    private readonly filePath: string,
  ) {}

  async load(): Promise<void> {
    try {
      const adapter = this.app.vault.adapter;
      if (!(await adapter.exists(this.filePath))) return;
      const parsed: unknown = JSON.parse(await adapter.read(this.filePath));
      if (!Array.isArray(parsed)) return;
      const loaded = parsed.filter(isEntry).slice(-MAX_ENTRIES);
      // Whatever was logged while the file was being read stays after it.
      this.entries = [...loaded, ...this.entries].slice(-MAX_ENTRIES);
      this.notify();
    } catch {
      /* an unreadable log is just an empty one */
    }
  }

  add(entry: NewLogEntry): void {
    const args = entry.args?.map((arg) => (typeof arg === "string" && arg.length > MAX_ARG_LENGTH ? `${arg.slice(0, MAX_ARG_LENGTH)}…` : arg));
    const next: LogEntry = { ...entry, args, at: Date.now() };
    const last = this.entries[this.entries.length - 1];
    // The same failure on every poll must not fill the log.
    if (last && next.kind === "error" && last.kind === "error" && last.path === next.path && last.args?.[0] === next.args?.[0]) {
      last.at = next.at;
    } else {
      this.entries.push(next);
      if (this.entries.length > MAX_ENTRIES) this.entries.splice(0, this.entries.length - MAX_ENTRIES);
    }
    this.totals.set(entry.kind, (this.totals.get(entry.kind) ?? 0) + 1);
    this.dirty = true;
    this.scheduleSave();
    this.notify();
  }

  /** How many entries of this kind were added since the plugin started - lets a run report what it did. */
  total(kind: LogKind): number {
    return this.totals.get(kind) ?? 0;
  }

  /** Newest first. */
  list(): LogEntry[] {
    return [...this.entries].reverse();
  }

  get size(): number {
    return this.entries.length;
  }

  clear(): void {
    this.entries = [];
    this.dirty = true;
    this.scheduleSave();
    this.notify();
  }

  onChange(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Writes what is pending now (shutdown). */
  async flush(): Promise<void> {
    if (this.saveTimer !== null) clearTimeout(this.saveTimer);
    this.saveTimer = null;
    await this.save();
  }

  private notify(): void {
    for (const listener of this.listeners) listener();
  }

  private scheduleSave(): void {
    if (this.saveTimer !== null) return;
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null;
      void this.save();
    }, SAVE_DELAY_MS);
  }

  private async save(): Promise<void> {
    if (!this.dirty) return;
    this.dirty = false;
    try {
      await this.app.vault.adapter.write(this.filePath, JSON.stringify(this.entries));
    } catch (err) {
      console.warn("WebSync: Sync-Log konnte nicht gespeichert werden", err);
    }
  }
}

function isEntry(value: unknown): value is LogEntry {
  if (typeof value !== "object" || value === null) return false;
  const entry = value as Record<string, unknown>;
  return typeof entry.at === "number" && typeof entry.kind === "string";
}
