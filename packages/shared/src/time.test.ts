import { describe, expect, it } from "vitest";
import { todayInZone, tzOffsetMinutes, zonedWallTimeToUtc } from "./time.js";

describe("zonedWallTimeToUtc", () => {
  it.each([
    // Plain cases, both hemispheres and a half-hour zone.
    ["2026-07-01T09:00", "America/New_York", "2026-07-01T13:00:00.000Z"],
    ["2026-01-15T09:00", "America/New_York", "2026-01-15T14:00:00.000Z"],
    ["2026-07-01T09:00", "Europe/Berlin", "2026-07-01T07:00:00.000Z"],
    ["2026-01-15T09:00", "Europe/Berlin", "2026-01-15T08:00:00.000Z"],
    ["2026-01-15T09:00", "Asia/Kolkata", "2026-01-15T03:30:00.000Z"],
    ["2026-07-01T09:00", "Australia/Sydney", "2026-06-30T23:00:00.000Z"],
    ["2026-07-01T09:00", "UTC", "2026-07-01T09:00:00.000Z"],
    // Day of a DST change, after the change: the offset in force at that wall time must win,
    // not the one in force at "the wall time read as UTC".
    ["2026-03-08T04:00", "America/New_York", "2026-03-08T08:00:00.000Z"], // spring forward, EDT
    ["2026-11-01T03:00", "America/New_York", "2026-11-01T08:00:00.000Z"], // fall back, EST
    ["2026-03-29T01:30", "Europe/Berlin", "2026-03-29T00:30:00.000Z"], // before spring forward, CET
    ["2026-10-25T03:30", "Europe/Berlin", "2026-10-25T02:30:00.000Z"], // after fall back, CET
  ])("%s in %s is %s", (local, zone, utc) => {
    expect(zonedWallTimeToUtc(local, zone)).toBe(utc);
  });

  it("maps a wall time that happens twice (fall back) to one of its two instants", () => {
    expect(["2026-10-25T00:30:00.000Z", "2026-10-25T01:30:00.000Z"]).toContain(
      zonedWallTimeToUtc("2026-10-25T02:30", "Europe/Berlin"),
    );
    expect(["2026-11-01T05:30:00.000Z", "2026-11-01T06:30:00.000Z"]).toContain(
      zonedWallTimeToUtc("2026-11-01T01:30", "America/New_York"),
    );
  });

  it("round-trips every hour of the DST-change days", () => {
    for (const [zone, day] of [
      ["America/New_York", "2026-03-08"],
      ["America/New_York", "2026-11-01"],
      ["Europe/Berlin", "2026-03-29"],
      ["Europe/Berlin", "2026-10-25"],
    ] as const) {
      for (let h = 0; h < 24; h++) {
        const local = `${day}T${String(h).padStart(2, "0")}:15`;
        const utc = new Date(zonedWallTimeToUtc(local, zone));
        const back = new Intl.DateTimeFormat("sv-SE", {
          timeZone: zone,
          year: "numeric",
          month: "2-digit",
          day: "2-digit",
          hour: "2-digit",
          minute: "2-digit",
        })
          .format(utc)
          .replace(" ", "T");
        // A wall time skipped by spring-forward has no exact instant; everything else must
        // map back to itself.
        const skipped =
          (zone === "America/New_York" && day === "2026-03-08" && h === 2) ||
          (zone === "Europe/Berlin" && day === "2026-03-29" && h === 2);
        if (!skipped) expect(back, `${zone} ${local}`).toBe(local);
      }
    }
  });

  it("rejects an unparseable time", () => {
    expect(() => zonedWallTimeToUtc("tomorrow at nine", "UTC")).toThrow(/invalid datetime/);
  });
});

describe("tzOffsetMinutes", () => {
  it.each([
    ["America/New_York", "2026-01-15T12:00:00Z", -300],
    ["America/New_York", "2026-07-01T12:00:00Z", -240],
    ["Asia/Kolkata", "2026-07-01T12:00:00Z", 330],
    ["UTC", "2026-07-01T12:00:00Z", 0],
  ])("%s at %s is %i", (zone, at, offset) => {
    expect(tzOffsetMinutes(zone, new Date(at))).toBe(offset);
  });

  it("handles midnight (Intl may report hour 24)", () => {
    expect(tzOffsetMinutes("Europe/Berlin", new Date("2026-01-14T23:00:00Z"))).toBe(60);
  });
});

describe("todayInZone", () => {
  it("returns the calendar date in the zone, anchored at UTC noon", () => {
    // 02:00 UTC on Jan 15 is still Jan 14 in New York.
    const now = Date.parse("2026-01-15T02:00:00Z");
    expect(todayInZone("America/New_York", now).toISOString()).toBe("2026-01-14T12:00:00.000Z");
    expect(todayInZone("Asia/Tokyo", now).toISOString()).toBe("2026-01-15T12:00:00.000Z");
  });
});
