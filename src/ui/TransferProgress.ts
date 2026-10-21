import type { App } from "obsidian";
import { TRANSFER_PROGRESS_DELAY_MS } from "@websync/shared";

interface Transfer {
  loaded: number;
  total: number;
  startedAt: number;
}

/**
 * Uploads and downloads that are in flight, by vault path. The sync engine reports into it; the explorer rings below
 * (and the status icon) read from it.
 */
export class TransferTracker {
  private readonly transfers = new Map<string, Transfer>();

  begin(path: string, total = 0): void {
    this.transfers.set(path, { loaded: 0, total, startedAt: Date.now() });
  }

  progress(path: string, loaded: number, total: number): void {
    const transfer = this.transfers.get(path);
    if (transfer) {
      transfer.loaded = loaded;
      transfer.total = total;
    }
  }

  end(path: string): void {
    this.transfers.delete(path);
  }

  get active(): boolean {
    return this.transfers.size > 0;
  }

  /** Transfers running longer than the delay - the ones worth a ring. `fraction` is 0..1. */
  visible(now = Date.now()): Array<{ path: string; fraction: number }> {
    const out: Array<{ path: string; fraction: number }> = [];
    for (const [path, t] of this.transfers) {
      if (now - t.startedAt < TRANSFER_PROGRESS_DELAY_MS) continue;
      out.push({ path, fraction: t.total > 0 ? Math.min(1, t.loaded / t.total) : 0 });
    }
    return out;
  }
}

const RING_CLASS = "websync-progress-ring";
const RADIUS = 6;
const CIRCUMFERENCE = 2 * Math.PI * RADIUS;
const SVG_NS = "http://www.w3.org/2000/svg";

function createRing(): SVGSVGElement {
  const svg = document.createElementNS(SVG_NS, "svg");
  svg.setAttribute("class", RING_CLASS);
  svg.setAttribute("viewBox", "0 0 16 16");
  svg.setAttribute("width", "14");
  svg.setAttribute("height", "14");
  for (const cls of ["websync-progress-track", "websync-progress-bar"]) {
    const circle = document.createElementNS(SVG_NS, "circle");
    circle.setAttribute("class", cls);
    circle.setAttribute("cx", "8");
    circle.setAttribute("cy", "8");
    circle.setAttribute("r", String(RADIUS));
    svg.appendChild(circle);
  }
  return svg;
}

/**
 * Draws a small filling circle into Obsidian's file explorer, right before the file extension tag (or at the end of the
 * row for notes, which have no tag), for every transfer that takes longer than ~2 s. The explorer re-renders rows on its
 * own, so the rings are re-attached on every tick instead of being created once.
 */
export class ExplorerProgressRings {
  private timer: number | null = null;
  /** Whether the last tick drew anything - an idle tick with nothing to remove does no DOM work. */
  private drawn = false;

  constructor(
    private readonly app: App,
    private readonly tracker: TransferTracker,
  ) {}

  start(): void {
    if (this.timer !== null) return;
    this.timer = window.setInterval(() => this.render(), 250);
  }

  dispose(): void {
    if (this.timer !== null) window.clearInterval(this.timer);
    this.timer = null;
    for (const ring of Array.from(document.querySelectorAll(`.${RING_CLASS}`))) ring.remove();
  }

  private render(): void {
    const visible = this.tracker.visible();
    if (visible.length === 0 && !this.drawn) return;
    this.drawn = visible.length > 0;
    const containers = this.app.workspace.getLeavesOfType("file-explorer").map((leaf) => leaf.view.containerEl);
    const wanted = new Set(visible.map((v) => v.path));

    for (const container of containers) {
      for (const ring of Array.from(container.querySelectorAll<SVGSVGElement>(`.${RING_CLASS}`))) {
        const owner = ring.closest<HTMLElement>(".nav-file-title");
        if (!owner || !wanted.has(owner.dataset.path ?? "")) ring.remove();
      }
      for (const { path, fraction } of visible) {
        const title = container.querySelector<HTMLElement>(`.nav-file-title[data-path="${CSS.escape(path)}"]`);
        if (!title) continue;
        let ring = title.querySelector<SVGSVGElement>(`.${RING_CLASS}`);
        if (!ring) {
          ring = createRing();
          const tag = title.querySelector(".nav-file-tag");
          if (tag) title.insertBefore(ring, tag);
          else title.appendChild(ring);
        }
        const bar = ring.querySelector<SVGCircleElement>(".websync-progress-bar");
        bar?.setAttribute("stroke-dasharray", `${CIRCUMFERENCE * Math.max(0.03, fraction)} ${CIRCUMFERENCE}`);
        ring.setAttribute("aria-label", `${Math.round(fraction * 100)} %`);
      }
    }
  }
}
