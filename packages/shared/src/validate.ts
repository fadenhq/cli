import type { PublishOptions } from "./overrides.js";
import { PLATFORM_CONSTRAINTS, type Platform } from "./platforms.js";
import type { MediaRef } from "./types.js";

export interface ValidationIssue {
  platform: Platform;
  code:
    | "content_too_long"
    | "too_many_media"
    | "media_required"
    | "media_unsupported"
    | "media_too_large"
    | "media_too_long"
    | "board_required"
    | "location_required";
  detail: string;
}

/**
 * Pre-flight validation of a unified post against one platform's constraints. Returns the list of
 * issues (empty = valid). Used both for single posts and to fail-fast a bulk batch before queueing.
 */
export function validateForPlatform(
  platform: Platform,
  content: string,
  media: MediaRef[],
  /** Merged platform options, for platforms whose publish needs a sub-resource (Pinterest board). */
  options?: PublishOptions,
): ValidationIssue[] {
  const c = PLATFORM_CONSTRAINTS[platform];
  const issues: ValidationIssue[] = [];

  if (platform === "pinterest" && !options?.boardId) {
    issues.push({
      platform,
      code: "board_required",
      detail: "pinterest pins need a destination board: set platformConfigurations.pinterest.boardId (list boards via GET /v1/accounts/{accountId}/boards)",
    });
  }

  if (platform === "google_business" && !options?.locationId) {
    issues.push({
      platform,
      code: "location_required",
      detail:
        "google business posts need a destination location: set platformConfigurations.google_business.locationId (list locations via GET /v1/accounts/{accountId}/boards)",
    });
  }

  if (content.length > c.maxContentLength) {
    issues.push({
      platform,
      code: "content_too_long",
      detail: `content is ${content.length} chars; ${platform} allows ${c.maxContentLength}`,
    });
  }

  if (media.length > c.maxMediaCount) {
    issues.push({
      platform,
      code: "too_many_media",
      detail: `${media.length} attachments; ${platform} allows ${c.maxMediaCount}`,
    });
  }

  if (c.requiresMedia && media.length === 0) {
    issues.push({ platform, code: "media_required", detail: `${platform} requires at least one media attachment` });
  }

  for (const m of media) {
    const isImage = m.mimeType.startsWith("image/");
    const isVideo = m.mimeType.startsWith("video/");

    if (isImage && (!c.allowsImages || !c.acceptedImageTypes.includes(m.mimeType))) {
      issues.push({ platform, code: "media_unsupported", detail: `${platform} does not accept image type ${m.mimeType}` });
      continue;
    }
    if (isVideo && (!c.allowsVideo || !c.acceptedVideoTypes.includes(m.mimeType))) {
      issues.push({ platform, code: "media_unsupported", detail: `${platform} does not accept video type ${m.mimeType}` });
      continue;
    }
    if (!isImage && !isVideo) {
      issues.push({ platform, code: "media_unsupported", detail: `unsupported media type ${m.mimeType}` });
      continue;
    }

    const limit = isImage ? c.maxImageBytes : c.maxVideoBytes;
    if (m.sizeBytes > limit) {
      issues.push({
        platform,
        code: "media_too_large",
        detail: `${m.url} is ${m.sizeBytes} bytes; ${platform} limit is ${limit}`,
      });
    }

    // Duration is enforced only when declared (pass-through media is never probed).
    if (
      isVideo &&
      c.maxVideoDurationSeconds !== undefined &&
      m.durationSeconds !== undefined &&
      m.durationSeconds > c.maxVideoDurationSeconds
    ) {
      issues.push({
        platform,
        code: "media_too_long",
        detail: `${m.url} is ${m.durationSeconds}s; ${platform} allows ${c.maxVideoDurationSeconds}s`,
      });
    }
  }

  return issues;
}
