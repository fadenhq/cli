/**
 * Plan definitions for usage quotas (v2, #86). Workspaces default to `free`; the plan is stored
 * on the workspace row, written by the Stripe webhook for self-serve Pro (#23) and manually for
 * Scale / operator overrides. Limits are enforced at
 * the consuming endpoints — posting, connecting accounts, registering media. `null` always
 * means "no limit". Downgrades never delete anything: over-limit accounts stay connected, the
 * limits only gate *new* connects/posts.
 */

import type { Platform } from "./platforms.js";

export const PLAN_NAMES = ["free", "pro", "scale"] as const;
export type PlanName = (typeof PLAN_NAMES)[number];

/**
 * Which Stripe environment a workspace's billing runs against (#23 sandbox mode). `live` uses the
 * real Stripe keys; `test` routes checkout/portal/webhooks through a parallel Stripe *test-mode*
 * credential set so a workspace can be exercised end-to-end on the live deployment without real
 * charges. Stripe keeps the two worlds fully isolated (separate keys, prices, customers, and a
 * `livemode` flag on every event), so a test subscription can never grant real Pro. Default `live`.
 */
export const BILLING_MODES = ["live", "test"] as const;
export type BillingMode = (typeof BILLING_MODES)[number];

export function isBillingMode(value: string): value is BillingMode {
  return (BILLING_MODES as readonly string[]).includes(value);
}

export interface PlanLimits {
  /** Posts entering the publish pipeline per calendar month (UTC). Drafts count on approval. */
  postsPerMonth: number | null;
  /** Posts entering the publish pipeline per UTC day (the free plan's cap). */
  postsPerDay: number | null;
  /** Connected social accounts (active) per workspace. */
  maxAccounts: number | null;
  /** Total bytes of media stored on R2 through /v1/media. */
  maxMediaBytes: number | null;
  /** Platforms the plan may connect and post to; null = all. */
  platforms: Platform[] | null;
  /** Whether the plan can READ collected analytics. Snapshots are captured for every plan
   * regardless — free just can't see them, so the history is there the moment they upgrade. */
  analytics: boolean;
}

const GiB = 1024 * 1024 * 1024;

export const PLANS: Record<PlanName, PlanLimits> = {
  free: {
    postsPerMonth: null, // the daily cap is the free plan's post limit
    postsPerDay: 1,
    maxAccounts: 3,
    maxMediaBytes: GiB / 2,
    platforms: ["facebook", "instagram"],
    analytics: false,
  },
  pro: { postsPerMonth: 2_000, postsPerDay: null, maxAccounts: 50, maxMediaBytes: 20 * GiB, platforms: null, analytics: true },
  scale: { postsPerMonth: null, postsPerDay: null, maxAccounts: null, maxMediaBytes: null, platforms: null, analytics: true },
};

export function isPlanName(value: string): value is PlanName {
  return (PLAN_NAMES as readonly string[]).includes(value);
}

/** Whether the plan may connect/post to this platform. */
export function planAllowsPlatform(limits: PlanLimits, platform: Platform): boolean {
  return limits.platforms === null || limits.platforms.includes(platform);
}

/** Whether the plan may read collected analytics. */
export function planAllowsAnalytics(limits: PlanLimits): boolean {
  return limits.analytics;
}

/** The cheapest plan whose limits satisfy `predicate` (PLAN_NAMES is ordered cheapest-first), or
 * null if none do — used to tell a gated caller which plan unlocks a feature. */
export function lowestPlanWhere(predicate: (limits: PlanLimits) => boolean): PlanName | null {
  return PLAN_NAMES.find((name) => predicate(PLANS[name])) ?? null;
}

/** `used` is under a possibly-absent limit (null = unlimited). */
export function withinLimit(used: number, limit: number | null): boolean {
  return limit === null || used < limit;
}
