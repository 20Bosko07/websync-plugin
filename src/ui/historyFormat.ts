/** Small formatting helpers shared by HistoryView (sidebar) and HistoryDiffView (main-area diff tab). */

export const decoder = new TextDecoder("utf-8", { fatal: true });
export const TEXT_EXT = new Set(["md", "txt", "json", "canvas", "csv", "css", "js", "ts", "html", "xml", "yml", "yaml", "svg", "tex", "log"]);
export const IMAGE_EXT = new Set(["png", "jpg", "jpeg", "gif", "webp", "bmp", "svg", "avif"]);
/** Larger versions are not decoded for a preview/diff (download or "save as copy" still work). */
export const MAX_PREVIEW_BYTES = 2 * 1024 * 1024;

export const extOf = (path: string | null) => (path && path.includes(".") ? path.slice(path.lastIndexOf(".") + 1).toLowerCase() : "");
export const baseName = (path: string) => path.slice(path.lastIndexOf("/") + 1);
export const parentOf = (path: string) => (path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "");

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB"];
  let value = bytes / 1024;
  let i = 0;
  while (value >= 1024 && i < units.length - 1) {
    value /= 1024;
    i++;
  }
  return `${value.toFixed(1)} ${units[i]}`;
}
