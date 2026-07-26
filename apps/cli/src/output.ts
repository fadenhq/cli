import { CliError, EXIT } from "./exit.js";

export type OutputFormat = "json" | "text";

let format: OutputFormat = "json";
let hintsEnabled = true;

/**
 * Resolve the output format once, at startup. Text is only ever the default for a human at a
 * terminal; anything piped or redirected gets JSON, so `faden … | jq` works without a flag.
 */
export function configureOutput(opts: { output?: string; noHints?: boolean }): void {
  if (opts.output !== undefined) {
    if (opts.output !== "json" && opts.output !== "text") {
      throw new CliError(`--output must be json or text, got: ${opts.output}`, EXIT.validation);
    }
    format = opts.output;
  } else {
    format = process.stdout.isTTY ? "text" : "json";
  }
  hintsEnabled = !opts.noHints && !process.env.FADEN_NO_HINTS;
}

export function outputFormat(): OutputFormat {
  return format;
}

/**
 * Print a result. `text` renders the human view when one is supplied and the format asks for it;
 * everything else falls back to JSON, so no command can leave an agent with unparseable output.
 */
export function emit(data: unknown, text?: (data: never) => string): void {
  if (format === "text" && text) {
    console.log(text(data as never));
    return;
  }
  console.log(JSON.stringify(data, null, 2));
}

/**
 * Suggested follow-up commands. Written to **stderr** on purpose: stdout stays a clean JSON
 * document that can be piped, while the nudge still reaches an agent reading combined output.
 */
export function hint(...commands: string[]): void {
  if (!hintsEnabled || commands.length === 0) return;
  console.error(`next: ${commands.join("\n      ")}`);
}
