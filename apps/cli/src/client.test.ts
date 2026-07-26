import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiClient, ApiError, resolveTimeoutMs } from "./client.js";
import { CliError, EXIT } from "./exit.js";

const config = { apiUrl: "https://api.test", apiKey: "fdn_live_x" };

type FetchArgs = [url: string, init: RequestInit];

function mockFetch(impl: (...args: FetchArgs) => Promise<Response> | Response) {
  const spy = vi.fn<(...args: FetchArgs) => Promise<Response> | Response>(impl);
  vi.stubGlobal("fetch", spy);
  return spy;
}

afterEach(() => {
  vi.unstubAllGlobals();
  delete process.env.FADEN_TIMEOUT_MS;
});

describe("error responses", () => {
  it("keeps the status and body when the API returns JSON", async () => {
    mockFetch(() => new Response(JSON.stringify({ error: "plan_required" }), { status: 402 }));
    const err = await new ApiClient(config).get("/v1/x").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect(err).toMatchObject({ status: 402, body: { error: "plan_required" }, exitCode: EXIT.rateLimited });
  });

  it("reports status and a body excerpt when a proxy returns HTML, instead of a JSON parse error", async () => {
    mockFetch(() => new Response("<!DOCTYPE html><h1>502 Bad Gateway</h1>", { status: 502 }));
    const err = (await new ApiClient(config).get("/v1/accounts").catch((e: unknown) => e)) as ApiError;
    expect(err).toBeInstanceOf(ApiError);
    expect(err.status).toBe(502);
    expect(err.message).toContain("GET /v1/accounts → 502");
    expect(err.message).toContain("502 Bad Gateway");
    expect(err.message).not.toContain("not valid JSON");
  });

  it("truncates a very long non-JSON body", async () => {
    mockFetch(() => new Response("x".repeat(5000), { status: 500 }));
    const err = (await new ApiClient(config).get("/v1/x").catch((e: unknown) => e)) as ApiError;
    expect(err.message.length).toBeLessThan(400);
    expect(err.message).toContain("…");
  });

  it("fails a 200 whose body is not JSON, rather than returning junk", async () => {
    mockFetch(() => new Response("<html>login page</html>", { status: 200 }));
    const err = (await new ApiClient(config).get("/v1/x").catch((e: unknown) => e)) as CliError;
    expect(err).toBeInstanceOf(CliError);
    expect(err.message).toContain("FADEN_API_URL");
  });

  it("maps statuses onto distinct exit codes", async () => {
    for (const [status, code] of [
      [401, EXIT.auth],
      [404, EXIT.notFound],
      [422, EXIT.validation],
      [429, EXIT.rateLimited],
      [500, EXIT.generic],
    ] as const) {
      mockFetch(() => new Response("{}", { status }));
      const err = (await new ApiClient(config).get("/v1/x").catch((e: unknown) => e)) as ApiError;
      expect(err.exitCode, `status ${status}`).toBe(code);
    }
  });
});

describe("network failures", () => {
  it("names the URL and the underlying cause instead of a bare 'fetch failed'", async () => {
    mockFetch(() => {
      throw Object.assign(new TypeError("fetch failed"), { cause: { code: "ECONNREFUSED" } });
    });
    const err = (await new ApiClient(config).get("/v1/accounts").catch((e: unknown) => e)) as CliError;
    expect(err.message).toContain("https://api.test/v1/accounts");
    expect(err.message).toContain("ECONNREFUSED");
    expect(err.message).toContain("FADEN_API_URL");
  });

  it("explains a timeout and points at the flag that raises it", async () => {
    mockFetch(() => {
      throw Object.assign(new Error("aborted"), { name: "TimeoutError" });
    });
    const err = (await new ApiClient(config, 500).get("/v1/x").catch((e: unknown) => e)) as CliError;
    expect(err.message).toContain("timed out after 500ms");
    expect(err.message).toContain("--timeout");
  });

  it("passes an abort signal by default and omits it when disabled", async () => {
    const spy = mockFetch(() => new Response("{}"));
    await new ApiClient(config, 1000).get("/v1/x");
    expect((spy.mock.calls[0]![1] as RequestInit).signal).toBeInstanceOf(AbortSignal);

    await new ApiClient(config, 0).get("/v1/x");
    expect((spy.mock.calls[1]![1] as RequestInit).signal).toBeUndefined();
  });
});

describe("headers", () => {
  it("sends a content type for raw bodies so the API need not guess", async () => {
    const spy = mockFetch(() => new Response("{}"));
    await new ApiClient(config).postRaw("/v1/posts/bulk", "a,b\n1,2", { contentType: "text/csv" });
    expect((spy.mock.calls[0]![1] as { headers: Record<string, string> }).headers["content-type"]).toBe("text/csv");
  });

  it("defaults a raw body to octet-stream rather than sending none", async () => {
    const spy = mockFetch(() => new Response("{}"));
    await new ApiClient(config).putRaw("/v1/media/m1/content", new Uint8Array([1, 2, 3]));
    expect((spy.mock.calls[0]![1] as { headers: Record<string, string> }).headers["content-type"]).toBe(
      "application/octet-stream",
    );
  });

  it("forwards an idempotency key", async () => {
    const spy = mockFetch(() => new Response("{}"));
    await new ApiClient(config).post("/v1/posts", { content: "hi" }, { headers: { "idempotency-key": "ship-42" } });
    const headers = (spy.mock.calls[0]![1] as { headers: Record<string, string> }).headers;
    expect(headers["idempotency-key"]).toBe("ship-42");
    expect(headers["content-type"]).toBe("application/json");
  });
});

describe("resolveTimeoutMs", () => {
  it("prefers the flag, then the env var, then the default", () => {
    process.env.FADEN_TIMEOUT_MS = "1234";
    expect(resolveTimeoutMs(50)).toBe(50);
    expect(resolveTimeoutMs()).toBe(1234);
    delete process.env.FADEN_TIMEOUT_MS;
    expect(resolveTimeoutMs()).toBe(60_000);
  });

  it("rejects a nonsense env value instead of silently disabling the timeout", () => {
    process.env.FADEN_TIMEOUT_MS = "soon";
    expect(() => resolveTimeoutMs()).toThrow(/FADEN_TIMEOUT_MS/);
  });
});
