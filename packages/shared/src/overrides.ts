import type { Platform } from "./platforms.js";
import type { MediaRef } from "./types.js";

/**
 * Schema v2: per-platform and per-account tailoring of a unified post. Clients submit overrides
 * as `platformConfigurations` / `accountConfigurations` (see schemas.ts); the API resolves any
 * override media up front and persists the result on the post in this *stored* form, which is
 * what publish-time merging and `GET /v1/posts/:id` operate on.
 */

/**
 * Platform-specific publish options beyond content/media, passed through to the connector.
 * One flat bag keeps `PublishRequest` simple; each field only means something to its platform
 * (the per-platform input schemas restrict which fields a platform override may set).
 */
export interface PublishOptions {
  /** instagram: feed | story | reel */
  placement?: "feed" | "story" | "reel";
  /** instagram: cover image for reels */
  coverImageUrl?: string;
  /** youtube / tiktok / pinterest: native title distinct from the caption */
  title?: string;
  /** youtube: custom thumbnail */
  thumbnailUrl?: string;
  /** youtube */
  visibility?: "public" | "private" | "unlisted";
  /** tiktok: leave the post as a platform-side draft */
  draft?: boolean;
  /** tiktok: AI-generated-content disclosure flag */
  isAigc?: boolean;
  /** facebook: link attachment; pinterest: pin destination link; google_business: CTA button URL */
  linkUrl?: string;
  /** pinterest: destination board (required — list boards via `GET /v1/accounts/{id}/boards`) */
  boardId?: string;
  /** google_business: destination location (required — list via `GET /v1/accounts/{id}/boards`) */
  locationId?: string;
  /** google_business: call-to-action button; every type but CALL needs `linkUrl` */
  ctaType?: "BOOK" | "ORDER" | "SHOP" | "LEARN_MORE" | "SIGN_UP" | "CALL";
}

/** One override in stored form: media already resolved to refs, platform fields split out. */
export interface StoredOverride {
  content?: string;
  media?: MediaRef[];
  options?: PublishOptions;
}

/** Everything persisted on a post's `configurations` column. */
export interface PostConfigurations {
  platforms?: Partial<Record<Platform, StoredOverride>>;
  accounts?: Record<string, StoredOverride>;
}

/** The fully merged view a connector publishes: what {@link mergeTargetConfig} produces. */
export interface MergedTargetConfig {
  content: string;
  media: MediaRef[];
  options: PublishOptions;
}

/**
 * Merge the base post with its overrides for one fan-out target. Field-level precedence is
 * account > platform > base; platform-specific options shallow-merge with account keys winning.
 */
export function mergeTargetConfig(
  platform: Platform,
  base: { content: string; media: MediaRef[] },
  configurations: PostConfigurations | null | undefined,
  accountId: string,
): MergedTargetConfig {
  const p = configurations?.platforms?.[platform];
  const a = configurations?.accounts?.[accountId];
  return {
    content: a?.content ?? p?.content ?? base.content,
    media: a?.media ?? p?.media ?? base.media,
    options: { ...p?.options, ...a?.options },
  };
}

/** Parse a post's persisted `configurations` column; malformed/absent JSON is treated as none. */
export function parsePostConfigurations(json: string | null | undefined): PostConfigurations | null {
  if (!json) return null;
  try {
    const parsed = JSON.parse(json) as PostConfigurations;
    return typeof parsed === "object" && parsed !== null ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * Split one raw override input (`{ content?, mediaUrls?, ...platformFields }`) into its parts.
 * `mediaUrls` still needs resolving to {@link MediaRef}s — the API layer owns that.
 */
export function splitOverrideInput(input: Record<string, unknown>): {
  content?: string;
  mediaUrls?: string[];
  options: PublishOptions;
} {
  const { content, mediaUrls, ...options } = input;
  return {
    content: content as string | undefined,
    mediaUrls: mediaUrls as string[] | undefined,
    options: options as PublishOptions,
  };
}
