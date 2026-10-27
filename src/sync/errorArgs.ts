import { WebSyncApiError } from "./httpClient.js";

/** The log arguments for a failure: the message and, for a server answer, which request got which status. */
export function errorArgs(err: unknown): string[] {
  if (err instanceof WebSyncApiError) {
    const where = [err.status > 0 ? String(err.status) : "", err.request ?? ""].filter(Boolean).join(" ");
    return where ? [err.message, where] : [err.message];
  }
  return [err instanceof Error ? err.message : String(err)];
}
