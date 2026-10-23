/**
 * Types shared by the admin API (packages/server/src/routes/admin.ts) and the admin pages of the web panel.
 * Request bodies are zod schemas (validated by the server); responses are plain interfaces.
 */
import { z } from "zod";
import { MIN_PASSWORD_LENGTH } from "./constants";
import { UsernameSchema } from "./dto";

export const USER_ROLES = ["user", "admin"] as const;
export type UserRole = (typeof USER_ROLES)[number];

/** Response of `GET /admin/settings` and body of `PUT /admin/settings`. */
export const AdminSettingsSchema = z.object({
  /** false = nobody can register on their own; accounts are then created by an admin. */
  registrationOpen: z.boolean(),
  /** Storage quota (bytes) given to newly created accounts; null = unlimited. */
  defaultQuotaBytes: z.number().int().positive().nullable(),
});
export type AdminSettings = z.infer<typeof AdminSettingsSchema>;

/** Actions that can destroy data or hand out power ask the admin for their own password again. */
export const AdminReauthSchema = z.object({
  currentPassword: z.string().min(1).max(1000),
});

export const AdminCreateUserSchema = AdminReauthSchema.extend({
  username: UsernameSchema,
  password: z.string().min(MIN_PASSWORD_LENGTH).max(1000),
  role: z.enum(USER_ROLES).default("user"),
  quotaBytes: z.number().int().positive().nullable().optional(),
});
export type AdminCreateUserRequest = z.infer<typeof AdminCreateUserSchema>;

export const AdminUpdateUserSchema = z.object({
  role: z.enum(USER_ROLES).optional(),
  disabled: z.boolean().optional(),
  /** null removes the limit. */
  quotaBytes: z.number().int().positive().nullable().optional(),
  /** Per-account limit for a single file; null = the default. */
  maxFileBytes: z.number().int().positive().nullable().optional(),
  /** Required whenever `role` changes. */
  currentPassword: z.string().min(1).max(1000).optional(),
});
export type AdminUpdateUserRequest = z.infer<typeof AdminUpdateUserSchema>;

/** Sets a new password for an account (the way to recover an account whose password was forgotten). */
export const AdminSetPasswordSchema = AdminReauthSchema.extend({
  newPassword: z.string().min(MIN_PASSWORD_LENGTH).max(1000),
});

export const AdminDeleteUserSchema = AdminReauthSchema.extend({
  /** Must equal the account's username - a guard against deleting the wrong row. */
  confirmUsername: z.string().min(1),
});

export const AdminDeleteVaultSchema = AdminReauthSchema.extend({
  confirmName: z.string().min(1),
});

export const AdminListQuerySchema = z.object({
  q: z.string().trim().max(200).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});

export const AdminUserListQuerySchema = AdminListQuerySchema.extend({
  role: z.enum(USER_ROLES).optional(),
  status: z.enum(["active", "disabled"]).optional(),
  sort: z.enum(["username", "createdAt", "lastActive", "storage", "traffic"]).default("createdAt"),
  dir: z.enum(["asc", "desc"]).default("desc"),
});

// --- Responses ---

export interface TrafficTotals {
  requests: number;
  bytesIn: number;
  bytesOut: number;
}

export interface AdminUserRow {
  id: string;
  username: string;
  role: UserRole;
  disabled: boolean;
  totpEnabled: boolean;
  createdAt: string;
  lastLoginAt: string | null;
  /** Latest request of any of the user's sessions. */
  lastActiveAt: string | null;
  vaultCount: number;
  fileCount: number;
  storageBytes: number;
  quotaBytes: number | null;
  maxFileBytes: number;
  maxFileBytesOverride: number | null;
  /** Sessions that are neither revoked nor expired. */
  devices: number;
  /** Devices with an open live connection right now. */
  devicesOnline: number;
  /** Traffic since the last server restart plus what was already persisted for today. */
  trafficToday: TrafficTotals;
}

export interface AdminSessionRow {
  id: string;
  userId: string;
  username: string;
  deviceName: string;
  clientType: string;
  createdAt: string;
  lastUsedAt: string | null;
  lastIp: string | null;
  expiresAt: string;
  online: boolean;
}

export interface AdminVaultRow {
  id: string;
  name: string;
  ownerId: string;
  ownerUsername: string;
  fileCount: number;
  totalBytes: number;
  currentVersion: number;
  createdAt: string;
  deletedAt: string | null;
  /** Live connections to this vault right now. */
  liveConnections: number;
}

export interface AdminAuditEntry {
  id: string;
  createdAt: string;
  actorId: string | null;
  actorName: string;
  action: string;
  targetType: string | null;
  targetId: string | null;
  targetLabel: string | null;
  detail: Record<string, unknown> | null;
  ip: string | null;
}

export interface AdminUsageDay {
  day: string;
  bytesUp: number;
  bytesDown: number;
  requests: number;
}

export interface AdminUserDetail {
  user: AdminUserRow;
  sessions: AdminSessionRow[];
  vaults: AdminVaultRow[];
  usage: AdminUsageDay[];
  audit: AdminAuditEntry[];
}

export interface AdminListResponse<T> {
  total: number;
  items: T[];
}

export interface ServerProcessStats {
  nodeVersion: string;
  uptimeSec: number;
  /** CPU use of the server process, in percent of one core (average of the last sample window). */
  cpuPercent: number;
  rssBytes: number;
  heapUsedBytes: number;
  systemMemTotalBytes: number;
  systemMemFreeBytes: number;
  loadAvg1: number;
  cpuCores: number;
  /** Event-loop delay in ms: how long the server was blocked at worst over the last sample window. */
  eventLoopP99Ms: number;
  eventLoopMaxMs: number;
  /** Round trip of `select 1` against Postgres. */
  dbLatencyMs: number | null;
  dbOk: boolean;
  disk: { totalBytes: number; freeBytes: number } | null;
}

export interface AdminOverview {
  users: { total: number; admins: number; disabled: number; withTotp: number; active24h: number; new7d: number };
  vaults: { total: number; deleted: number };
  files: { total: number; totalBytes: number };
  sessions: { active: number };
  live: { connections: number; usersOnline: number; rooms: number; peersInRooms: number };
  settings: AdminSettings;
  server: ServerProcessStats;
  traffic: { last5min: TrafficTotals & { errors: number }; last60min: TrafficTotals & { errors: number } };
}

export interface AdminSeriesPoint {
  /** Start of the minute (ms since epoch). */
  t: number;
  requests: number;
  errors: number;
  bytesIn: number;
  bytesOut: number;
  avgLatencyMs: number;
  maxLatencyMs: number;
  wsMessages: number;
  wsBytes: number;
}

export interface AdminSamplePoint {
  t: number;
  cpuPercent: number;
  rssBytes: number;
  eventLoopP99Ms: number;
  load1: number;
  connections: number;
}

/** Time ranges (minutes) and grid sizes (seconds) the metrics chart can show; the server accepts exactly these. */
export const METRIC_STEPS_SECONDS = [10, 60, 300, 900, 3600] as const;
export const METRIC_RANGES_MINUTES = [5, 60, 360, 1440, 10080, 20160] as const;

export const AdminMetricsQuerySchema = z.object({
  range: z.coerce.number().int().min(5).max(20160).default(60),
  step: z.coerce
    .number()
    .int()
    .refine((v) => (METRIC_STEPS_SECONDS as readonly number[]).includes(v), "unsupported step")
    .default(60),
});

export interface AdminSeries {
  stepSeconds: number;
  points: AdminSeriesPoint[];
  samples: AdminSamplePoint[];
}

export interface AdminLiveDevice {
  sessionId: string;
  deviceName: string;
  vaultId: string;
  vaultName: string | null;
  connectedSince: string;
  rooms: number;
}

export interface AdminActivityRow {
  userId: string;
  username: string;
  role: UserRole;
  online: boolean;
  devicesOnline: number;
  devices: number;
  liveDevices: AdminLiveDevice[];
  last5min: TrafficTotals;
  today: TrafficTotals;
  lastActiveAt: string | null;
}
