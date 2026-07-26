import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { ApiClient } from "./client.js";
import { guessMime, guessMimeFromUrl, uploadMedia } from "./media.js";

describe("mime guessing", () => {
  it("maps known extensions and falls back for unknown ones", () => {
    expect(guessMime("/a/b/shot.PNG")).toBe("image/png");
    expect(guessMime("clip.mov")).toBe("video/quicktime");
    expect(guessMime("notes.txt")).toBe("application/octet-stream");
  });

  it("returns null for a URL whose type cannot be read, rather than guessing", () => {
    expect(guessMimeFromUrl("https://cdn.example/a.jpg?w=100")).toBe("image/jpeg");
    expect(guessMimeFromUrl("https://cdn.example/asset/12345")).toBeNull();
  });
});

describe("uploadMedia", () => {
  it("reserves the asset then uploads the bytes with the right content type", async () => {
    const dir = await mkdtemp(join(tmpdir(), "faden-media-"));
    const file = join(dir, "shot.png");
    await writeFile(file, Buffer.from([1, 2, 3, 4]));

    const post = vi.fn().mockResolvedValue({ mediaId: "med_1", publicUrl: "https://media.faden.io/med_1" });
    const putRaw = vi.fn().mockResolvedValue({});
    const api = { post, putRaw } as unknown as ApiClient;

    const result = await uploadMedia(api, file);

    expect(post).toHaveBeenCalledWith("/v1/media", { mimeType: "image/png", sizeBytes: 4 });
    expect(putRaw).toHaveBeenCalledWith("/v1/media/med_1/content", expect.any(Uint8Array), {
      contentType: "image/png",
    });
    expect(result).toMatchObject({ mediaId: "med_1", publicUrl: "https://media.faden.io/med_1", fileName: "shot.png" });
  });

  it("honours an explicit mime type over the extension", async () => {
    const dir = await mkdtemp(join(tmpdir(), "faden-media-"));
    const file = join(dir, "clip.bin");
    await writeFile(file, Buffer.from([0]));
    const api = {
      post: vi.fn().mockResolvedValue({ mediaId: "m", publicUrl: "u" }),
      putRaw: vi.fn().mockResolvedValue({}),
    } as unknown as ApiClient;

    const result = await uploadMedia(api, file, "video/mp4");
    expect(result.mimeType).toBe("video/mp4");
  });

  it("reports an unreadable file as a validation error, not a crash", async () => {
    const api = { post: vi.fn(), putRaw: vi.fn() } as unknown as ApiClient;
    await expect(uploadMedia(api, "/definitely/not/here.png")).rejects.toThrow(/cannot read/);
  });
});
