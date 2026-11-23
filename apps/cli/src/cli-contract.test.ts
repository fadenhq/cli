/**
 * The promises the CLI makes to agents (#170), tested against the built bundle that ships to npm
 * and a local fake API. Not one test per command: these pin the cross-cutting contract every
 * command relies on (exit codes, clean stdout, hints on stderr, --dry-run, input indirection).
 */
import { execFileSync, spawn } from "node:child_process";
import { mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

const CLI_DIR = dirname(dirname(fileURLToPath(import.meta.url)));
const BIN = join(CLI_DIR, "dist", "index.js");

interface Recorded {
  method: string;
  path: string;
  headers: IncomingMessage["headers"];
  body: string;
}

type Reply = { status: number; body?: unknown };

let server: Server;
let apiUrl: string;
let requests: Recorded[] = [];
/** `"METHOD /path"` → reply; anything unscripted is a 404 so a stray call is visible. */
let routes: Record<string, Reply> = {};

beforeAll(async () => {
  // Test the artifact users install, not the sources.
  execFileSync("npm", ["run", "build"], { cwd: CLI_DIR, stdio: "ignore" });

  server = createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      const path = (req.url ?? "/").split("?")[0]!;
      requests.push({ method: req.method!, path, headers: req.headers, body });
      const reply = routes[`${req.method} ${path}`] ?? { status: 404, body: { error: "not_found" } };
      res.writeHead(reply.status, { "content-type": "application/json" });
      res.end(reply.body === undefined ? "" : JSON.stringify(reply.body));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  apiUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}, 60_000);

afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

beforeEach(() => {
  requests = [];
  routes = {};
});

interface Run {
  code: number;
  stdout: string;
  stderr: string;
}

/** Run the CLI non-interactively (stdout is a pipe), with an isolated config dir. */
function run(args: string[], opts: { env?: Record<string, string | undefined>; stdin?: string } = {}): Promise<Run> {
  const env: Record<string, string> = {
    PATH: process.env.PATH ?? "",
    XDG_CONFIG_HOME: mkdtempSync(join(tmpdir(), "faden-cli-")),
    FADEN_API_KEY: "fdn_live_test",
    FADEN_API_URL: apiUrl,
  };
  for (const [k, v] of Object.entries(opts.env ?? {})) {
    if (v === undefined) delete env[k];
    else env[k] = v;
  }
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [BIN, ...args], { env, stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    child.on("error", reject);
    child.on("close", (code) => resolve({ code: code ?? -1, stdout, stderr }));
    child.stdin.end(opts.stdin ?? "");
  });
}

const created = { status: 201, body: { postId: "pst_1", status: "publishing", targets: [] } };

// Exit codes are written as literals on purpose: agents branch on the numbers documented in
// `faden --help`, so the test must not share the constants it is checking.
describe("exit codes", () => {
  it.each([
    [401, 2],
    [403, 2],
    [400, 3],
    [422, 3],
    [404, 4],
    [402, 5],
    [429, 5],
    [500, 1],
  ])("HTTP %i exits with %i and explains on stderr", async (status, exit) => {
    routes["GET /v1/posts"] = { status, body: { error: "some_error", detail: "what went wrong" } };

    const res = await run(["posts", "list"]);

    expect(res.code).toBe(exit);
    expect(res.stdout).toBe("");
    expect(res.stderr).toMatch(/^Error: /);
  });

  it("exits 0 on success", async () => {
    routes["GET /v1/posts"] = { status: 200, body: { posts: [], nextCursor: null } };
    expect((await run(["posts", "list"])).code).toBe(0);
  });

  it("exits 1 when the API can't be reached", async () => {
    const res = await run(["posts", "list"], { env: { FADEN_API_URL: "http://127.0.0.1:1" } });
    expect(res.code).toBe(1);
  });

  it("exits 2 without credentials, before any request", async () => {
    const res = await run(["posts", "list"], { env: { FADEN_API_KEY: undefined } });
    expect(res.code).toBe(2);
    expect(res.stderr).toContain("faden login");
    expect(requests).toEqual([]);
  });

  it("exits 3 for an unknown platform, before any request", async () => {
    const res = await run(["posts", "create", "-p", "x,myspace", "-c", "hi"]);
    expect(res.code).toBe(3);
    expect(res.stderr).toContain("myspace");
    expect(requests).toEqual([]);
  });

  it("refuses browser login without a terminal instead of hanging", async () => {
    const res = await run(["login"], { env: { FADEN_API_KEY: undefined } });
    expect(res.code).toBe(2);
    expect(res.stderr).toContain("--key");
  });
});

describe("output", () => {
  it("writes a single parseable JSON document to stdout when piped", async () => {
    routes["POST /v1/posts"] = created;

    const res = await run(["posts", "create", "-p", "x", "-c", "hi"]);

    expect(res.code).toBe(0);
    expect(JSON.parse(res.stdout)).toEqual(created.body);
  });

  it("sends next-command hints to stderr only", async () => {
    routes["POST /v1/posts"] = created;
    const res = await run(["posts", "create", "-p", "x", "-c", "hi"]);
    expect(res.stderr).toContain("next: faden posts get pst_1");
    expect(res.stdout).not.toContain("next:");
  });

  it.each([
    ["--no-hints", ["--no-hints"], {}],
    ["FADEN_NO_HINTS", [], { FADEN_NO_HINTS: "1" }],
  ])("%s silences hints", async (_label, flags, env) => {
    routes["POST /v1/posts"] = created;
    const res = await run([...flags, "posts", "create", "-p", "x", "-c", "hi"], { env });
    expect(res.stderr).toBe("");
  });

  it("rejects an unknown --output format with exit 3", async () => {
    const res = await run(["--output", "yaml", "platforms", "list"]);
    expect(res.code).toBe(3);
  });

  it("renders text when asked, even when piped", async () => {
    const res = await run(["--output", "text", "platforms", "list"]);
    expect(res.code).toBe(0);
    expect(() => JSON.parse(res.stdout)).toThrow();
  });
});

describe("requests", () => {
  it("authenticates with the key as a bearer token", async () => {
    routes["GET /v1/posts"] = { status: 200, body: { posts: [] } };
    await run(["posts", "list"]);
    expect(requests[0]!.headers.authorization).toBe("Bearer fdn_live_test");
  });

  it("forwards --idempotency-key as the Idempotency-Key header", async () => {
    routes["POST /v1/posts"] = created;
    await run(["posts", "create", "-p", "x", "-c", "hi", "--idempotency-key", "ship-42"]);
    expect(requests[0]!.headers["idempotency-key"]).toBe("ship-42");
  });

  it("reads content from stdin with -c -", async () => {
    routes["POST /v1/posts"] = created;
    const text = 'Line one\nLine "two" with $HOME and `ticks`\n';
    await run(["posts", "create", "-p", "x", "-c", "-"], { stdin: text });
    // Passed through byte for byte: no shell escaping, no trimming.
    expect(JSON.parse(requests[0]!.body).content).toBe(text);
  });

  it("reads content from a file with -c @file", async () => {
    routes["POST /v1/posts"] = created;
    const file = join(mkdtempSync(join(tmpdir(), "faden-cli-")), "post.txt");
    writeFileSync(file, "From a file");
    await run(["posts", "create", "-p", "x", "-c", `@${file}`]);
    expect(JSON.parse(requests[0]!.body).content).toBe("From a file");
  });
});

describe("--dry-run never changes anything", () => {
  /** GETs answer with enough shape for every dry-run to complete; any other method is a failure. */
  function scriptReads() {
    routes["GET /v1/posts/pst_1"] = { status: 200, body: { id: "pst_1", status: "draft", targets: [] } };
    routes["GET /v1/posts/pst_2"] = {
      status: 200,
      body: { id: "pst_2", status: "failed", targets: [{ accountId: "acc_1", platform: "x", status: "failed" }] },
    };
    routes["GET /v1/keys"] = { status: 200, body: { keys: [{ id: "key_1" }] } };
    routes["GET /v1/webhooks"] = { status: 200, body: { webhooks: [{ id: "wh_1" }] } };
    routes["GET /v1/media"] = { status: 200, body: { media: [{ id: "med_1", posts: [] }], nextCursor: null } };
    routes["GET /v1/queue"] = { status: 200, body: { timezone: "UTC", slots: [] } };
    routes["GET /v1/accounts"] = { status: 200, body: { accounts: [{ id: "acc_1", handle: "main-brand", platform: "x", status: "active" }] } };
  }

  const csv = join(mkdtempSync(join(tmpdir(), "faden-cli-")), "posts.csv");
  writeFileSync(csv, "content,platforms\nhello,x\n");

  it.each([
    ["posts create", ["posts", "create", "-p", "x", "-c", "hi", "--dry-run"]],
    ["posts approve", ["posts", "approve", "pst_1", "--dry-run"]],
    ["posts cancel", ["posts", "cancel", "pst_1", "--dry-run"]],
    ["posts retry", ["posts", "retry", "pst_2", "--dry-run"]],
    ["keys revoke", ["keys", "revoke", "key_1", "--dry-run"]],
    ["webhooks rm", ["webhooks", "rm", "wh_1", "--dry-run"]],
    ["media rm", ["media", "rm", "med_1", "--dry-run"]],
    ["accounts disconnect", ["accounts", "disconnect", "main-brand", "--dry-run"]],
    ["queue set", ["queue", "set", "-z", "UTC", "-s", "mon@09:00", "--dry-run"]],
    ["bulk import", ["bulk", "import", csv, "--dry-run"]],
  ])("%s", async (_label, args) => {
    scriptReads();

    const res = await run(args);

    expect(res.code, res.stderr).toBe(0);
    expect(requests.filter((r) => r.method !== "GET")).toEqual([]);
    expect(JSON.parse(res.stdout).dryRun).toBe(true);
  });

  it("posts create --dry-run works offline and exits 3 when the post would be rejected", async () => {
    const res = await run(["posts", "create", "-p", "x", "-c", "x".repeat(281), "--dry-run"], {
      env: { FADEN_API_KEY: undefined, FADEN_API_URL: "http://127.0.0.1:1" },
    });
    expect(res.code).toBe(3);
    expect(JSON.parse(res.stdout)).toMatchObject({ dryRun: true, ok: false });
  });
});

describe("login --key", () => {
  it("stores the key in a config file only the user can read, and later commands use it", async () => {
    const home = mkdtempSync(join(tmpdir(), "faden-cli-"));
    const env = { XDG_CONFIG_HOME: home, FADEN_API_KEY: undefined, FADEN_API_URL: undefined };

    const login = await run(["login", "--key", "fdn_live_saved", "--url", `${apiUrl}/`], { env });

    expect(login.code).toBe(0);
    const path = join(home, "faden", "config.json");
    expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({ apiUrl, apiKey: "fdn_live_saved" });
    expect(statSync(path).mode & 0o777).toBe(0o600);

    routes["GET /v1/posts"] = { status: 200, body: { posts: [] } };
    expect((await run(["posts", "list"], { env })).code).toBe(0);
    expect(requests[0]!.headers.authorization).toBe("Bearer fdn_live_saved");
  });

  it("lets FADEN_API_KEY win over the config file", async () => {
    const home = mkdtempSync(join(tmpdir(), "faden-cli-"));
    await run(["login", "--key", "fdn_live_saved", "--url", apiUrl], { env: { XDG_CONFIG_HOME: home, FADEN_API_KEY: undefined } });
    routes["GET /v1/posts"] = { status: 200, body: { posts: [] } };

    await run(["posts", "list"], { env: { XDG_CONFIG_HOME: home, FADEN_API_KEY: "fdn_live_env" } });

    expect(requests[0]!.headers.authorization).toBe("Bearer fdn_live_env");
  });
});

describe("accounts disconnect (#159)", () => {
  const listed = { status: 200, body: { accounts: [{ id: "acc_1", handle: "main-brand", platform: "x", status: "active" }] } };

  it("resolves a handle to the account and disconnects it", async () => {
    routes["GET /v1/accounts"] = listed;
    routes["DELETE /v1/accounts/acc_1"] = { status: 200, body: { id: "acc_1", status: "disconnected", revoked: true, failedTargets: 0 } };

    const res = await run(["accounts", "disconnect", "main-brand"]);

    expect(res.code, res.stderr).toBe(0);
    expect(requests.map((r) => `${r.method} ${r.path}`)).toEqual(["GET /v1/accounts", "DELETE /v1/accounts/acc_1"]);
    expect(JSON.parse(res.stdout)).toMatchObject({ status: "disconnected" });
  });

  it("exits 4 for an unknown account, without deleting anything", async () => {
    routes["GET /v1/accounts"] = listed;

    const res = await run(["accounts", "disconnect", "nope"]);

    expect(res.code).toBe(4);
    expect(requests.filter((r) => r.method !== "GET")).toEqual([]);
  });
});
