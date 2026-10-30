/**
 * What `GET /billing` answers on the hosted Syncstone service (plan, subscription state, limits). A self-hosted server has
 * no such endpoint, so the plugin only shows the plan section when this answers. Only the fields the plugin shows are
 * listed - everything else the server sends is ignored, so the hosted service can grow without breaking the plugin.
 */
export interface BillingInfo {
  /** Subscriptions can be bought right now. */
  enabled: boolean;
  /** The plans are shown (bought, or switched on as a preview). */
  visible: boolean;
  state: "unmanaged" | "trial" | "active" | "past_due" | "read_only" | "expired";
  plan: string | null;
  plans: Array<{ id: string; quotaBytes: number }>;
  trialEndsAt: string | null;
  currentPeriodEnd: string | null;
  cancelAtPeriodEnd: boolean;
  dataDeleteAt: string | null;
  quotaBytes: number | null;
  usedBytes: number;
  maxFileBytes: number;
  historyDays: number;
  soldOut: boolean;
  hasCustomer: boolean;
  hasSubscription: boolean;
  compedPlan: string | null;
}

/** The plan section belongs on hosted servers that sell plans (or already manage this account) - same rule as the web app's "Plan" tab. */
export function showsPlanSection(info: BillingInfo | null): info is BillingInfo {
  return info !== null && (info.visible || info.state !== "unmanaged");
}
