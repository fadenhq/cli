import { describe, expect, it } from "vitest";
import { disconnectPlan, findAccount } from "./accounts.js";

const accounts = [
  { id: "acc_1", handle: "main-brand", platform: "x", status: "active" },
  { id: "acc_2", handle: "acc_1", platform: "linkedin", status: "disconnected" },
];

describe("findAccount", () => {
  it("matches an id before a handle, so a handle that looks like an id can't shadow it", () => {
    expect(findAccount(accounts, "acc_1")?.platform).toBe("x");
    expect(findAccount(accounts, "main-brand")?.id).toBe("acc_1");
    expect(findAccount(accounts, "nope")).toBeUndefined();
  });
});

describe("disconnectPlan", () => {
  it("names the DELETE it would send, and whether there's anything left to disconnect", () => {
    expect(disconnectPlan(accounts[0]!)).toEqual({
      dryRun: true,
      account: accounts[0],
      wouldDisconnect: true,
      request: { method: "DELETE", path: "/v1/accounts/acc_1" },
    });
    expect(disconnectPlan(accounts[1]!).wouldDisconnect).toBe(false);
  });
});
