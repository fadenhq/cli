import { describe, expect, it } from "vitest";
import { browserLogin } from "./browser-login.js";

/** Capture the URL the flow would open, exposing its redirect_uri and state for the fake browser. */
function urlCapture() {
  let resolve: (url: URL) => void;
  const opened = new Promise<URL>((r) => (resolve = r));
  return { opened, openUrl: (url: string) => resolve(new URL(url)) };
}

const silent = { log: () => {} };

describe("browserLogin", () => {
  it("opens the dashboard with a loopback redirect_uri and resolves on the form POST", async () => {
    const { opened, openUrl } = urlCapture();
    const login = browserLogin("https://app.faden.io", { ...silent, openUrl });

    const url = await opened;
    expect(url.origin).toBe("https://app.faden.io");
    expect(url.pathname).toBe("/cli-auth");
    const redirectUri = new URL(url.searchParams.get("redirect_uri")!);
    expect(redirectUri.hostname).toBe("127.0.0.1");
    const state = url.searchParams.get("state")!;
    expect(state.length).toBeGreaterThanOrEqual(32);

    const res = await fetch(redirectUri, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ state, apiKey: "fdn_live_abc123", workspace: "acme" }).toString(),
    });
    expect(res.status).toBe(200);
    await expect(login).resolves.toEqual({ apiKey: "fdn_live_abc123", workspace: "acme" });
  });

  it("rejects a POST with the wrong state nonce but keeps waiting for the real one", async () => {
    const { opened, openUrl } = urlCapture();
    const login = browserLogin("https://app.faden.io", { ...silent, openUrl });

    const url = await opened;
    const redirectUri = url.searchParams.get("redirect_uri")!;
    const state = url.searchParams.get("state")!;

    const forged = await fetch(redirectUri, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ state: "wrong", apiKey: "fdn_live_evil" }).toString(),
    });
    expect(forged.status).toBe(400);

    const genuine = await fetch(redirectUri, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ state, apiKey: "fdn_live_real" }).toString(),
    });
    expect(genuine.status).toBe(200);
    await expect(login).resolves.toEqual({ apiKey: "fdn_live_real", workspace: undefined });
  });

  it("times out when the browser never calls back", async () => {
    const { openUrl } = urlCapture();
    await expect(browserLogin("https://app.faden.io", { ...silent, openUrl, timeoutMs: 50 })).rejects.toThrow(
      /timed out/,
    );
  });
});
