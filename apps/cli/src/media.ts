import { type FileHandle, open } from "node:fs/promises";
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
 * surfaces cannot drift. Files too large for one request (the API says `multipart`) go up in
 * parts, read one at a time so the whole file is never in memory (#160).
 */
export async function uploadMedia(api: ApiClient, filePath: string, mimeTypeOverride?: string): Promise<UploadedMedia> {
  let file: FileHandle;
  let sizeBytes: number;
  try {
    file = await open(filePath, "r");
    sizeBytes = (await file.stat()).size;
  } catch (err) {
    throw new CliError(`cannot read ${filePath}: ${(err as Error).message}`, EXIT.validation);
  }
  try {
    const mimeType = mimeTypeOverride ?? guessMime(filePath);
    const reserved = await api.post<{ mediaId: string; publicUrl: string; multipart?: boolean }>("/v1/media", {
      mimeType,
      sizeBytes,
    });
    if (reserved.multipart) {
      await uploadInParts(api, file, reserved.mediaId, sizeBytes, mimeType);
    } else {
      await api.putRaw(`/v1/media/${reserved.mediaId}/content`, await readRange(file, 0, sizeBytes), { contentType: mimeType });
    }
    return { mediaId: reserved.mediaId, publicUrl: reserved.publicUrl, mimeType, fileName: basename(filePath) };
  } finally {
    await file.close();
  }
}

async function uploadInParts(api: ApiClient, file: FileHandle, mediaId: string, sizeBytes: number, mimeType: string): Promise<void> {
  const plan = await api.post<{ partSizeBytes: number; partCount: number }>(`/v1/media/${mediaId}/multipart`);
  const parts: Array<{ partNumber: number; etag: string }> = [];
  for (let partNumber = 1; partNumber <= plan.partCount; partNumber++) {
    const offset = (partNumber - 1) * plan.partSizeBytes;
    const length = Math.min(plan.partSizeBytes, sizeBytes - offset);
    parts.push(
      await api.putRaw<{ partNumber: number; etag: string }>(
        `/v1/media/${mediaId}/parts/${partNumber}`,
        await readRange(file, offset, length),
        { contentType: mimeType },
      ),
    );
  }
  await api.post(`/v1/media/${mediaId}/multipart/complete`, { parts });
}

async function readRange(file: FileHandle, offset: number, length: number): Promise<Uint8Array<ArrayBuffer>> {
  const buffer = new Uint8Array(new ArrayBuffer(length));
  let read = 0;
  while (read < length) {
    const { bytesRead } = await file.read(buffer, read, length - read, offset + read);
    if (bytesRead === 0) throw new CliError("file changed size while uploading", EXIT.validation);
    read += bytesRead;
  }
  return buffer;
}
