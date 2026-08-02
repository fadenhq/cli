/**
 * Exit codes, so an agent can branch on the failure class without parsing stderr: re-auth on 2,
 * rewrite content on 3, stop retrying on 4, back off on 5.
 */
export const EXIT = {
  ok: 0,
  generic: 1,
  auth: 2,
  validation: 3,
  notFound: 4,
  rateLimited: 5,
} as const;

/** Rendered under `faden --help` so the table is discoverable without reading docs. */
export const EXIT_CODE_HELP = `Exit codes:
  0  success
  1  unexpected failure (network, server error, unknown)
  2  authentication: key missing, invalid or lacking access
  3  validation: bad flags, or the API rejected the request body
  4  not found: the post, account or key does not exist
  5  rate limited or over quota: retry later or upgrade`;

/** An error whose message is already agent-actionable; carries the exit code to report. */
export class CliError extends Error {
  constructor(
    message: string,
    readonly exitCode: number = EXIT.generic,
  ) {
    super(message);
    this.name = "CliError";
  }
}

/** Map an HTTP status onto the exit-code table above. */
export function exitCodeForStatus(status: number): number {
  if (status === 401 || status === 403) return EXIT.auth;
  if (status === 400 || status === 422) return EXIT.validation;
  if (status === 404) return EXIT.notFound;
  if (status === 402 || status === 429) return EXIT.rateLimited;
  return EXIT.generic;
}
