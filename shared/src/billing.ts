/**
 * Account states as the clients see them (`/auth/me`). A self-hosted server has no payment system, so every
 * account is "unmanaged"; the other states exist because the same plugin also talks to hosted servers.
 */
export const BILLING_STATES = ["unmanaged", "trial", "active", "past_due", "read_only", "expired"] as const;
export type BillingState = (typeof BILLING_STATES)[number];
