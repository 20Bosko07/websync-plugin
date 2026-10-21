import { FOLDER_MARKER_FILENAME } from "./constants";
import type { FileRevisionAction } from "./dto";

/**
 * Presentation helpers for the version history, shared by the web workspace and the Obsidian plugin so both show the same
 * labels and the same diff. Icon names are lucide names (used by the web and by Obsidian's `setIcon`).
 */

/** A history entry with its path already decrypted (null when that failed). */
export interface RevisionEntry {
  id: string;
  fileId: string;
  version: number;
  action: FileRevisionAction;
  path: string | null;
  size: number;
  hash: string;
  hasContent: boolean;
  deviceName: string | null;
  userEmail: string | null;
  createdAt: string;
}

const baseName = (p: string) => p.slice(p.lastIndexOf("/") + 1);
const dirName = (p: string) => (p.lastIndexOf("/") === -1 ? "" : p.slice(0, p.lastIndexOf("/")));
const isHidden = (p: string) => p.split("/").some((s) => s.startsWith("."));

/** How an entry of the change log is shown: markers become folder events, `.obsidian/*` counts as settings. */
export type EntryKind = "file" | "folder" | "settings";

export function entryKind(entry: RevisionEntry): EntryKind {
  if (!entry.path) return "file";
  if (baseName(entry.path) === FOLDER_MARKER_FILENAME) return "folder";
  if (isHidden(entry.path)) return "settings";
  return "file";
}

/** Path to display: the folder for a folder marker. */
export function displayPath(entry: RevisionEntry): string {
  if (!entry.path) return texts.unreadablePath;
  return entryKind(entry) === "folder" ? dirName(entry.path) || "/" : entry.path;
}

/**
 * The words of the change log. Both clients (web workspace, Obsidian plugin) fill these in with their own translations via
 * `setHistoryTexts`; until then the log speaks English.
 */
export interface HistoryTexts {
  /** BCP 47 language of the dates ("de", "fr" ...). */
  locale: string;
  fileActions: Record<FileRevisionAction, string>;
  folderActions: Record<FileRevisionAction, string>;
  today: string;
  yesterday: string;
  unknownDevice: string;
  unreadablePath: string;
}

let texts: HistoryTexts = {
  locale: "en",
  fileActions: { create: "Created", modify: "Edited", rename: "Renamed / moved", delete: "Deleted", restore: "Restored" },
  folderActions: { create: "Folder created", modify: "Folder created", rename: "Folder renamed", delete: "Folder deleted", restore: "Folder restored" },
  today: "Today",
  yesterday: "Yesterday",
  unknownDevice: "Unknown device",
  unreadablePath: "(path not readable)",
};

export function setHistoryTexts(next: HistoryTexts): void {
  texts = next;
}

export function actionLabel(entry: RevisionEntry): string {
  return (entryKind(entry) === "folder" ? texts.folderActions : texts.fileActions)[entry.action];
}

export function actionIcon(entry: RevisionEntry): string {
  const folder = entryKind(entry) === "folder";
  switch (entry.action) {
    case "create":
      return folder ? "folder-plus" : "file-plus";
    case "delete":
      return folder ? "folder-x" : "file-x";
    case "rename":
      return "folder-input";
    case "restore":
      return "rotate-ccw";
    default:
      return "file-pen";
  }
}

/** "Today", "Yesterday" or the date - the day headings of the change log. */
export function dayLabel(iso: string, now = new Date()): string {
  const d = new Date(iso);
  const startOf = (x: Date) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const diff = Math.round((startOf(now) - startOf(d)) / 86_400_000);
  if (diff === 0) return texts.today;
  if (diff === 1) return texts.yesterday;
  return d.toLocaleDateString(texts.locale, { weekday: "long", day: "numeric", month: "long", year: "numeric" });
}

export function timeLabel(iso: string): string {
  return new Date(iso).toLocaleTimeString(texts.locale, { hour: "2-digit", minute: "2-digit" });
}

/** Who made a change: the device, plus the account when the vault is shared (several people in the log). */
export function whoLabel(entry: RevisionEntry, showAccount: boolean): string {
  const device = entry.deviceName ?? texts.unknownDevice;
  return showAccount && entry.userEmail ? `${device} · ${entry.userEmail}` : device;
}

// ---------------------------------------------------------------------------
// Line diff
// ---------------------------------------------------------------------------

export type DiffLine = { kind: "same" | "add" | "del"; text: string };

/** Above this many cells (lines old x lines new) the diff is skipped - it would block the tab. */
const MAX_DIFF_CELLS = 4_000_000;

/**
 * Line-based diff (longest common subsequence) of two texts; null when they are too large to compare in the browser.
 * Common head and tail lines are matched first, which keeps the table small for the usual "edited a few lines" case.
 */
export function diffLines(before: string, after: string): DiffLine[] | null {
  const a = before.split("\n");
  const b = after.split("\n");
  let head = 0;
  while (head < a.length && head < b.length && a[head] === b[head]) head++;
  let tail = 0;
  while (tail < a.length - head && tail < b.length - head && a[a.length - 1 - tail] === b[b.length - 1 - tail]) tail++;
  const midA = a.slice(head, a.length - tail);
  const midB = b.slice(head, b.length - tail);
  if (midA.length * midB.length > MAX_DIFF_CELLS) return null;

  // lcs[i][j] = length of the LCS of midA[i..] and midB[j..], one flat array.
  const w = midB.length + 1;
  const lcs = new Uint32Array((midA.length + 1) * w);
  for (let i = midA.length - 1; i >= 0; i--) {
    for (let j = midB.length - 1; j >= 0; j--) {
      lcs[i * w + j] = midA[i] === midB[j] ? lcs[(i + 1) * w + j + 1] + 1 : Math.max(lcs[(i + 1) * w + j], lcs[i * w + j + 1]);
    }
  }

  const out: DiffLine[] = a.slice(0, head).map((text) => ({ kind: "same", text }));
  let i = 0;
  let j = 0;
  while (i < midA.length && j < midB.length) {
    if (midA[i] === midB[j]) {
      out.push({ kind: "same", text: midA[i] });
      i++;
      j++;
    } else if (lcs[(i + 1) * w + j] >= lcs[i * w + j + 1]) {
      out.push({ kind: "del", text: midA[i++] });
    } else {
      out.push({ kind: "add", text: midB[j++] });
    }
  }
  while (i < midA.length) out.push({ kind: "del", text: midA[i++] });
  while (j < midB.length) out.push({ kind: "add", text: midB[j++] });
  for (const text of a.slice(a.length - tail)) out.push({ kind: "same", text });
  return out;
}

/** Collapses long runs of unchanged lines to `context` lines around each change; `null` marks a gap. */
export function withContext<T extends DiffLine>(lines: T[], context = 3): Array<T | null> {
  const keep = new Array<boolean>(lines.length).fill(false);
  lines.forEach((line, index) => {
    if (line.kind === "same") return;
    for (let k = Math.max(0, index - context); k <= Math.min(lines.length - 1, index + context); k++) keep[k] = true;
  });
  const out: Array<T | null> = [];
  lines.forEach((line, index) => {
    if (keep[index]) out.push(line);
    else if (out.length === 0 || out[out.length - 1] !== null) out.push(null);
  });
  return out;
}

export interface NumberedDiffLine extends DiffLine {
  /** 1-based line number in the old/new text, or null on the side that doesn't have this line (an add/del). */
  oldLine: number | null;
  newLine: number | null;
}

/** Attaches old/new line numbers to a `diffLines` result, for a GitHub-style line-numbered diff. */
export function numberDiffLines(lines: DiffLine[]): NumberedDiffLine[] {
  let oldLine = 1;
  let newLine = 1;
  return lines.map((line) => {
    const numbered: NumberedDiffLine = { ...line, oldLine: line.kind === "add" ? null : oldLine, newLine: line.kind === "del" ? null : newLine };
    if (line.kind !== "add") oldLine++;
    if (line.kind !== "del") newLine++;
    return numbered;
  });
}
