export const PBKDF2_ITERATIONS_DEFAULT = 210_000;
export const KDF_ALGO_PBKDF2_SHA256 = "pbkdf2-sha256" as const;

/** UI languages. The first one is the default for anybody who has not picked (or whose browser asks for another). */
export const LOCALES = ["en", "de", "fr", "es", "it", "nl"] as const;
export type Locale = (typeof LOCALES)[number];
export const DEFAULT_LOCALE: Locale = "en";

/** Shortest account password the server accepts (registration, setup, password changes, admin / CLI resets). */
export const MIN_PASSWORD_LENGTH = 7;

/** Share of the storage quota at which the account gets a warning (banner). */
export const STORAGE_WARNING_RATIO = 0.8;

export const SESSION_TOKEN_HEADER = "authorization";
export const SESSION_TOKEN_PREFIX = "Bearer ";

export const CLIENT_TYPES = ["web", "plugin-desktop", "plugin-mobile"] as const;
export type ClientType = (typeof CLIENT_TYPES)[number];

export const TWO_FACTOR_METHODS = ["totp", "passkey"] as const;
export type TwoFactorMethod = (typeof TWO_FACTOR_METHODS)[number];

/** Debounce window before a locally changed file is pushed to the server. */
export const LOCAL_CHANGE_DEBOUNCE_MS = 1500;

/**
 * How long a client keeps its "edit session" id for a file alive without any edit to it before starting a fresh one on
 * the next edit. Used to fold a burst of saves (continuous typing with short pauses) into a single history entry - a
 * client also starts a fresh id immediately when a different file becomes active, regardless of this timeout.
 */
export const HISTORY_EDIT_SESSION_IDLE_MS = 2 * 60 * 1000;
/** How often the plugin polls the server for remote changes. */
export const REMOTE_POLL_INTERVAL_MS = 30_000;

/** Max devices that can co-edit one note at the same time (server refuses further joins). */
export const COLLAB_MAX_PEERS_PER_ROOM = 8;
/** Max notes one connection can be "present" in at once (open editor tabs). */
export const COLLAB_MAX_ROOMS_PER_CONNECTION = 32;
/** Upper bound for one relayed payload (base64 chars) - a full-state reply of a large note must still fit. */
export const COLLAB_MAX_RELAY_BASE64_LENGTH = 6_000_000;
/** Notes with more text than this are never co-edited live (they fall back to normal file sync). */
export const COLLAB_MAX_TEXT_LENGTH = 1_000_000;

/**
 * Files larger than this are skipped (with a warning, not a crash) when
 * syncing on mobile. Obsidian mobile's WebView has a much tighter JS heap
 * than desktop Electron, and encrypting/base64-transporting a large file
 * needs several times its size in memory at once - large attachments have
 * been observed crashing the Android app. Desktop has no such limit.
 */
export const MOBILE_MAX_SYNC_FILE_SIZE_BYTES = 25 * 1024 * 1024;

/**
 * Only files are synced, never folders. To make an empty folder survive (and
 * its deletion propagate), the folder gets one tiny hidden marker file with
 * this name. It is never shown in explorers; clients turn it into "this
 * folder exists" and remove it when the folder is deleted.
 */
export const FOLDER_MARKER_FILENAME = ".websync-folder";

/**
 * Uploads are split into chunks of this size (of the packed `iv || ciphertext` blob). Reverse proxies and tunnels cap
 * the size of one request body - Cloudflare at 100 MB - and a single large PUT then just hangs "syncing" forever.
 * Blobs up to this size still go in one multipart PUT.
 */
export const UPLOAD_CHUNK_SIZE_BYTES = 8 * 1024 * 1024;

/** Transfers that take longer than this get a progress ring in the file explorer (shorter ones would only flicker). */
export const TRANSFER_PROGRESS_DELAY_MS = 2000;

/**
 * Version of the wire protocol / crypto format the plugin and the server must agree on. Bump it on every change that
 * an older plugin cannot cope with; the server reports it on `/health` and the plugin refuses to sync on a mismatch.
 */
export const PROTOCOL_VERSION = 1;
