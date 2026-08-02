/**
 * MIME guessing from a filename or URL. Lives in shared because every surface that pre-flights a
 * post needs it: the CLI (`--dry-run` over `mediaUrls`), the dashboard composer, and anything else
 * that has to say "this .mov won't fit on X" before the API is asked.
 */

const MIME_BY_EXTENSION: Record<string, string> = {
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  png: "image/png",
  webp: "image/webp",
  gif: "image/gif",
  mp4: "video/mp4",
  mov: "video/quicktime",
  webm: "video/webm",
};

/** Best-effort MIME from a file extension; callers can override with an explicit type. */
export function guessMime(filePath: string): string {
  const ext = filePath.split(".").pop()?.toLowerCase();
  return MIME_BY_EXTENSION[ext ?? ""] ?? "application/octet-stream";
}

/** MIME for a media *URL*, or null when the extension gives no answer (query strings, CDN paths). */
export function guessMimeFromUrl(url: string): string | null {
  const path = url.split(/[?#]/)[0] ?? url;
  const ext = path.split(".").pop()?.toLowerCase();
  return MIME_BY_EXTENSION[ext ?? ""] ?? null;
}
