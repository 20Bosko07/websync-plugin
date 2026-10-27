import type { App } from "obsidian";
import { TRANSFER_PROGRESS_DELAY_MS, TRANSFER_QUEUED_DELAY_MS } from "@websync/shared";
import { t, tn } from "../i18n/index.js";
import { TransferTracker } from "./TransferTracker.js";

export { TransferTracker };

/** The tracker with the delay the whole product uses for "a transfer worth showing". */
export function createTransferTracker(): TransferTracker {
  return new TransferTracker(TRANSFER_PROGRESS_DELAY_MS, TRANSFER_QUEUED_DELAY_MS);
}

const RING_CLASS = "websync-progress-ring";
const RADIUS = 6;
const CIRCUMFERENCE = 2 * Math.PI * RADIUS;
const SVG_NS = "http://www.w3.org/2000/svg";

/** The red circle with an exclamation mark of a file that could not be synced. */
function createFailRing(): SVGSVGElement {
  const svg = document.createElementNS(SVG_NS, "svg");
  svg.setAttribute("class", `${RING_CLASS} is-failed`);
  svg.setAttribute("viewBox", "0 0 16 16");
  svg.setAttribute("width", "14");
  svg.setAttribute("height", "14");
  const circle = document.createElementNS(SVG_NS, "circle");
  circle.setAttribute("class", "websync-fail-circle");
  circle.setAttribute("cx", "8");
  circle.setAttribute("cy", "8");
  circle.setAttribute("r", String(RADIUS));
  svg.appendChild(circle);
  for (const d of ["M8 4.6v4", "M8 11.3v.01"]) {
    const mark = document.createElementNS(SVG_NS, "path");
    mark.setAttribute("class", "websync-fail-mark");
    mark.setAttribute("d", d);
    svg.appendChild(mark);
  }
  return svg;
}

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
 * Draws a small circle into Obsidian's file explorer for every file and folder that a sync still has to move: an empty
 * grey circle while it waits, filling while it is transferred (a folder fills with everything below it, down to the last
 * level), gone when the batch is finished. The explorer re-renders rows on its own, so the rings are re-attached on every
 * tick instead of being created once.
 */
export class ExplorerProgressRings {
  private timer: number | null = null;
  /** Whether the last tick drew anything - an idle tick with nothing to remove does no DOM work. */
  private drawn = false;

  constructor(
    private readonly app: App,
    private readonly tracker: TransferTracker,
    /** A tap on a red "!" circle: the sync log says what went wrong. */
    private readonly onFailedClick: () => void = () => undefined,
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
    const now = Date.now();
    const files = this.tracker.files(now);
    const folders = this.tracker.folders(now);
    const wanted = new Map<string, { fraction: number; queued: boolean; failed?: string }>();
    // Failures first: a progress ring of a new attempt takes the row over from them.
    for (const folder of this.tracker.failedFolders()) wanted.set(folder.path, { fraction: 0, queued: false, failed: tn("p.fail.folder", folder.count) });
    for (const file of this.tracker.failedFiles()) wanted.set(file.path, { fraction: 0, queued: false, failed: file.reason });
    for (const file of files) wanted.set(file.path, { fraction: file.fraction, queued: file.state === "queued" });
    for (const folder of folders) wanted.set(folder.path, { fraction: folder.fraction, queued: folder.fraction === 0 });
    if (wanted.size === 0 && !this.drawn) return;
    this.drawn = wanted.size > 0;

    for (const leaf of this.app.workspace.getLeavesOfType("file-explorer")) {
      const container = leaf.view.containerEl;
      for (const ring of Array.from(container.querySelectorAll<SVGSVGElement>(`.${RING_CLASS}`))) {
        const owner = ring.closest<HTMLElement>(".nav-file-title, .nav-folder-title");
        if (!owner || !wanted.has(owner.dataset.path ?? "")) ring.remove();
      }
      for (const [path, { fraction, queued, failed }] of wanted) {
        const title = container.querySelector<HTMLElement>(`.nav-file-title[data-path="${CSS.escape(path)}"], .nav-folder-title[data-path="${CSS.escape(path)}"]`);
        if (!title) continue;
        let ring = title.querySelector<SVGSVGElement>(`:scope > .${RING_CLASS}`);
        if (ring && ring.classList.contains("is-failed") !== (failed !== undefined)) {
          ring.remove(); // progress <-> failed: a different drawing
          ring = null;
        }
        if (!ring) {
          ring = failed !== undefined ? createFailRing() : createRing();
          if (failed !== undefined) {
            ring.addEventListener("click", (event) => {
              event.preventDefault();
              event.stopPropagation();
              this.onFailedClick();
            });
          }
          // Files: before the extension tag (notes have none: at the end). Folders: at the end of the row.
          const tag = title.classList.contains("nav-file-title") ? title.querySelector(".nav-file-tag") : null;
          if (tag) title.insertBefore(ring, tag);
          else title.appendChild(ring);
        }
        if (failed !== undefined) {
          const label = t("p.fail.ring", { reason: failed });
          ring.setAttribute("aria-label", label);
          ring.setAttribute("data-reason", label);
          ring.querySelector("title")?.remove();
          const tip = document.createElementNS(SVG_NS, "title");
          tip.textContent = label;
          ring.prepend(tip);
          continue;
        }
        const bar = ring.querySelector<SVGCircleElement>(".websync-progress-bar");
        // Waiting = just the grey circle; once it moves there is always a visible start of the arc.
        const length = queued ? 0 : CIRCUMFERENCE * Math.max(0.04, fraction);
        bar?.setAttribute("stroke-dasharray", `${length} ${CIRCUMFERENCE}`);
        ring.setAttribute("aria-label", queued ? "" : `${Math.round(fraction * 100)} %`);
      }
    }
  }
}
