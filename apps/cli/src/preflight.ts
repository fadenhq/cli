import { PLATFORM_CONSTRAINTS, validateForPlatform, type MediaRef, type Platform, type PublishOptions, type ValidationIssue } from "@fadenhq/shared";
import { guessMimeFromUrl } from "./media.js";

export interface PreflightResult {
  ok: boolean;
  issues: ValidationIssue[];
  /** Media URLs whose type could not be read from the extension, so type limits went unchecked. */
  mediaNotCheckedLocally: string[];
  perPlatform: Array<{ platform: Platform; contentLength: number; maxContentLength: number; ok: boolean }>;
}

/**
 * Run the same per-platform pre-flight the API runs, entirely offline: `PLATFORM_CONSTRAINTS` ships
 * inside the CLI bundle, so `--dry-run` and `faden validate` cost zero API calls and work logged out.
 *
 * The one thing local checking cannot see is a remote file's real type and size. Extension-derived
 * types are checked; anything unguessable is reported rather than guessed at, so a dry run never
 * invents a failure the API would not raise.
 */
export function preflight(
  platforms: Platform[],
  content: string,
  mediaUrls: string[],
  optionsByPlatform: Partial<Record<Platform, PublishOptions>> = {},
): PreflightResult {
  const notChecked: string[] = [];
  const media: MediaRef[] = mediaUrls.map((url) => {
    const mimeType = guessMimeFromUrl(url);
    if (mimeType === null) notChecked.push(url);
    // A known-accepted placeholder keeps the *count* checks honest without asserting a type we
    // cannot know; sizeBytes 0 leaves byte limits to the API, which sees the real asset.
    return { url, mimeType: mimeType ?? "image/jpeg", sizeBytes: 0 };
  });

  const issues: ValidationIssue[] = [];
  const perPlatform = platforms.map((platform) => {
    const found = validateForPlatform(platform, content, media, optionsByPlatform[platform]);
    issues.push(...found);
    return {
      platform,
      contentLength: content.length,
      maxContentLength: PLATFORM_CONSTRAINTS[platform].maxContentLength,
      ok: found.length === 0,
    };
  });

  return { ok: issues.length === 0, issues, mediaNotCheckedLocally: notChecked, perPlatform };
}

/** Human-readable rendering for `--output text`. */
export function formatPreflight(result: PreflightResult): string {
  const lines = result.perPlatform.map((p) => {
    const status = p.ok ? "ok" : "FAIL";
    return `${p.platform.padEnd(16)} ${status.padEnd(5)} ${p.contentLength}/${p.maxContentLength} chars`;
  });
  for (const issue of result.issues) lines.push(`  ${issue.platform}: ${issue.code} — ${issue.detail}`);
  if (result.mediaNotCheckedLocally.length > 0) {
    lines.push(`  note: type not checked locally (no extension): ${result.mediaNotCheckedLocally.join(", ")}`);
  }
  return lines.join("\n");
}
