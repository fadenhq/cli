import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CliError } from "./exit.js";
import { configureOutput, emit, hint, outputFormat } from "./output.js";

/** The output contract agents rely on: JSON unless a human asked otherwise, hints only on stderr. */

let stdout: string[];
let stderr: string[];

beforeEach(() => {
  stdout = [];
  stderr = [];
  vi.spyOn(console, "log").mockImplementation((s: string) => void stdout.push(s));
  vi.spyOn(console, "error").mockImplementation((s: string) => void stderr.push(s));
});

afterEach(() => {
  vi.restoreAllMocks();
  delete process.env.FADEN_NO_HINTS;
});

function withTTY(isTTY: boolean, fn: () => void) {
  const original = process.stdout.isTTY;
  Object.defineProperty(process.stdout, "isTTY", { value: isTTY, configurable: true });
  try {
    fn();
  } finally {
    Object.defineProperty(process.stdout, "isTTY", { value: original, configurable: true });
  }
}

describe("output format", () => {
  it("defaults to JSON when piped and text at a terminal", () => {
    withTTY(false, () => configureOutput({}));
    expect(outputFormat()).toBe("json");
    withTTY(true, () => configureOutput({}));
    expect(outputFormat()).toBe("text");
  });

  it("honors --output, and rejects anything else as a validation error", () => {
    configureOutput({ output: "text" });
    expect(outputFormat()).toBe("text");
    expect(() => configureOutput({ output: "yaml" })).toThrow(CliError);
  });
});

describe("emit", () => {
  it("prints one parseable JSON document in json mode, even when a text view exists", () => {
    configureOutput({ output: "json" });
    emit({ id: "p1" }, () => "human view");
    expect(JSON.parse(stdout.join("\n"))).toEqual({ id: "p1" });
  });

  it("uses the text view in text mode, and falls back to JSON when there is none", () => {
    configureOutput({ output: "text" });
    emit({ id: "p1" }, (d: { id: string }) => `post ${d.id}`);
    emit({ id: "p2" });
    expect(stdout[0]).toBe("post p1");
    expect(JSON.parse(stdout[1]!)).toEqual({ id: "p2" });
  });
});

describe("hint", () => {
  it("writes to stderr only, never stdout", () => {
    configureOutput({ output: "json" });
    hint("faden posts list", "faden accounts list");
    expect(stdout).toEqual([]);
    expect(stderr.join("\n")).toContain("next: faden posts list");
  });

  it("is silenced by --no-hints and FADEN_NO_HINTS", () => {
    configureOutput({ output: "json", noHints: true });
    hint("faden posts list");
    process.env.FADEN_NO_HINTS = "1";
    configureOutput({ output: "json" });
    hint("faden posts list");
    expect(stderr).toEqual([]);
  });
});
