import { describe, expect, it } from "vitest";
import { validateForPlatform } from "./validate.js";
import type { MediaRef } from "./types.js";

const jpeg = (sizeBytes: number): MediaRef => ({ url: "https://cdn.example/a.jpg", mimeType: "image/jpeg", sizeBytes });

describe("validateForPlatform", () => {
  it("accepts a short text-only post on X", () => {
    expect(validateForPlatform("x", "hello world", [])).toEqual([]);
  });

  it("rejects content longer than the X limit", () => {
    const issues = validateForPlatform("x", "a".repeat(281), []);
    expect(issues).toHaveLength(1);
    expect(issues[0]?.code).toBe("content_too_long");
  });

  it("requires media on Instagram", () => {
    const issues = validateForPlatform("instagram", "caption", []);
    expect(issues.map((i) => i.code)).toContain("media_required");
  });

  it("rejects an oversized image on Instagram", () => {
    const issues = validateForPlatform("instagram", "caption", [jpeg(50 * 1024 * 1024)]);
    expect(issues.map((i) => i.code)).toContain("media_too_large");
  });

  it("rejects an unsupported media type on TikTok (images not allowed)", () => {
    const issues = validateForPlatform("tiktok", "vid", [jpeg(1000)]);
    expect(issues.map((i) => i.code)).toContain("media_unsupported");
  });

  it("passes the same asset for one platform and rejects it for another, naming the limit", () => {
    const sixMb = jpeg(6 * 1024 * 1024); // over X's 5 MB image cap, under Instagram's 8 MB
    expect(validateForPlatform("instagram", "caption", [sixMb])).toEqual([]);
    const issues = validateForPlatform("x", "caption", [sixMb]);
    expect(issues).toHaveLength(1);
    expect(issues[0]?.code).toBe("media_too_large");
    expect(issues[0]?.platform).toBe("x");
    expect(issues[0]?.detail).toContain(String(5 * 1024 * 1024));
  });

  it("enforces video duration limits when the duration is declared", () => {
    const video: MediaRef = {
      url: "https://cdn.example/a.mp4",
      mimeType: "video/mp4",
      sizeBytes: 1000,
      durationSeconds: 200,
    };
    expect(validateForPlatform("linkedin", "v", [video])).toEqual([]); // 30 min limit
    const issues = validateForPlatform("x", "v", [video]); // 140 s limit
    expect(issues.map((i) => i.code)).toContain("media_too_long");
  });

  it("lets undeclared durations pass (media is never probed)", () => {
    const video: MediaRef = { url: "https://cdn.example/a.mp4", mimeType: "video/mp4", sizeBytes: 1000 };
    expect(validateForPlatform("x", "v", [video])).toEqual([]);
  });

  it("requires a destination board on Pinterest, satisfied via merged options", () => {
    const image: MediaRef = { url: "https://cdn.example/a.jpg", mimeType: "image/jpeg", sizeBytes: 1000 };
    expect(validateForPlatform("pinterest", "pin", [image]).map((i) => i.code)).toEqual(["board_required"]);
    expect(validateForPlatform("pinterest", "pin", [image], { boardId: "b1" })).toEqual([]);
  });

  it("rejects video on Pinterest (image-only connector)", () => {
    const video: MediaRef = { url: "https://cdn.example/a.mp4", mimeType: "video/mp4", sizeBytes: 1000 };
    const issues = validateForPlatform("pinterest", "pin", [video], { boardId: "b1" });
    expect(issues.map((i) => i.code)).toContain("media_unsupported");
  });
});
