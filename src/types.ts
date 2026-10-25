/**
 * Shape of the plugin's `data.json` (via `Plugin.loadData()`/`saveData()`).
 * The file-level sync mapping table (fileId -> localPath -> version/hash)
 * lives in IndexedDB instead (see sync/LocalIndex.ts) - it scales much
 * better than a monolithic JSON blob once a vault has many files.
 */

import type { VaultMemberKey } from "@websync/shared";

export interface LinkedVaultConfig {
  vaultId: string;
  vaultName: string;
  kdfAlgo: string;
  /** base64 */
  kdfSalt: string;
  kdfIterations: number;
  /** base64 */
  verificationBlob: string;
  /** base64 */
  verificationNonce: string;
  /**
   * Set when this is somebody else's vault that was shared with the user: their own passphrase-wrapped copy of the
   * vault key (see `VaultMemberKey` in @websync/shared). The `kdf*` fields above are then the owner's and are NOT
   * what the passphrase unlocks - this is.
   */
  memberKey?: VaultMemberKey | null;
  /**
   * The highest vault-wide `currentVersion` this device has fully applied.
   * Used as the `since=` cursor for incremental polling. Distinct from any
   * individual file's `version` field.
   */
  lastSyncedGlobalVersion: number;
}

export interface CachedKeyMaterial {
  /**
   * Base64-encoded raw PBKDF2 output ("root bits"), NOT the passphrase and
   * NOT a CryptoKey. See CryptoService.ts for why this exists and how it's
   * used - in short, it lets "remember key on this device" skip the
   * expensive PBKDF2 step on every plugin startup.
   */
  rootBitsBase64: string;
}

/**
 * Optional sync of `.obsidian/*` config files (plugins, themes, snippets,
 * hotkeys, core settings, workspace layout) - like Obsidian Sync's own
 * per-vault settings toggles. Off by default: existing users shouldn't
 * suddenly start syncing plugin code/settings without opting in. Handled by
 * a completely separate ConfigSyncEngine, not the main note SyncEngine - see
 * that file for why.
 */
export interface ConfigSyncSettings {
  enabled: boolean;
  coreSettings: boolean;
  communityPlugins: boolean;
  themes: boolean;
  snippets: boolean;
  hotkeys: boolean;
  /**
   * Workspace layout (open tabs/panes) is device-specific by nature (a
   * phone's layout doesn't make sense on a desktop) - default OFF even
   * though the rest of config sync may be on, matching Obsidian Sync's own
   * choice to exclude it by default.
   */
  workspace: boolean;
  /** This device's last-applied vault-wide version for config files specifically - a separate cursor from `linkedVault.lastSyncedGlobalVersion`, since the two engines poll independently. */
  lastSyncedGlobalVersion: number;
}

export interface WebSyncSettings {
  /** Self-hosting: use `serverUrl` instead of the hosted service (see hosted.ts). */
  selfHosted: boolean;
  /** Address of the API server of the user's own installation; only used while `selfHosted` is on. */
  serverUrl: string;
  sessionToken: string | null;
  sessionExpiresAt: string | null;
  accountEmail: string | null;
  /** This device's name as registered on the server (shown in the web panel and next to live cursors). */
  deviceName: string | null;

  linkedVault: LinkedVaultConfig | null;

  /** "Schlüssel auf diesem Gerät merken" - default OFF. */
  rememberKey: boolean;
  /** Only ever populated when `rememberKey` is true. */
  cachedKeyMaterial: CachedKeyMaterial | null;

  syncPaused: boolean;
  lastSyncAt: string | null;

  /**
   * Live collaboration: show where other devices are in a note (coloured
   * cursors with their device name) and edit together in real time whenever
   * two or more devices have the same note open. Off = always plain file sync.
   */
  collabEnabled: boolean;

  configSync: ConfigSyncSettings;
}

export const DEFAULT_SETTINGS: WebSyncSettings = {
  selfHosted: false,
  serverUrl: "",
  sessionToken: null,
  sessionExpiresAt: null,
  accountEmail: null,
  deviceName: null,

  linkedVault: null,

  rememberKey: false,
  cachedKeyMaterial: null,

  syncPaused: false,
  lastSyncAt: null,

  collabEnabled: true,

  configSync: {
    enabled: false,
    coreSettings: true,
    communityPlugins: true,
    themes: true,
    snippets: true,
    hotkeys: true,
    workspace: false,
    lastSyncedGlobalVersion: 0,
  },
};
