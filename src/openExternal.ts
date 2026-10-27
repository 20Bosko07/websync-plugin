// Links that come from the server (verification and account URLs) are opened only when they are plain http(s),
// so a compromised or misconfigured server cannot hand the app an obsidian://, file:// or custom-scheme link.
export function openExternal(url: string): void {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "https:" && parsed.protocol !== "http:") return;
    window.open(parsed.toString(), "_blank");
  } catch {
    // Not a URL: nothing to open.
  }
}
