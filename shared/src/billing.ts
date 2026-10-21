/**
 * Plans, trial and limits of the hosted service. Self-hosted servers never see any of this: billing only exists while
 * the server has a Creem API key (see packages/server/src/services/billing.ts), and accounts created without it are
 * "unmanaged" - they keep the quota an administrator gave them and are never put into read-only mode or deleted.
 */
import { z } from "zod";

const MB = 1024 * 1024;
const GB = 1024 * MB;

/** Days of the free trial (no card needed). */
export const BILLING_TRIAL_DAYS = 14;
/** Days an account stays readable (read-only) after the trial or the subscription ended - then its data is deleted. */
export const BILLING_GRACE_DAYS = 30;
/** Days before the deletion at which the reminder mail goes out. */
export const BILLING_DELETE_WARNING_DAYS = 7;
/** Storage of the free trial. */
export const TRIAL_QUOTA_BYTES = 200 * MB;
/** Largest single file; an administrator can raise or lower it per account. */
export const DEFAULT_MAX_FILE_BYTES = 250 * MB;
/** Retention of old versions: one month for everybody, six months with the biggest plan. */
export const HISTORY_DAYS_STANDARD = 30;
export const HISTORY_DAYS_TOP_PLAN = 180;
/** Creem sells in USD or EUR only. */
export const BILLING_CURRENCY = "eur";

export const PLAN_IDS = ["gb1", "gb2", "gb5", "gb10"] as const;
export type PlanId = (typeof PLAN_IDS)[number];

export interface PlanInfo {
  id: PlanId;
  quotaBytes: number;
  /** Price per month in cents of BILLING_CURRENCY. */
  priceCents: number;
  historyDays: number;
}

/** The fixed packages (no custom sizes). Prices are per month. */
export const PLANS: readonly PlanInfo[] = [
  { id: "gb1", quotaBytes: 1 * GB, priceCents: 300, historyDays: HISTORY_DAYS_STANDARD },
  { id: "gb2", quotaBytes: 2 * GB, priceCents: 400, historyDays: HISTORY_DAYS_STANDARD },
  { id: "gb5", quotaBytes: 5 * GB, priceCents: 600, historyDays: HISTORY_DAYS_STANDARD },
  { id: "gb10", quotaBytes: 10 * GB, priceCents: 800, historyDays: HISTORY_DAYS_TOP_PLAN },
];

export function planById(id: string | null | undefined): PlanInfo | null {
  return PLANS.find((plan) => plan.id === id) ?? null;
}

/**
 * - unmanaged: no billing for this account (self-hosted server, or an account an administrator created)
 * - trial:     free trial running
 * - active:    subscription paid (a cancelled one stays active until the paid period ends)
 * - past_due:  the last payment failed; Creem is retrying, the account keeps working
 * - read_only: trial or subscription over - files can be read and downloaded but not changed, until the data is deleted
 * - expired:   the data was deleted; the account itself remains and can subscribe again
 */
export const BILLING_STATES = ["unmanaged", "trial", "active", "past_due", "read_only", "expired"] as const;
export type BillingState = (typeof BILLING_STATES)[number];

/** `GET /billing` - everything the plan page and the banners need. */
export interface BillingInfo {
  /** False on servers without Creem: nothing to buy there. */
  enabled: boolean;
  /** The packages are shown (see `PublicPlans.visible`). */
  visible: boolean;
  state: BillingState;
  plan: PlanId | null;
  plans: PlanInfo[];
  currency: string;
  trialEndsAt: string | null;
  currentPeriodEnd: string | null;
  cancelAtPeriodEnd: boolean;
  /** When the account became read-only. */
  accessEndedAt: string | null;
  /** When its data will be deleted. */
  dataDeleteAt: string | null;
  quotaBytes: number | null;
  usedBytes: number;
  maxFileBytes: number;
  historyDays: number;
  /** An administrator replaced the quota the plan would give. */
  quotaOverridden: boolean;
  /** The server has no free capacity for new subscriptions / trials right now. */
  soldOut: boolean;
  /** There is a Creem customer - the customer portal (invoices, card, cancel) can be opened. */
  hasCustomer: boolean;
  hasSubscription: boolean;
  /** An administrator gave this account a plan without payment (until the date, or without an end). */
  compedPlan: PlanId | null;
  compedUntil: string | null;
}

/** `GET /billing/plans` - public, so the landing page can show what can be bought (and hide it on a self-hosted server). */
export interface PublicPlans {
  /** Plans can be bought (Creem is set up). False on servers without Creem. */
  enabled: boolean;
  /** The packages are shown: they can be bought, or an administrator switched the preview on. */
  visible: boolean;
  currency: string;
  plans: PlanInfo[];
  trialDays: number;
  trialQuotaBytes: number;
  maxFileBytes: number;
  /** The server has no free capacity for new trials / subscriptions right now. */
  soldOut: boolean;
}

export const CheckoutRequestSchema = z.object({ plan: z.enum(PLAN_IDS) });
export type CheckoutRequest = z.infer<typeof CheckoutRequestSchema>;

/** Body of the admin's "give this account a plan without payment" (needs both confirmations, like the quota override). */
export const AdminCompSchema = z.object({
  mode: z.enum(["grant", "clear"]),
  plan: z.enum(PLAN_IDS).optional(),
  /** ISO timestamp the free plan ends at; absent / null = no end. */
  until: z.string().datetime().nullable().optional(),
  confirmOverride: z.literal(true).optional(),
  confirmEmail: z.string().min(1).optional(),
});
export type AdminComp = z.infer<typeof AdminCompSchema>;

/** Body of the admin's quota override of a billing-managed account (needs both confirmations). */
export const AdminQuotaOverrideSchema = z.object({
  mode: z.enum(["set", "unlimited", "clear"]),
  bytes: z.number().int().positive().optional(),
  /** First confirmation: the admin knows the payment system normally decides. */
  confirmOverride: z.literal(true).optional(),
  /** Second confirmation: the account's e-mail address, typed in. */
  confirmEmail: z.string().min(1).optional(),
});
export type AdminQuotaOverride = z.infer<typeof AdminQuotaOverrideSchema>;
