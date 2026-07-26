import type { CliConfig } from "./config.js";
import { CliError, EXIT, exitCodeForStatus } from "./exit.js";

/** A non-2xx response, carrying the parsed error body so callers can branch on `error_code`
 * (e.g. the analytics command turning a 402 `plan_required` into an upgrade hint). */
export class ApiError extends Error {
  readonly exitCode: number;

  constructor(
    readonly method: string,
    readonly path: string,
    readonly status: number,
    readonly body: Record<string, unknown>,
    /** Set when the response was not JSON (a proxy error page); `body` is then empty. */
    readonly rawBody?: string,
  ) {
    super(`${method} ${path} → ${status}: ${rawBody ?? JSON.stringify(body)}`);
    this.name = "ApiError";
    this.exitCode = exitCodeForStatus(status);
  }
}

/** Longest a single request may hang before we give up on it. */
export const DEFAULT_TIMEOUT_MS = 60_000;

/** Non-JSON bodies (Cloudflare/nginx error pages) get truncated — enough to identify, not to flood. */
const MAX_RAW_BODY = 200;

export interface RequestOptions {
  /** Extra headers, e.g. `Idempotency-Key`. */
  headers?: Record<string, string>;
  /** Content type for a raw (non-JSON) body. */
  contentType?: string;
}

/**
 * Resolve the request timeout: `--timeout` wins, then `FADEN_TIMEOUT_MS`, then the default.
 * `0` disables it, for the rare long-running upload.
 */
export function resolveTimeoutMs(flag?: number): number {
  if (flag !== undefined) return flag;
  const env = process.env.FADEN_TIMEOUT_MS;
  if (env !== undefined && env !== "") {
    const parsed = Number(env);
    if (Number.isFinite(parsed) && parsed >= 0) return parsed;
    throw new CliError(`FADEN_TIMEOUT_MS must be a non-negative number of milliseconds, got: ${env}`, EXIT.validation);
  }
  return DEFAULT_TIMEOUT_MS;
}

/** Thin REST client over the faden API, authenticating with the workspace API key. */
export class ApiClient {
  constructor(
    private readonly config: CliConfig,
    private readonly timeoutMs: number = DEFAULT_TIMEOUT_MS,
  ) {}

  get apiUrl(): string {
    return this.config.apiUrl;
  }

  private async request<T>(
    method: string,
    path: string,
    body?: unknown,
    rawBody?: BodyInit,
    options: RequestOptions = {},
  ): Promise<T> {
    const headers: Record<string, string> = {
      authorization: `Bearer ${this.config.apiKey}`,
      ...options.headers,
    };
    let payload: BodyInit | undefined = rawBody;
    if (body !== undefined) {
      headers["content-type"] = "application/json";
      payload = JSON.stringify(body);
    } else if (rawBody !== undefined) {
      // Without this the API sees no content type and has to guess at CSV vs image bytes.
      headers["content-type"] = options.contentType ?? "application/octet-stream";
    }

    const url = `${this.config.apiUrl}${path}`;
    let res: Response;
    try {
      res = await fetch(url, {
        method,
        headers,
        body: payload,
        // A hung connection with no timeout is the worst failure for an agent: no output to react
        // to, no exit. 0 opts out for deliberately long operations.
        signal: this.timeoutMs > 0 ? AbortSignal.timeout(this.timeoutMs) : undefined,
      });
    } catch (err) {
      throw describeFetchFailure(err, method, url, this.timeoutMs);
    }

    const text = await res.text();
    // A proxy, a wrong FADEN_API_URL, or a gateway error returns HTML. Parsing it unguarded loses
    // the status and the URL — the only two things that identify what actually went wrong.
    let json: unknown = {};
    let rawFallback: string | undefined;
    if (text) {
      try {
        json = JSON.parse(text);
      } catch {
        rawFallback = truncate(text);
      }
    }

    if (!res.ok) {
      throw new ApiError(method, path, res.status, (rawFallback ? {} : json) as Record<string, unknown>, rawFallback);
    }
    if (rawFallback !== undefined) {
      throw new CliError(
        `${method} ${url} → ${res.status} but the body is not JSON: ${rawFallback}\n` +
          `Check FADEN_API_URL — it should point at the API host, not the dashboard.`,
        EXIT.generic,
      );
    }
    return json as T;
  }

  get<T>(path: string): Promise<T> {
    return this.request<T>("GET", path);
  }
  post<T>(path: string, body?: unknown, options?: RequestOptions): Promise<T> {
    return this.request<T>("POST", path, body, undefined, options);
  }
  patch<T>(path: string, body?: unknown): Promise<T> {
    return this.request<T>("PATCH", path, body);
  }
  put<T>(path: string, body?: unknown): Promise<T> {
    return this.request<T>("PUT", path, body);
  }
  postRaw<T>(path: string, rawBody: BodyInit, options?: RequestOptions): Promise<T> {
    return this.request<T>("POST", path, undefined, rawBody, options);
  }
  putRaw<T>(path: string, rawBody: BodyInit, options?: RequestOptions): Promise<T> {
    return this.request<T>("PUT", path, undefined, rawBody, options);
  }
  delete<T>(path: string): Promise<T> {
    return this.request<T>("DELETE", path);
  }
}

function truncate(text: string): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > MAX_RAW_BODY ? `${flat.slice(0, MAX_RAW_BODY)}…` : flat;
}

/**
 * Turn `fetch`'s opaque failures into something a caller can act on. Undici reports the real cause
 * (`ECONNREFUSED`, `ENOTFOUND`, …) only on `err.cause`, so a bare message loses both the reason and
 * the URL that was attempted.
 */
function describeFetchFailure(err: unknown, method: string, url: string, timeoutMs: number): Error {
  if (err instanceof Error && (err.name === "TimeoutError" || err.name === "AbortError")) {
    return new CliError(
      `${method} ${url} timed out after ${timeoutMs}ms — raise it with --timeout <ms> or FADEN_TIMEOUT_MS, or 0 to disable.`,
    );
  }
  const cause = err instanceof Error ? (err.cause as { code?: string; message?: string } | undefined) : undefined;
  const code = cause?.code;
  const detail = code ?? cause?.message ?? (err instanceof Error ? err.message : String(err));
  const hint =
    code === "ECONNREFUSED"
      ? "\nNothing is listening there — check FADEN_API_URL (default https://api.faden.io)."
      : code === "ENOTFOUND"
        ? "\nHostname does not resolve — check FADEN_API_URL for a typo."
        : code === "CERT_HAS_EXPIRED" || code === "UNABLE_TO_VERIFY_LEAF_SIGNATURE"
          ? "\nTLS verification failed — a proxy may be intercepting the connection."
          : "";
  return new CliError(`${method} ${url} failed: ${detail}${hint}`);
}
