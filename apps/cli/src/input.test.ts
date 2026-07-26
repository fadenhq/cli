import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { isIndirect, resolveInput } from "./input.js";

describe("resolveInput", () => {
  it("passes a literal through untouched", async () => {
    expect(await resolveInput("just text")).toBe("just text");
    expect(await resolveInput("me@example.com")).toBe("me@example.com");
  });

  it("reads @path", async () => {
    const dir = await mkdtemp(join(tmpdir(), "faden-input-"));
    const file = join(dir, "post.txt");
    await writeFile(file, "line one\nline two\n");
    expect(await resolveInput(`@${file}`)).toBe("line one\nline two\n");
  });

  it("explains a missing file rather than surfacing a raw ENOENT", async () => {
    await expect(resolveInput("@/definitely/not/here.txt")).rejects.toThrow(/cannot read/);
  });
});

describe("isIndirect", () => {
  it("recognises the stdin and file conventions", () => {
    expect(isIndirect("-")).toBe(true);
    expect(isIndirect("@notes.txt")).toBe(true);
    expect(isIndirect("plain")).toBe(false);
    expect(isIndirect(undefined)).toBe(false);
  });
});
