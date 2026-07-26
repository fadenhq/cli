import { readFile } from "node:fs/promises";
import { CliError, EXIT } from "./exit.js";

/** Read all of stdin. Agents pipe content in rather than shell-escaping multi-line text. */
export async function readStdin(): Promise<string> {
  if (process.stdin.isTTY) {
    throw new CliError(
      "`-` reads from stdin, but stdin is a terminal — pipe something in:\n" +
        "  faden posts create -p x -c - < announcement.txt",
      EXIT.validation,
    );
  }
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}

/**
 * Resolve a value that may be inline, `-` (stdin) or `@path` (a file). One convention across
 * `--content`, `--config` and `bulk import` means an agent learns it once.
 */
export async function resolveInput(value: string): Promise<string> {
  if (value === "-") return readStdin();
  if (value.startsWith("@")) {
    const path = value.slice(1);
    try {
      return await readFile(path, "utf8");
    } catch (err) {
      throw new CliError(`cannot read ${path}: ${(err as Error).message}`, EXIT.validation);
    }
  }
  return value;
}

/** True when the value needs an async read — lets callers skip the await on the common path. */
export function isIndirect(value: string | undefined): boolean {
  return value === "-" || (value?.startsWith("@") ?? false);
}
