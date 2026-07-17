/**
 * Plan definitions for usage quotas. Workspaces default to `free`; the plan is stored on the
 * workspace row and (until Stripe lands, #23) changed manually. Limits are enforced at the
 * consuming endpoints — posting, connecting accounts, registering media.
 */

export const PLAN_NAMES = ["free", "pro", "scale"] as const;
export type PlanName = (typeof PLAN_NAMES)[number];

export interface PlanLimits {
  /** Posts entering the publish pipeline per calendar month (UTC). Drafts count on approval. */
  postsPerMonth: number;
  /** Connected social accounts (active) per workspace. */
  maxAccounts: number;
  /** Total bytes of media stored on R2 through /v1/media. */
  maxMediaBytes: number;
}

const GiB = 1024 * 1024 * 1024;

export const PLANS: Record<PlanName, PlanLimits> = {
  free: { postsPerMonth: 50, maxAccounts: 3, maxMediaBytes: GiB / 2 },
  pro: { postsPerMonth: 2_000, maxAccounts: 15, maxMediaBytes: 20 * GiB },
  scale: { postsPerMonth: 20_000, maxAccounts: 100, maxMediaBytes: 200 * GiB },
};

export function isPlanName(value: string): value is PlanName {
  return (PLAN_NAMES as readonly string[]).includes(value);
}
