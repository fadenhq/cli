/**
 * Supported social networks. Meta is split into its three publishing surfaces because each has a
 * distinct payload shape even though they share the Graph API and OAuth app.
 */
export const PLATFORMS = [
  "x",
  "linkedin",
  "instagram",
  "facebook",
  "threads",
  "tiktok",
  "youtube",
  "bluesky",
  "pinterest",
  "google_business",
] as const;

export type Platform = (typeof PLATFORMS)[number];

/**
 * Platforms that connect with user-supplied credentials (e.g. a Bluesky app password) instead of
 * an OAuth redirect flow. Their connect endpoint takes `{ identifier, appPassword }` and returns
 * the connected account directly — there is no URL for the user to open.
 */
export const CREDENTIAL_CONNECT_PLATFORMS = ["bluesky"] as const satisfies readonly Platform[];

/**
 * OAuth scopes faden needs to post media, per platform. Accounts connected before a scope was added
 * (X's `media.write`, #157) must reconnect to grant it; text-only posts still work without it.
 */
export const MEDIA_SCOPES: Partial<Record<Platform, readonly string[]>> = { x: ["media.write"] };

/**
 * Media scopes an account's stored grant lacks. `scopes` is the space-separated grant from the
 * token response; null (not recorded) is treated as unknown, so nothing is reported missing.
 */
export function missingMediaScopes(platform: string, scopes: string | null | undefined): string[] {
  const needed = MEDIA_SCOPES[platform as Platform];
  if (!needed || scopes == null) return [];
  const granted = new Set(scopes.split(/[\s,]+/).filter(Boolean));
  return needed.filter((s) => !granted.has(s));
}

export function isPlatform(value: string): value is Platform {
  return (PLATFORMS as readonly string[]).includes(value);
}

/**
 * Per-platform constraints used for pre-flight validation. These let us reject a post (or a single
 * fan-out target) before anything is queued, instead of discovering the failure at publish time.
 *
 * `maxImageBytes` / `maxVideoBytes` are upper bounds; concrete connectors may tighten them.
 * Since media is pass-through (no transcoding), out-of-spec assets are rejected up front.
 */
export interface PlatformConstraints {
  /** Max characters in the post body. */
  maxContentLength: number;
  /** Max number of media attachments per post. */
  maxMediaCount: number;
  allowsImages: boolean;
  allowsVideo: boolean;
  /** Whether at least one media attachment is required (e.g. Instagram feed, TikTok, YouTube). */
  requiresMedia: boolean;
  maxImageBytes: number;
  maxVideoBytes: number;
  acceptedImageTypes: readonly string[];
  acceptedVideoTypes: readonly string[];
  /**
   * Max video length. Media is pass-through (no transcoding, no ffprobe), so this is enforced
   * only when a duration is known: clients declare it at upload (`POST /v1/media`), and it is
   * stored with the asset. Undeclared durations pass pre-flight and fail at the platform.
   */
  maxVideoDurationSeconds?: number;
}

const MB = 1024 * 1024;
const GB = 1024 * MB;

export const ACCEPTED_IMAGE_TYPES = ["image/jpeg", "image/png", "image/webp", "image/gif"] as const;
export const ACCEPTED_VIDEO_TYPES = ["video/mp4", "video/quicktime", "video/webm"] as const;
/** Every media MIME type accepted by at least one platform in the constraint matrix (#151). */
export const ACCEPTED_MEDIA_TYPES = [...ACCEPTED_IMAGE_TYPES, ...ACCEPTED_VIDEO_TYPES] as const;
export type AcceptedMediaType = (typeof ACCEPTED_MEDIA_TYPES)[number];

export function isAcceptedMediaType(value: string): value is AcceptedMediaType {
  return (ACCEPTED_MEDIA_TYPES as readonly string[]).includes(value);
}

const IMAGE_TYPES = ACCEPTED_IMAGE_TYPES;
const VIDEO_TYPES = ACCEPTED_VIDEO_TYPES;

export const PLATFORM_CONSTRAINTS: Record<Platform, PlatformConstraints> = {
  x: {
    maxContentLength: 280,
    maxMediaCount: 4,
    allowsImages: true,
    allowsVideo: true,
    requiresMedia: false,
    maxImageBytes: 5 * MB,
    maxVideoBytes: 512 * MB,
    acceptedImageTypes: IMAGE_TYPES,
    acceptedVideoTypes: ["video/mp4"],
    maxVideoDurationSeconds: 140, // 140s on standard API access
  },
  linkedin: {
    maxContentLength: 3000,
    maxMediaCount: 9,
    allowsImages: true,
    allowsVideo: true,
    requiresMedia: false,
    maxImageBytes: 10 * MB,
    maxVideoBytes: 5 * GB,
    acceptedImageTypes: IMAGE_TYPES,
    acceptedVideoTypes: VIDEO_TYPES,
    maxVideoDurationSeconds: 30 * 60,
  },
  instagram: {
    maxContentLength: 2200,
    maxMediaCount: 10,
    allowsImages: true,
    allowsVideo: true,
    requiresMedia: true,
    maxImageBytes: 8 * MB,
    maxVideoBytes: 1 * GB,
    acceptedImageTypes: ["image/jpeg"],
    acceptedVideoTypes: ["video/mp4"],
    maxVideoDurationSeconds: 15 * 60, // Reels via API
  },
  facebook: {
    maxContentLength: 63206,
    maxMediaCount: 10,
    allowsImages: true,
    allowsVideo: true,
    requiresMedia: false,
    maxImageBytes: 10 * MB,
    maxVideoBytes: 4 * GB,
    acceptedImageTypes: IMAGE_TYPES,
    acceptedVideoTypes: VIDEO_TYPES,
    maxVideoDurationSeconds: 240 * 60,
  },
  threads: {
    maxContentLength: 500,
    maxMediaCount: 10,
    allowsImages: true,
    allowsVideo: true,
    requiresMedia: false,
    maxImageBytes: 8 * MB,
    maxVideoBytes: 1 * GB,
    acceptedImageTypes: ["image/jpeg", "image/png"],
    acceptedVideoTypes: ["video/mp4"],
    maxVideoDurationSeconds: 5 * 60,
  },
  tiktok: {
    maxContentLength: 2200,
    maxMediaCount: 1,
    allowsImages: false,
    allowsVideo: true,
    requiresMedia: true,
    maxImageBytes: 0,
    maxVideoBytes: 4 * GB,
    acceptedImageTypes: [],
    acceptedVideoTypes: ["video/mp4", "video/webm"],
    maxVideoDurationSeconds: 10 * 60, // account-dependent; 10 min is the API ceiling
  },
  youtube: {
    maxContentLength: 5000,
    maxMediaCount: 1,
    allowsImages: false,
    allowsVideo: true,
    requiresMedia: true,
    maxImageBytes: 0,
    maxVideoBytes: 128 * GB,
    acceptedImageTypes: [],
    acceptedVideoTypes: ["video/mp4", "video/quicktime", "video/webm"],
    maxVideoDurationSeconds: 12 * 3600, // verified-account limit
  },
  // Video needs Bluesky's separate video service (upload job + polling) — not in connector v1.
  bluesky: {
    maxContentLength: 300,
    maxMediaCount: 4,
    allowsImages: true,
    allowsVideo: false,
    requiresMedia: false,
    maxImageBytes: 1_000_000, // AT Protocol blob limit
    maxVideoBytes: 0,
    acceptedImageTypes: ["image/jpeg", "image/png", "image/webp"],
    acceptedVideoTypes: [],
  },
  // Video pins need Pinterest's media-upload flow (S3 form upload + ingest polling), which can't
  // stream bounded-memory from a Worker — image pins only in connector v1.
  pinterest: {
    maxContentLength: 800, // pin description limit
    maxMediaCount: 5, // carousel ceiling
    allowsImages: true,
    allowsVideo: false,
    requiresMedia: true,
    maxImageBytes: 20 * MB,
    maxVideoBytes: 0,
    acceptedImageTypes: ["image/jpeg", "image/png", "image/webp"],
    acceptedVideoTypes: [],
  },
  // Google Business Profile local posts: text + at most one photo; no video surface in the API.
  google_business: {
    maxContentLength: 1500, // local-post summary limit
    maxMediaCount: 1,
    allowsImages: true,
    allowsVideo: false,
    requiresMedia: false,
    maxImageBytes: 5 * MB, // GBP photo guideline: 10 KB – 5 MB
    maxVideoBytes: 0,
    acceptedImageTypes: ["image/jpeg", "image/png"],
    acceptedVideoTypes: [],
  },
};
