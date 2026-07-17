import { describe, expect, it } from "vitest";
import { mergeTargetConfig, parsePostConfigurations, splitOverrideInput, type PostConfigurations } from "./overrides.js";
import type { MediaRef } from "./types.js";

const img = (url: string): MediaRef => ({ url, mimeType: "image/jpeg", sizeBytes: 100 });

const base = { content: "base caption", media: [img("https://cdn.example/base.jpg")] };

describe("mergeTargetConfig", () => {
  it("returns the base view when there are no overrides", () => {
    expect(mergeTargetConfig("x", base, null, "acc-1")).toEqual({
      content: "base caption",
      media: base.media,
      options: {},
    });
  });

  it("applies a platform override over the base", () => {
    const cfg: PostConfigurations = {
      platforms: { x: { content: "x caption", media: [img("https://cdn.example/x.jpg")] } },
    };
    const merged = mergeTargetConfig("x", base, cfg, "acc-1");
    expect(merged.content).toBe("x caption");
    expect(merged.media[0]?.url).toBe("https://cdn.example/x.jpg");
    // other platforms keep the base view
    expect(mergeTargetConfig("linkedin", base, cfg, "acc-2").content).toBe("base caption");
  });

  it("lets an account override win over the platform override (account > platform > base)", () => {
    const cfg: PostConfigurations = {
      platforms: { x: { content: "platform caption", media: [img("https://cdn.example/p.jpg")] } },
      accounts: { "acc-1": { content: "account caption" } },
    };
    const merged = mergeTargetConfig("x", base, cfg, "acc-1");
    expect(merged.content).toBe("account caption");
    // precedence is per field: the account override sets no media, so the platform's wins
    expect(merged.media[0]?.url).toBe("https://cdn.example/p.jpg");
    // a different account on the same platform only sees the platform override
    expect(mergeTargetConfig("x", base, cfg, "acc-other").content).toBe("platform caption");
  });

  it("shallow-merges platform options with account keys winning", () => {
    const cfg: PostConfigurations = {
      platforms: { instagram: { options: { placement: "feed", coverImageUrl: "https://cdn.example/c.jpg" } } },
      accounts: { "acc-1": { options: { placement: "reel" } } },
    };
    const merged = mergeTargetConfig("instagram", base, cfg, "acc-1");
    expect(merged.options).toEqual({ placement: "reel", coverImageUrl: "https://cdn.example/c.jpg" });
  });
});

describe("parsePostConfigurations", () => {
  it("round-trips a stored object and treats null/malformed JSON as none", () => {
    const cfg: PostConfigurations = { platforms: { x: { content: "hi" } } };
    expect(parsePostConfigurations(JSON.stringify(cfg))).toEqual(cfg);
    expect(parsePostConfigurations(null)).toBeNull();
    expect(parsePostConfigurations("not json")).toBeNull();
    expect(parsePostConfigurations('"a string"')).toBeNull();
  });
});

describe("splitOverrideInput", () => {
  it("separates content/mediaUrls from platform-specific options", () => {
    expect(splitOverrideInput({ content: "hi", mediaUrls: ["https://a/b.jpg"], placement: "reel" })).toEqual({
      content: "hi",
      mediaUrls: ["https://a/b.jpg"],
      options: { placement: "reel" },
    });
  });
});
