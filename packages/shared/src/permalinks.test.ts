import { describe, expect, it } from "vitest";
import { postPermalink } from "./permalinks.js";
import { PLATFORMS } from "./platforms.js";

describe("postPermalink", () => {
  it("derives the public URL from the native id", () => {
    expect(postPermalink("x", "1788")).toBe("https://x.com/i/web/status/1788");
    expect(postPermalink("linkedin", "urn:li:share:7100")).toBe(
      "https://www.linkedin.com/feed/update/urn:li:share:7100/",
    );
    expect(postPermalink("facebook", "page-1_post-9")).toBe("https://www.facebook.com/page-1/posts/post-9");
    expect(postPermalink("youtube", "vid-42")).toBe("https://www.youtube.com/watch?v=vid-42");
    expect(postPermalink("pinterest", "pin-123")).toBe("https://www.pinterest.com/pin/pin-123/");
    expect(postPermalink("bluesky", "at://did:plc:alice/app.bsky.feed.post/3k44")).toBe(
      "https://bsky.app/profile/did:plc:alice/post/3k44",
    );
  });

  it("links a bare Facebook object id (video publishes) to the object itself", () => {
    expect(postPermalink("facebook", "video-1")).toBe("https://www.facebook.com/video-1");
  });

  it("returns null for platforms whose URL cannot be derived from the id", () => {
    // Instagram/Threads permalinks come from the platform at publish time; TikTok needs a
    // username we don't hold; Google Business local posts have no public URL.
    expect(postPermalink("instagram", "ig-media-99")).toBeNull();
    expect(postPermalink("threads", "18103510007603304")).toBeNull();
    expect(postPermalink("tiktok", "7345")).toBeNull();
    expect(postPermalink("google_business", "accounts/108/locations/42/localPosts/777")).toBeNull();
  });

  it("returns null for ids that do not match the platform's shape", () => {
    expect(postPermalink("linkedin", "7100")).toBeNull();
    expect(postPermalink("bluesky", "at://did:plc:alice/app.bsky.feed.like/3k44")).toBeNull();
    for (const platform of PLATFORMS) expect(postPermalink(platform, "  ")).toBeNull();
  });
});
