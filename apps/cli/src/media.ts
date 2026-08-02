import { readFile } from "node:fs/promises";
import { basename } from "node:path";
import { guessMime } from "@fadenhq/shared";
import type { ApiClient } from "./client.js";
import { CliError, EXIT } from "./exit.js";

// The extension→MIME table lives in @fadenhq/shared so the CLI's `--dry-run` and the dashboard
// composer reach the same verdict about a given URL.
export { guessMime, guessMimeFromUrl } from "@fadenhq/shared";

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
