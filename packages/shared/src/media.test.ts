import { describe, expect, it } from "vitest";
import { guessMime, guessMimeFromUrl } from "./media.js";

describe("guessMime", () => {
  it.each([
    ["photo.JPG", "image/jpeg"],
    ["clip.mov", "video/quicktime"],
    ["/tmp/a.b.webm", "video/webm"],
    ["notes.txt", "application/octet-stream"],
    ["no-extension", "application/octet-stream"],
  ])("%s → %s", (path, mime) => {
    expect(guessMime(path)).toBe(mime);
  });
});

describe("guessMimeFromUrl", () => {
  it("ignores query strings and fragments", () => {
    expect(guessMimeFromUrl("https://cdn.test/a.png?w=200#x")).toBe("image/png");
  });

  it("returns null instead of guessing when the URL has no known extension", () => {
    expect(guessMimeFromUrl("https://cdn.test/assets/12345")).toBeNull();
    expect(guessMimeFromUrl("https://cdn.test/file.php?id=a.jpg")).toBeNull();
  });
});
