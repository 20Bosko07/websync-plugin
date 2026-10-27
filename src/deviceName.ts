import { Platform } from "obsidian";
import { t } from "./i18n/index.js";

/** The computer's name (`os.hostname()`), only where Obsidian runs on Node (desktop); the domain part (`.local`, `.fritz.box`) is cut off. */
function hostname(): string | null {
  try {
    const nodeRequire = (window as unknown as { require?: (id: string) => { hostname?: () => string } }).require;
    const name = nodeRequire?.("os").hostname?.() ?? "";
    const short = name.trim().split(".")[0]?.trim();
    return short ? short : null;
  } catch {
    return null;
  }
}

/** What a device is called until the user picks a name: the host name of the computer, on phones and tablets the platform. */
export function defaultDeviceName(): string {
  const host = hostname();
  if (host) return host;
  const platform = Platform.isAndroidApp ? "Android" : Platform.isIosApp ? "iOS" : Platform.isMobile ? "Mobile" : navigator.platform || "Desktop";
  return t("p.defaultDevice", { platform });
}
