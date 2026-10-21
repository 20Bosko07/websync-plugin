import { describe, expect, it } from "vitest";
import {
  AdminQuotaOverrideSchema,
  BILLING_GRACE_DAYS,
  BILLING_TRIAL_DAYS,
  DEFAULT_MAX_FILE_BYTES,
  HISTORY_DAYS_STANDARD,
  HISTORY_DAYS_TOP_PLAN,
  PLANS,
  TRIAL_QUOTA_BYTES,
  planById,
} from "./billing";

const MB = 1024 * 1024;
const GB = 1024 * MB;

describe("plans", () => {
  it("offers the fixed packages 1 / 2 / 5 / 10 GB for 3 / 4 / 6 / 8 EUR", () => {
    expect(PLANS.map((p) => [p.quotaBytes / GB, p.priceCents / 100])).toEqual([
      [1, 3],
      [2, 4],
      [5, 6],
      [10, 8],
    ]);
  });

  it("keeps old versions for a month, six months with the biggest plan", () => {
    expect(PLANS.slice(0, -1).every((p) => p.historyDays === HISTORY_DAYS_STANDARD)).toBe(true);
    expect(PLANS[PLANS.length - 1].historyDays).toBe(HISTORY_DAYS_TOP_PLAN);
    expect(HISTORY_DAYS_STANDARD).toBe(30);
    expect(HISTORY_DAYS_TOP_PLAN).toBe(180);
  });

  it("has unique ids that planById finds", () => {
    expect(new Set(PLANS.map((p) => p.id)).size).toBe(PLANS.length);
    for (const plan of PLANS) expect(planById(plan.id)).toEqual(plan);
    expect(planById("nope")).toBeNull();
    expect(planById(null)).toBeNull();
  });

  it("uses the agreed trial and limits", () => {
    expect(BILLING_TRIAL_DAYS).toBe(14);
    expect(BILLING_GRACE_DAYS).toBe(30);
    expect(TRIAL_QUOTA_BYTES).toBe(200 * MB);
    expect(DEFAULT_MAX_FILE_BYTES).toBe(250 * MB);
  });
});

describe("admin quota override", () => {
  it("accepts a clear without confirmations and a set with them", () => {
    expect(AdminQuotaOverrideSchema.safeParse({ mode: "clear" }).success).toBe(true);
    expect(AdminQuotaOverrideSchema.safeParse({ mode: "set", bytes: GB, confirmOverride: true, confirmEmail: "a@b.c" }).success).toBe(true);
    expect(AdminQuotaOverrideSchema.safeParse({ mode: "set", bytes: -1 }).success).toBe(false);
    expect(AdminQuotaOverrideSchema.safeParse({ mode: "set", confirmOverride: false }).success).toBe(false);
  });
});
