/**
 * The API server of the hosted WebSync service - what the plugin talks to unless the user switches on "self-hosting" in
 * the settings (Advanced). It is the address of the API server (the one the web app itself calls), not of the web app.
 * Set it once the service's domain is final; while it is empty a hosted account cannot be signed in from this build.
 */
export const HOSTED_SERVER_URL = "";

/** Trimmed, without trailing slashes - how addresses are compared and stored. */
export function normalizeServerUrl(url: string): string {
  return url.trim().replace(/\/+$/, "");
}
