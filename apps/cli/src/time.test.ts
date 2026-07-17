import { describe, expect, it } from "vitest";
import { toIsoUtc } from "./time.js";

describe("toIsoUtc", () => {
  it("passes through a Z-qualified instant", () => {
    expect(toIsoUtc("2026-07-01T13:00:00Z").scheduledFor).toBe("2026-07-01T13:00:00.000Z");
  });

  it("converts a zoned wall time to UTC (EDT is UTC-4 in July)", () => {
    const { scheduledFor, timezone } = toIsoUtc("2026-07-01T09:00 America/New_York");
    expect(scheduledFor).toBe("2026-07-01T13:00:00.000Z");
    expect(timezone).toBe("America/New_York");
  });

  it("converts a zoned wall time accounting for standard time (EST is UTC-5 in January)", () => {
    expect(toIsoUtc("2026-01-15T09:00 America/New_York").scheduledFor).toBe("2026-01-15T14:00:00.000Z");
  });
});
