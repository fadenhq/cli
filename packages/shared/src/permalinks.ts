import type { Platform } from "./platforms.js";

/**
 * Public URL of a published post, derived from its platform-native id.
 *
 * Most networks mint permalinks from the id alone, so this is a pure function — no extra API call,
 * and it works for posts published before permalinks existed. The exceptions:
 *
 * - Instagram and Threads: the Graph API's media id lives in a different namespace than the
 *   shortcode in the public URL, so their permalink has to come from the platform (`fields=
 *   permalink`) at publish time and is stored on the target.
 * - TikTok: the public URL needs the account's `username`, which the Content Posting API scope
 *   does not return.
 * - Google Business: local posts have no public permalink at all.
 *
 * Returns `null` when no URL can be derived; callers fall back to a stored permalink.
 */
/**
 * Percent-encode a path segment but keep colons literal: DIDs and LinkedIn urns carry them, and
 * both sites 404 (bsky: "Invalid DID or handle") on the encoded form. `:` is a legal path char.
 */
function segment(value: string): string {
  return encodeURIComponent(value).replace(/%3A/g, ":");
}

export function postPermalink(platform: Platform, nativePostId: string): string | null {
  const id = nativePostId.trim();
  if (id === "") return null;

  switch (platform) {
    case "x":
      // The /i/web/ form redirects to the canonical @handle URL, so we never need the handle.
      return `https://x.com/i/web/status/${segment(id)}`;
    case "linkedin":
      // x-restli-id is a share or ugcPost urn; the feed accepts either verbatim.
      return id.startsWith("urn:li:") ? `https://www.linkedin.com/feed/update/${segment(id)}/` : null;
    case "facebook": {
      // Page posts come back as `{pageId}_{postId}`; videos as a bare object id.
      const [pageId, postId] = id.split("_");
      if (pageId === undefined) return null;
      return postId === undefined || postId === ""
        ? `https://www.facebook.com/${segment(pageId)}`
        : `https://www.facebook.com/${segment(pageId)}/posts/${segment(postId)}`;
    }
    case "youtube":
      return `https://www.youtube.com/watch?v=${segment(id)}`;
    case "pinterest":
      return `https://www.pinterest.com/pin/${segment(id)}/`;
    case "bluesky": {
      // at://{did}/app.bsky.feed.post/{rkey}
      const match = /^at:\/\/([^/]+)\/app\.bsky\.feed\.post\/([^/]+)$/.exec(id);
      if (!match) return null;
      return `https://bsky.app/profile/${segment(match[1]!)}/post/${segment(match[2]!)}`;
    }
    case "instagram":
    case "threads":
    case "tiktok":
    case "google_business":
      return null;
  }
}
