import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { createServer, type Server } from "node:http";

/**
 * Browser-based login (loopback flow, à la wrangler/gh):
 *
 * 1. Start a one-shot HTTP server on 127.0.0.1:<random port> with a random `state` nonce.
 * 2. Open `<dashboard>/cli-auth?redirect_uri=http://127.0.0.1:<port>/callback&state=<nonce>`.
 *    The dashboard authenticates the user (Cloudflare Access), lets them pick a workspace and
 *    mints a fresh API key named after this machine.
 * 3. The page delivers the key back as a top-level form POST to the redirect_uri — a POST body
 *    keeps the secret out of query strings and browser history — echoing `state`.
 */

export interface BrowserLoginResult {
  apiKey: string;
  /** Workspace name, when the dashboard includes it (display only). */
  workspace?: string;
}

export interface BrowserLoginOptions {
  /** Injectable for tests; defaults to the OS open command. */
  openUrl?: (url: string) => void;
  timeoutMs?: number;
  /** Injectable for tests; defaults to console.error so stdout stays clean for piping. */
  log?: (message: string) => void;
}

const DEFAULT_TIMEOUT_MS = 5 * 60 * 1000;
const MAX_BODY_BYTES = 16 * 1024;

const RESPONSE_PAGE = (title: string, detail: string) => `<!doctype html>
<meta charset="utf-8"><title>faden CLI</title>
<body style="font-family: system-ui, sans-serif; max-width: 32rem; margin: 4rem auto;">
<h1 style="font-size:1.25rem">${title}</h1><p>${detail}</p></body>`;

function defaultOpenUrl(url: string): void {
  const [cmd, args] =
    process.platform === "darwin"
      ? ["open", [url]]
      : process.platform === "win32"
        ? ["cmd", ["/c", "start", "", url]]
        : ["xdg-open", [url]];
  // Fire and forget — the URL is printed as a fallback, so a missing opener is not fatal.
  spawn(cmd, args, { detached: true, stdio: "ignore" }).on("error", () => {}).unref();
}

function readBody(req: NodeJS.ReadableStream): Promise<string | null> {
  return new Promise((resolve) => {
    let body = "";
    req.on("data", (chunk: Buffer) => {
      body += chunk.toString("utf8");
      if (body.length > MAX_BODY_BYTES) resolve(null);
    });
    req.on("end", () => resolve(body));
    req.on("error", () => resolve(null));
  });
}

function listen(server: Server): Promise<number> {
  return new Promise((resolve, reject) => {
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (address === null || typeof address === "string") return reject(new Error("failed to bind loopback server"));
      resolve(address.port);
    });
  });
}

export async function browserLogin(dashboardUrl: string, options: BrowserLoginOptions = {}): Promise<BrowserLoginResult> {
  const openUrl = options.openUrl ?? defaultOpenUrl;
  const log = options.log ?? ((m) => console.error(m));
  const state = randomBytes(24).toString("base64url");

  let settle: (result: BrowserLoginResult) => void;
  const received = new Promise<BrowserLoginResult>((resolve) => (settle = resolve));

  const server = createServer(async (req, res) => {
    const respond = (status: number, page: string) => {
      res.writeHead(status, { "content-type": "text/html; charset=utf-8" });
      res.end(page);
    };
    if (req.method !== "POST" || new URL(req.url ?? "/", "http://127.0.0.1").pathname !== "/callback") {
      return respond(404, RESPONSE_PAGE("Not found", "This server only accepts the faden login callback."));
    }
    const body = await readBody(req);
    const form = new URLSearchParams(body ?? "");
    const apiKey = form.get("apiKey");
    // A wrong nonce means the POST did not come from the page this CLI opened — reject it but
    // keep listening, so a stray request cannot kill the real login.
    if (body === null || form.get("state") !== state || !apiKey) {
      return respond(400, RESPONSE_PAGE("Login failed", "Invalid callback — return to the terminal and retry <code>faden login</code>."));
    }
    respond(200, RESPONSE_PAGE("Logged in", "The faden CLI is authorized — you can close this tab and return to your terminal."));
    settle({ apiKey, workspace: form.get("workspace") ?? undefined });
  });

  const port = await listen(server);
  const authorizeUrl =
    `${dashboardUrl}/cli-auth?redirect_uri=${encodeURIComponent(`http://127.0.0.1:${port}/callback`)}&state=${state}`;

  log("Opening your browser to log in — if nothing opens, visit:\n");
  log(`  ${authorizeUrl}\n`);
  openUrl(authorizeUrl);

  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  try {
    return await Promise.race([
      received,
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error("browser login timed out — retry, or pass --key <apiKey>")), timeoutMs).unref(),
      ),
    ]);
  } finally {
    server.close();
  }
}
