import { describe, expect, it } from "vitest";
import { missingMediaScopes } from "./platforms.js";

describe("missingMediaScopes (#157)", () => {
  it("reports X grants without media.write", () => {
    expect(missingMediaScopes("x", "tweet.read tweet.write users.read offline.access")).toEqual(["media.write"]);
    expect(missingMediaScopes("x", "tweet.read tweet.write users.read media.write offline.access")).toEqual([]);
  });

  it("treats an unrecorded grant as unknown, and other platforms as needing nothing", () => {
    expect(missingMediaScopes("x", null)).toEqual([]);
    expect(missingMediaScopes("linkedin", "openid profile")).toEqual([]);
  });
});
