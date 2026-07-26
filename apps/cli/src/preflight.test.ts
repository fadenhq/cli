import { describe, expect, it } from "vitest";
import { formatPreflight, preflight } from "./preflight.js";

describe("preflight", () => {
  it("passes content that fits every requested platform", () => {
    const result = preflight(["x", "linkedin"], "short and sweet", []);
    expect(result.ok).toBe(true);
    expect(result.issues).toEqual([]);
  });

  it("flags the platform whose limit is exceeded, not the one that fits", () => {
    const result = preflight(["x", "linkedin"], "a".repeat(500), []);
    expect(result.ok).toBe(false);
    expect(result.issues).toHaveLength(1);
    expect(result.issues[0]).toMatchObject({ platform: "x", code: "content_too_long" });
    expect(result.perPlatform).toEqual([
      { platform: "x", contentLength: 500, maxContentLength: 280, ok: false },
      { platform: "linkedin", contentLength: 500, maxContentLength: 3000, ok: true },
    ]);
  });

  it("catches a missing Pinterest board before the API does", () => {
    const withoutBoard = preflight(["pinterest"], "pin", ["https://cdn.example/a.jpg"]);
    expect(withoutBoard.issues.map((i) => i.code)).toContain("board_required");

    const withBoard = preflight(["pinterest"], "pin", ["https://cdn.example/a.jpg"], {
      pinterest: { boardId: "b_1" },
    });
    expect(withBoard.ok).toBe(true);
  });

  it("catches media requirements and counts", () => {
    expect(preflight(["instagram"], "no media", []).issues.map((i) => i.code)).toContain("media_required");
    const tooMany = preflight(["x"], "hi", Array.from({ length: 5 }, (_, i) => `https://cdn.example/${i}.jpg`));
    expect(tooMany.issues.map((i) => i.code)).toContain("too_many_media");
  });

  it("reports unguessable media types instead of inventing a failure the API would not raise", () => {
    const result = preflight(["x"], "hi", ["https://cdn.example/asset?id=1"]);
    expect(result.mediaNotCheckedLocally).toEqual(["https://cdn.example/asset?id=1"]);
    expect(result.issues).toEqual([]);
  });

  it("still checks types it can read from the extension", () => {
    const result = preflight(["instagram"], "hi", ["https://cdn.example/a.png"]);
    expect(result.issues.map((i) => i.code)).toContain("media_unsupported");
    expect(result.mediaNotCheckedLocally).toEqual([]);
  });

  it("renders a compact text summary", () => {
    const text = formatPreflight(preflight(["x"], "a".repeat(300), []));
    expect(text).toContain("FAIL");
    expect(text).toContain("300/280");
    expect(text).toContain("content_too_long");
  });
});
