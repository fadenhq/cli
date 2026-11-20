/**
 * Plan limits decide what customers pay for. The matrix is pinned so a change to it is a visible,
 * reviewed diff here and not a side effect of an unrelated edit.
 */
import { describe, expect, it } from "vitest";
import {
  isBillingMode,
  isPlanName,
  lowestPlanWhere,
  planAllowsAnalytics,
  planAllowsPlatform,
  PLANS,
  withinLimit,
} from "./plans.js";
import { PLATFORMS } from "./platforms.js";

describe("plan matrix", () => {
  it("free: one post a day, Facebook and Instagram only, no analytics", () => {
    expect(PLANS.free).toMatchObject({ postsPerDay: 1, postsPerMonth: null, maxAccounts: 3, analytics: false });
    expect(PLATFORMS.filter((p) => planAllowsPlatform(PLANS.free, p)).sort()).toEqual(["facebook", "instagram"]);
  });

  it("pro: 2,000 posts a month, every platform, analytics", () => {
    expect(PLANS.pro).toMatchObject({ postsPerMonth: 2_000, postsPerDay: null, maxAccounts: 50, analytics: true });
    expect(PLATFORMS.every((p) => planAllowsPlatform(PLANS.pro, p))).toBe(true);
  });

  it("scale: no limits", () => {
    expect(PLANS.scale).toEqual({
      postsPerMonth: null,
      postsPerDay: null,
      maxAccounts: null,
      maxMediaBytes: null,
      platforms: null,
      analytics: true,
    });
  });

  it("never gets worse when moving up a plan", () => {
    const rank = (v: number | null) => (v === null ? Infinity : v);
    const order = [PLANS.free, PLANS.pro, PLANS.scale];
    for (let i = 1; i < order.length; i++) {
      const [lower, higher] = [order[i - 1]!, order[i]!];
      expect(rank(higher.maxAccounts)).toBeGreaterThanOrEqual(rank(lower.maxAccounts));
      expect(rank(higher.maxMediaBytes)).toBeGreaterThanOrEqual(rank(lower.maxMediaBytes));
      expect(rank(higher.postsPerDay)).toBeGreaterThanOrEqual(rank(lower.postsPerDay));
      for (const p of PLATFORMS) if (planAllowsPlatform(lower, p)) expect(planAllowsPlatform(higher, p)).toBe(true);
      if (planAllowsAnalytics(lower)) expect(planAllowsAnalytics(higher)).toBe(true);
    }
  });
});

describe("lowestPlanWhere", () => {
  it("names the cheapest plan that unlocks a feature", () => {
    expect(lowestPlanWhere(planAllowsAnalytics)).toBe("pro");
    expect(lowestPlanWhere((l) => planAllowsPlatform(l, "facebook"))).toBe("free");
    expect(lowestPlanWhere((l) => planAllowsPlatform(l, "x"))).toBe("pro");
    expect(lowestPlanWhere((l) => l.maxAccounts === null)).toBe("scale");
  });

  it("returns null when no plan qualifies", () => {
    expect(lowestPlanWhere(() => false)).toBeNull();
  });
});

describe("withinLimit", () => {
  it("is strictly below the limit, and null means unlimited", () => {
    expect(withinLimit(0, 1)).toBe(true);
    expect(withinLimit(1, 1)).toBe(false);
    expect(withinLimit(1_000_000, null)).toBe(true);
  });
});

describe("guards", () => {
  it("recognizes plan names and billing modes", () => {
    expect(["free", "pro", "scale", "enterprise"].map(isPlanName)).toEqual([true, true, true, false]);
    expect(["live", "test", "sandbox"].map(isBillingMode)).toEqual([true, true, false]);
  });
});
