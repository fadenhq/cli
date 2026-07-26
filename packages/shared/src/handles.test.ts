import { describe, expect, it } from "vitest";
import { slugifyHandle, uniqueHandle } from "./handles.js";
import { accountHandleSchema } from "./schemas.js";

describe("slugifyHandle", () => {
  it("lowercases, collapses non-alphanumerics to single hyphens, and trims", () => {
    expect(slugifyHandle("Acme Coffee Page")).toBe("acme-coffee-page");
    expect(slugifyHandle("  Weird__Name!! ")).toBe("weird-name");
    expect(slugifyHandle("Café ☕ Corner")).toBe("caf-corner");
  });

  it("returns empty when nothing usable remains, and caps length without a trailing hyphen", () => {
    expect(slugifyHandle("☕☕☕")).toBe("");
    const long = slugifyHandle("a".repeat(80));
    expect(long).toHaveLength(60);
    expect(long.endsWith("-")).toBe(false);
  });
});

describe("uniqueHandle", () => {
  it("returns the base when free, else appends an incrementing suffix", () => {
    expect(uniqueHandle("acme", new Set())).toBe("acme");
    expect(uniqueHandle("acme", new Set(["acme"]))).toBe("acme-2");
    expect(uniqueHandle("acme", new Set(["acme", "acme-2"]))).toBe("acme-3");
  });

  it("falls back when the base is empty", () => {
    expect(uniqueHandle("", new Set())).toBe("account");
    expect(uniqueHandle("", new Set(["account"]))).toBe("account-2");
  });
});

describe("accountHandleSchema", () => {
  it("accepts valid slugs", () => {
    for (const ok of ["acme", "acme-coffee", "page-2", "a1b2"]) {
      expect(accountHandleSchema.safeParse(ok).success).toBe(true);
    }
  });

  it("rejects spaces, symbols, uppercase, and leading/trailing/double hyphens", () => {
    for (const bad of ["Acme", "acme coffee", "acme_coffee", "-acme", "acme-", "acme--coffee", "acme!", ""]) {
      expect(accountHandleSchema.safeParse(bad).success).toBe(false);
    }
  });
});
