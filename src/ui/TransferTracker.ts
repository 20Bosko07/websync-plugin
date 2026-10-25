/**
 * What the sync is moving, by vault path - the model behind the explorer rings and the "syncing" status. No Obsidian
 * dependency, so the arithmetic can be tested on its own.
 *
 * A file is `queued` (a sync found that it has to go up or down, its turn has not come yet), `active` (being
 * transferred) or `done` (finished while the batch still runs). A ring is shown per file and per folder: queued is an
 * empty grey circle, it fills as files in it are transferred. When nothing is queued or active any more the batch is over
 * and every ring goes away.
 */
type State = "queued" | "active" | "done";

interface Transfer {
  state: State;
  loaded: number;
  total: number;
  /** When it was first seen (queued or started). */
  since: number;
}

export interface FileRing {
  path: string;
  /** 0..1 */
  fraction: number;
  state: State;
}

export interface FolderRing {
  path: string;
  /** 0..1 over everything below the folder that is part of the batch. */
  fraction: number;
}

/** A single quick transfer (a note saved) must not flash a ring: it shows after this long, or as part of a batch. */
const BATCH_MIN_FILES = 3;
/** How long the finished (full) rings stay on screen after the last file. */
const LINGER_MS = 900;

export class TransferTracker {
  private readonly transfers = new Map<string, Transfer>();
  private clearTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(private readonly delayMs = 2000) {}

  /** Files a sync is about to move: grey circles until their turn comes. Already running or finished ones are kept. */
  queue(paths: Iterable<string>, now = Date.now()): void {
    this.cancelClear();
    for (const path of paths) {
      const existing = this.transfers.get(path);
      if (existing && existing.state !== "done") continue;
      this.transfers.set(path, { state: "queued", loaded: 0, total: 0, since: now });
    }
  }

  /** Files that turned out not to need a transfer (same content on both sides, refused): no ring for them. */
  dropQueued(): void {
    for (const [path, transfer] of this.transfers) if (transfer.state === "queued") this.transfers.delete(path);
    this.finishIfIdle();
  }

  begin(path: string, total = 0, now = Date.now()): void {
    this.cancelClear();
    const existing = this.transfers.get(path);
    this.transfers.set(path, { state: "active", loaded: 0, total, since: existing && existing.state !== "done" ? existing.since : now });
  }

  progress(path: string, loaded: number, total: number): void {
    const transfer = this.transfers.get(path);
    if (transfer) {
      transfer.loaded = loaded;
      transfer.total = total;
    }
  }

  end(path: string): void {
    const transfer = this.transfers.get(path);
    if (transfer) {
      transfer.state = "done";
      transfer.loaded = Math.max(transfer.total, 1);
      transfer.total = Math.max(transfer.total, 1);
    }
    this.finishIfIdle();
  }

  /** Something is queued or running. */
  get active(): boolean {
    for (const transfer of this.transfers.values()) if (transfer.state !== "done") return true;
    return false;
  }

  private fractionOf(transfer: Transfer): number {
    if (transfer.state === "done") return 1;
    if (transfer.state === "queued") return 0;
    return transfer.total > 0 ? Math.min(1, transfer.loaded / transfer.total) : 0;
  }

  /** The entries worth a ring right now: all of a batch of several files, or a lone transfer that takes a while. */
  private shown(now: number): Array<[string, Transfer]> {
    const entries = [...this.transfers.entries()];
    const batch = entries.length >= BATCH_MIN_FILES;
    return entries.filter(([, transfer]) => batch || now - transfer.since >= this.delayMs);
  }

  files(now = Date.now()): FileRing[] {
    return this.shown(now).map(([path, transfer]) => ({ path, fraction: this.fractionOf(transfer), state: transfer.state }));
  }

  /** A ring per folder with something of the batch anywhere below it (down to the last level): the average over those files. */
  folders(now = Date.now()): FolderRing[] {
    const sums = new Map<string, { sum: number; count: number }>();
    for (const [path, transfer] of this.shown(now)) {
      const value = this.fractionOf(transfer);
      const parts = path.split("/");
      for (let depth = 1; depth < parts.length; depth++) {
        const folder = parts.slice(0, depth).join("/");
        const entry = sums.get(folder) ?? { sum: 0, count: 0 };
        entry.sum += value;
        entry.count += 1;
        sums.set(folder, entry);
      }
    }
    return [...sums.entries()].map(([path, { sum, count }]) => ({ path, fraction: sum / count }));
  }

  private finishIfIdle(): void {
    if (this.transfers.size === 0 || this.active) return;
    this.cancelClear();
    // The batch is over: let the full rings stay for a moment, then take them all away.
    this.clearTimer = setTimeout(() => {
      this.clearTimer = null;
      if (!this.active) this.transfers.clear();
    }, LINGER_MS);
  }

  private cancelClear(): void {
    if (this.clearTimer !== null) {
      clearTimeout(this.clearTimer);
      this.clearTimer = null;
    }
  }
}
