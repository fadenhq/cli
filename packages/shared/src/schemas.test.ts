/**
 * The timestamp formats the API accepts are a contract with every client and agent. They are
 * pinned here by name so a dependency that changes date parsing fails a test that says what
 * broke, not just the OpenAPI snapshot.
 */
import { describe, expect, it } from "vitest";
import {
  createPostSchema,
  createWebhookSchema,
  isoDateTimeSchema,
  listPostsQuerySchema,
  registerMediaSchema,
  updateWebhookSchema,
  webhookUrlSchema,
} from "./schemas.js";
import { ACCEPTED_MEDIA_TYPES, isAcceptedMediaType } from "./platforms.js";

describe("isoDateTimeSchema", () => {
  it.each([
    ["minutes, UTC", "2026-07-01T09:00Z"],
    ["minutes, offset", "2026-07-01T09:00+02:00"],
    ["minutes, negative half-hour offset", "2026-07-01T09:00-05:30"],
    ["seconds", "2026-07-01T09:00:00Z"],
    ["milliseconds (what toISOString writes)", "2026-07-01T09:00:00.000Z"],
    ["microseconds", "2026-07-01T09:00:00.123456+00:00"],
    ["leap day", "2028-02-29T09:00Z"],
    ["leap day in a 400-year century", "2000-02-29T09:00Z"],
    ["leap day in year 0000 (not remapped to 1900)", "0000-02-29T09:00Z"],
    ["end of day", "2026-12-31T23:59:59Z"],
  ])("accepts %s: %s", (_label, value) => {
    expect(isoDateTimeSchema.safeParse(value).success).toBe(true);
  });

  it.each([
    ["no offset (ambiguous local time)", "2026-07-01T09:00"],
    ["date only", "2026-07-01"],
    ["space instead of T", "2026-07-01 09:00Z"],
    ["hour 24", "2026-07-01T24:00Z"],
    ["minute 60", "2026-07-01T09:60Z"],
    ["month 13", "2026-13-01T09:00Z"],
    ["February 30", "2026-02-30T09:00Z"],
    ["Feb 29 outside a leap year", "2026-02-29T09:00Z"],
    ["Feb 29 in a non-leap century", "1900-02-29T09:00Z"],
    ["day 00", "2026-07-00T09:00Z"],
    ["April 31", "2026-04-31T09:00Z"],
    ["offset without colon", "2026-07-01T09:00+0200"],
    ["natural language", "tomorrow 9am"],
  ])("rejects %s: %s", (_label, value) => {
    expect(isoDateTimeSchema.safeParse(value).success).toBe(false);
  });
});

describe("time fields use it", () => {
  it("scheduledFor on create accepts minute precision", () => {
    const res = createPostSchema.safeParse({ platforms: ["x"], scheduledFor: "2026-07-01T09:00Z" });
    expect(res.success).toBe(true);
  });

  it("list filters accept minute precision", () => {
    const res = listPostsQuerySchema.safeParse({ from: "2026-07-01T00:00Z", scheduledTo: "2026-08-01T00:00+02:00" });
    expect(res.success).toBe(true);
  });
});

describe("registerMediaSchema (#151)", () => {
  it.each(ACCEPTED_MEDIA_TYPES)("accepts supported media type %s", (mimeType) => {
    expect(isAcceptedMediaType(mimeType)).toBe(true);
    expect(registerMediaSchema.safeParse({ mimeType, sizeBytes: 1024 }).success).toBe(true);
  });

  it.each(["text/html", "image/svg+xml", "application/javascript", "application/octet-stream", "text/plain"])(
    "rejects unsupported or active type %s",
    (mimeType) => {
      expect(isAcceptedMediaType(mimeType)).toBe(false);
      expect(registerMediaSchema.safeParse({ mimeType, sizeBytes: 1024 }).success).toBe(false);
    },
  );

  it("requires a positive integer sizeBytes", () => {
    expect(registerMediaSchema.safeParse({ mimeType: "image/jpeg" }).success).toBe(false);
    expect(registerMediaSchema.safeParse({ mimeType: "image/jpeg", sizeBytes: 0 }).success).toBe(false);
    expect(registerMediaSchema.safeParse({ mimeType: "image/jpeg", sizeBytes: -1 }).success).toBe(false);
  });
});

describe("webhookUrlSchema (#152)", () => {
  it.each(["https://hooks.example.com/faden", "http://localhost:8787/hook", "http://127.0.0.1:9000/hook", "http://[::1]/hook"])(
    "accepts %s",
    (url) => expect(webhookUrlSchema.safeParse(url).success).toBe(true),
  );

  it.each([
    ["plaintext http", "http://hooks.example.com/faden"],
    ["http to a host that merely starts with localhost", "http://localhost.evil.test/hook"],
    ["http with localhost as userinfo", "http://localhost@evil.test/hook"],
    ["file", "file:///etc/passwd"],
    ["ftp", "ftp://example.com/hook"],
    ["not a URL", "hooks.example.com"],
  ])("rejects %s", (_name, url) => expect(webhookUrlSchema.safeParse(url).success).toBe(false));

  it("guards both create and update", () => {
    expect(createWebhookSchema.safeParse({ url: "http://hooks.example.com" }).success).toBe(false);
    expect(updateWebhookSchema.safeParse({ url: "http://hooks.example.com" }).success).toBe(false);
    expect(updateWebhookSchema.safeParse({ status: "active" }).success).toBe(true);
  });
});
