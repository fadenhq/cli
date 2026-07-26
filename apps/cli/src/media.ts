import { readFile } from "node:fs/promises";
import { basename } from "node:path";
import type { ApiClient } from "./client.js";
import { CliError, EXIT } from "./exit.js";

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

/** Best-effort MIME from the file extension; callers can override with an explicit type. */
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

export interface UploadedMedia {
  mediaId: string;
  publicUrl: string;
  mimeType: string;
  fileName: string;
}

/**
 * Upload a local file as post media: reserve the asset, push the bytes, return the public URL to
 * pass to `mediaUrls`. Shared by `faden media upload` and the `upload_media` MCP tool so the two
 * surfaces cannot drift.
 */
export async function uploadMedia(api: ApiClient, filePath: string, mimeTypeOverride?: string): Promise<UploadedMedia> {
  let bytes: Buffer;
  try {
    bytes = await readFile(filePath);
  } catch (err) {
    throw new CliError(`cannot read ${filePath}: ${(err as Error).message}`, EXIT.validation);
  }
  const mimeType = mimeTypeOverride ?? guessMime(filePath);
  const reserved = await api.post<{ mediaId: string; publicUrl: string }>("/v1/media", {
    mimeType,
    sizeBytes: bytes.byteLength,
  });
  // Node types a Buffer as Uint8Array<ArrayBufferLike>, but BodyInit only admits ArrayBuffer-backed
  // views. The difference is SharedArrayBuffer, which readFile never returns — so re-view, no copy.
  const body = new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength) as Uint8Array<ArrayBuffer>;
  await api.putRaw(`/v1/media/${reserved.mediaId}/content`, body, { contentType: mimeType });
  return { mediaId: reserved.mediaId, publicUrl: reserved.publicUrl, mimeType, fileName: basename(filePath) };
}
