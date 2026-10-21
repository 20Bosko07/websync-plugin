import { Platform } from "obsidian";
import type { DeviceStartRequest, DeviceStartResponse, DevicePollResponse, MeResponse } from "@websync/shared";
import { apiRequest } from "./httpClient.js";

/**
 * Wraps the /auth/* endpoints. Holds no session state itself - the caller
 * (SettingsTab / main.ts) persists the resulting session token into plugin
 * settings and passes it back in for authenticated calls (logout, getMe).
 *
 * Login is device-pairing based (like `gh auth login --web`), not manual
 * email/password/2FA entry: `startDeviceAuth` asks the server for a short
 * pairing code + a browser URL, and `pollDeviceAuth` is polled until the
 * user approves (or denies/lets it expire) on the web panel, where they're
 * already logged in and also pick which vault to link. See SettingsTab.ts
 * for the polling loop.
 */
export class AuthClient {
  constructor(private readonly getServerUrl: () => string) {}

  private get serverUrl(): string {
    const url = this.getServerUrl();
    if (!url) throw new Error("WebSync: Server-URL ist nicht konfiguriert.");
    return url;
  }

  async register(email: string, password: string): Promise<void> {
    await apiRequest<void>(this.serverUrl, {
      method: "POST",
      path: "/auth/register",
      json: { email, password },
    });
  }

  /**
   * `clientType` is derived from `Platform.isMobile` (from the `obsidian`
   * API), not from any build-time flag - the same bundled main.js runs on
   * both platforms, so this has to be a runtime check.
   */
  async startDeviceAuth(deviceName: string): Promise<DeviceStartResponse> {
    const clientType = Platform.isMobile ? "plugin-mobile" : "plugin-desktop";
    const resolvedDeviceName = deviceName.trim() || `WebSync Plugin (${Platform.isMobile ? "Mobile" : "Desktop"})`;
    const payload: DeviceStartRequest = { clientType, deviceName: resolvedDeviceName };
    return apiRequest<DeviceStartResponse>(this.serverUrl, {
      method: "POST",
      path: "/auth/device/start",
      json: payload,
    });
  }

  /**
   * Polls the pairing status. The server's response is single-use: once it
   * returns `approved`, `denied`, or `expired`, a subsequent poll with the
   * same `pollToken` 404s - the caller MUST stop polling as soon as it sees
   * one of those terminal statuses (see SettingsTab.ts's polling loop). A
   * 404 (thrown here as a WebSyncApiError with status 404) is also terminal
   * and should be treated as a failed/expired attempt.
   */
  async pollDeviceAuth(pollToken: string): Promise<DevicePollResponse> {
    const query = new URLSearchParams({ pollToken });
    return apiRequest<DevicePollResponse>(this.serverUrl, {
      path: `/auth/device/poll?${query.toString()}`,
    });
  }

  async logout(sessionToken: string): Promise<void> {
    await apiRequest<void>(this.serverUrl, {
      method: "POST",
      path: "/auth/logout",
      token: sessionToken,
    });
  }

  async getMe(sessionToken: string): Promise<MeResponse> {
    return apiRequest<MeResponse>(this.serverUrl, {
      path: "/auth/me",
      token: sessionToken,
    });
  }
}
