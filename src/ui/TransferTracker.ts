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
  /** A single edit waiting for its debounce: shows its circle, but does not make the status icon say "syncing" yet. */
  passive?: boolean;
  /** Once a circle was shown for it, it keeps showing (no blinking when others finish around it) until it is done. */
  shown?: boolean;
  /** When it finished. */
  doneAt?: number;
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

/** A batch of this many files shows all its circles at once; a smaller one only after the delays below. */
const BATCH_MIN_FILES = 3;
/** How long the finished (full) rings stay on screen after the last file. */
const LINGER_MS = 900;
/** A finished file keeps its full circle this long, then it goes - the others of the batch are still running. */
const DONE_SHOWN_MS = 600;

export class TransferTracker {
  private readonly transfers = new Map<string, Transfer>();
  private clearTimer: ReturnType<typeof setTimeout> | null = null;

  /**
   * `delayMs`: how long a running transfer takes before it gets a circle (a tiny file is done before that - no flash).
   * `queuedDelayMs`: the same for a change that only waits (an ordinary edit is sent within the debounce window).
   */
  constructor(
    private readonly delayMs = 250,
    private readonly queuedDelayMs = 3000,
  ) {}

  /** Files a sync is about to move: grey circles until their turn comes. Already running or finished ones are kept. */
  queue(paths: Iterable<string>, now = Date.now(), passive = false): void {
    this.cancelClear();
    for (const path of paths) {
      const existing = this.transfers.get(path);
      if (existing && existing.state !== "done") continue;
      this.transfers.set(path, { state: "queued", loaded: 0, total: 0, since: now, passive });
    }
  }

  /** Files that turned out not to need a transfer (same content on both sides, refused): no ring for them. */
  dropQueued(): void {
    for (const [path, transfer] of this.transfers) if (transfer.state === "queued") this.transfers.delete(path);
    this.finishIfIdle();
  }

  /** One waiting file that did not turn into a transfer after all (nothing changed): no circle for it. */
  release(path: string): void {
    if (this.transfers.get(path)?.state !== "queued") return;
    this.transfers.delete(path);
    this.finishIfIdle();
  }

  begin(path: string, total = 0, now = Date.now()): void {
    this.cancelClear();
    const existing = this.transfers.get(path);
    // The circle counts from the real start. One that was shown while the change waited simply goes on.
    this.transfers.set(path, { state: "active", loaded: 0, total, since: now, shown: existing?.shown });
  }

  progress(path: string, loaded: number, total: number): void {
    const transfer = this.transfers.get(path);
    if (transfer) {
      transfer.loaded = loaded;
      transfer.total = total;
    }
  }

  end(path: string, now = Date.now()): void {
    const transfer = this.transfers.get(path);
    if (transfer) {
      transfer.state = "done";
      transfer.doneAt = now;
      transfer.loaded = Math.max(transfer.total, 1);
      transfer.total = Math.max(transfer.total, 1);
    }
    this.finishIfIdle();
  }

  /** Something is queued or running (a lone edit that only waits for its debounce does not count). */
  get active(): boolean {
    for (const transfer of this.transfers.values()) if (transfer.state !== "done" && !(transfer.passive && transfer.state === "queued")) return true;
    return false;
  }

  private fractionOf(transfer: Transfer): number {
    if (transfer.state === "done") return 1;
    if (transfer.state === "queued") return 0;
    return transfer.total > 0 ? Math.min(1, transfer.loaded / transfer.total) : 0;
  }

  /**
   * The entries worth a ring right now: all of a batch of several files, a running transfer that takes a moment, a change
   * that waits for long. Once an entry has a ring it keeps it (also when the batch shrinks around it).
   */
  private shown(now: number): Array<[string, Transfer]> {
    const entries = [...this.transfers.entries()];
    const batch = entries.length >= BATCH_MIN_FILES;
    return entries.filter(([, transfer]) => {
      if (transfer.shown) return true;
      const wait = transfer.state === "queued" ? this.queuedDelayMs : this.delayMs;
      if (batch || (transfer.state !== "done" && now - transfer.since >= wait)) {
        transfer.shown = true;
        return true;
      }
      return false;
    });
  }

  /** A finished file loses its circle a moment after it is done; the rest of the batch goes on. */
  private stillShown(transfer: Transfer, now: number): boolean {
    return transfer.state !== "done" || now - (transfer.doneAt ?? now) < DONE_SHOWN_MS;
  }

  files(now = Date.now()): FileRing[] {
    return this.shown(now)
      .filter(([, transfer]) => this.stillShown(transfer, now))
      .map(([path, transfer]) => ({ path, fraction: this.fractionOf(transfer), state: transfer.state }));
  }

  /**
   * A ring per folder that still has something of the batch below it (down to the last level). It fills with what is done of
   * everything the batch holds for that folder - finished files count, though their own circle is gone - and goes when the last
   * file in it is done.
   */
  folders(now = Date.now()): FolderRing[] {
    const sums = new Map<string, { sum: number; count: number; live: boolean }>();
    for (const [path, transfer] of this.shown(now)) {
      const value = this.fractionOf(transfer);
      const live = this.stillShown(transfer, now);
      const parts = path.split("/");
      for (let depth = 1; depth < parts.length; depth++) {
        const folder = parts.slice(0, depth).join("/");
        const entry = sums.get(folder) ?? { sum: 0, count: 0, live: false };
        entry.sum += value;
        entry.count += 1;
        entry.live ||= live;
        sums.set(folder, entry);
      }
    }
    return [...sums.entries()].filter(([, { live }]) => live).map(([path, { sum, count }]) => ({ path, fraction: sum / count }));
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
