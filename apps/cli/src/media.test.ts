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

  it("uploads a file the API flags as multipart in parts, then completes with every etag (#160)", async () => {
    const dir = await mkdtemp(join(tmpdir(), "faden-media-"));
    const file = join(dir, "big.mp4");
    const bytes = Buffer.from(Array.from({ length: 10 }, (_, i) => i));
    await writeFile(file, bytes);

    const post = vi.fn(async (path: string) => {
      if (path === "/v1/media") return { mediaId: "m", publicUrl: "u", multipart: true };
      if (path === "/v1/media/m/multipart") return { partSizeBytes: 4, partCount: 3 };
      return { mediaId: "m", publicUrl: "u", sizeBytes: 10 };
    });
    const sent: Array<[string, number[]]> = [];
    const putRaw = vi.fn(async (path: string, body: Uint8Array) => {
      sent.push([path, [...body]]);
      return { partNumber: sent.length, etag: `e${sent.length}` };
    });
    await uploadMedia({ post, putRaw } as unknown as ApiClient, file);

    expect(sent).toEqual([
      ["/v1/media/m/parts/1", [0, 1, 2, 3]],
      ["/v1/media/m/parts/2", [4, 5, 6, 7]],
      ["/v1/media/m/parts/3", [8, 9]],
    ]);
    expect(post).toHaveBeenLastCalledWith("/v1/media/m/multipart/complete", {
      parts: [
        { partNumber: 1, etag: "e1" },
        { partNumber: 2, etag: "e2" },
        { partNumber: 3, etag: "e3" },
      ],
    });
  });

  it("reports an unreadable file as a validation error, not a crash", async () => {
    const api = { post: vi.fn(), putRaw: vi.fn() } as unknown as ApiClient;
    await expect(uploadMedia(api, "/definitely/not/here.png")).rejects.toThrow(/cannot read/);
  });
});
