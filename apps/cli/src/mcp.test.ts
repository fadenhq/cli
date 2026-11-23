import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { describe, expect, it } from "vitest";
import type { ApiClient } from "./client.js";
import { buildMcpServer, TOOLS, toolInputJsonSchema } from "./mcp.js";

/** ApiClient fake recording calls and returning canned responses per path prefix. */
function fakeApi(responses: Record<string, unknown> = {}) {
  const calls: { method: string; path: string; body?: unknown; options?: unknown }[] = [];
  const respond = (path: string) => {
    const hit = Object.entries(responses).find(([prefix]) => path.startsWith(prefix));
    return Promise.resolve(hit ? hit[1] : {});
  };
  const api = {
    calls,
    get: (path: string) => (calls.push({ method: "GET", path }), respond(path)),
    post: (path: string, body?: unknown, options?: unknown) => (
      calls.push({ method: "POST", path, body, ...(options ? { options } : {}) }), respond(path)
    ),
    patch: (path: string, body?: unknown) => (calls.push({ method: "PATCH", path, body }), respond(path)),
    delete: (path: string) => (calls.push({ method: "DELETE", path }), respond(path)),
    put: (path: string, body?: unknown) => (calls.push({ method: "PUT", path, body }), respond(path)),
    postRaw: (path: string) => (calls.push({ method: "POST", path }), respond(path)),
    putRaw: (path: string) => (calls.push({ method: "PUT", path }), respond(path)),
  };
  return api as unknown as ApiClient & { calls: typeof calls };
}

async function connect(api: ApiClient) {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const server = buildMcpServer(api);
  const client = new Client({ name: "test", version: "0.0.0" });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return client;
}

describe("faden MCP server", () => {
  it("lists every tool with a JSON Schema derived from the shared Zod validators", async () => {
    const client = await connect(fakeApi());

    const { tools } = await client.listTools();

    expect(tools.map((t) => t.name).sort()).toEqual(
      [
        "approve_post",
        "cancel_post",
        "connect_account",
        "create_post",
        "delete_media",
        "disconnect_account",
        "get_post_status",
        "get_usage",
        "list_accounts",
        "list_media",
        "list_platform_constraints",
        "list_posts",
        "list_queue_slots",
        "post_analytics",
        "retry_post",
        "set_queue_slots",
        "update_post",
        "upload_media",
        "validate_post",
      ].sort(),
    );
    const createPost = tools.find((t) => t.name === "create_post")!;
    const schema = createPost.inputSchema as { properties: Record<string, unknown>; additionalProperties?: boolean };
    expect(schema.additionalProperties).toBe(false); // .strict() survives
    expect(Object.keys(schema.properties)).toContain("platformConfigurations");
  });

  it("creates a post through the real protocol and returns the API response", async () => {
    const api = fakeApi({ "/v1/posts": { postId: "p-1", status: "publishing" } });
    const client = await connect(api);

    const result = await client.callTool({
      name: "create_post",
      arguments: { content: "hello", platforms: ["x"] },
    });

    expect(result.isError).toBeFalsy();
    expect(JSON.parse((result.content as { text: string }[])[0]!.text)).toEqual({ postId: "p-1", status: "publishing" });
    expect(api.calls).toEqual([
      {
        method: "POST",
        path: "/v1/posts",
        // Zod-applied defaults ride along, exactly like the REST validator would set them.
        body: { content: "hello", platforms: ["x"], mediaUrls: [], useQueue: false, draft: false },
      },
    ]);
  });

  it("sends idempotencyKey as a header, not as part of the post body", async () => {
    const api = fakeApi({ "/v1/posts": { postId: "p-1", replayed: true } });
    const client = await connect(api);

    await client.callTool({
      name: "create_post",
      arguments: { content: "hello", platforms: ["x"], idempotencyKey: "ship-42" },
    });

    expect(api.calls).toEqual([
      {
        method: "POST",
        path: "/v1/posts",
        body: { content: "hello", platforms: ["x"], mediaUrls: [], useQueue: false, draft: false },
        options: { headers: { "idempotency-key": "ship-42" } },
      },
    ]);
  });

  it("rejects invalid arguments with Zod issues before any API call happens", async () => {
    const api = fakeApi();
    const client = await connect(api);

    const result = await client.callTool({
      name: "create_post",
      arguments: { content: "hello", platforms: ["myspace"] },
    });

    expect(result.isError).toBe(true);
    const payload = JSON.parse((result.content as { text: string }[])[0]!.text);
    expect(payload.error).toBe("invalid_arguments");
    expect(api.calls).toHaveLength(0);
  });

  it("routes status, list, update, cancel and connect to the matching endpoints", async () => {
    const api = fakeApi();
    const client = await connect(api);

    await client.callTool({ name: "get_post_status", arguments: { postId: "p-9" } });
    await client.callTool({ name: "list_posts", arguments: { status: "scheduled", limit: 5 } });
    await client.callTool({ name: "update_post", arguments: { postId: "p-9", content: "edited" } });
    await client.callTool({ name: "cancel_post", arguments: { postId: "p-9" } });
    await client.callTool({ name: "retry_post", arguments: { postId: "p-9", targets: ["main"] } });
    await client.callTool({ name: "connect_account", arguments: { platform: "threads" } });
    await client.callTool({ name: "list_accounts", arguments: {} });
    await client.callTool({ name: "list_media", arguments: { limit: 50, cursor: "c1" } });
    await client.callTool({ name: "delete_media", arguments: { mediaId: "m-1" } });

    expect(api.calls).toEqual([
      { method: "GET", path: "/v1/posts/p-9" },
      { method: "GET", path: "/v1/posts?status=scheduled&limit=5" },
      { method: "PATCH", path: "/v1/posts/p-9", body: { content: "edited" } },
      { method: "DELETE", path: "/v1/posts/p-9" },
      { method: "POST", path: "/v1/posts/p-9/retry", body: { targets: ["main"] } },
      { method: "POST", path: "/v1/accounts/threads/connect", body: undefined },
      { method: "GET", path: "/v1/accounts" },
      { method: "GET", path: "/v1/media?limit=50&cursor=c1" },
      { method: "DELETE", path: "/v1/media/m-1" },
    ]);
  });

  it("disconnect_account previews by default and only deletes when dryRun is false (#159)", async () => {
    const listed = { accounts: [{ id: "acc_1", handle: "main-brand", platform: "x", status: "active" }] };
    const api = fakeApi({ "/v1/accounts": listed });
    const client = await connect(api);

    const preview = await client.callTool({ name: "disconnect_account", arguments: { account: "main-brand" } });
    expect(api.calls.filter((c) => c.method !== "GET")).toEqual([]);
    const text = (preview.content as Array<{ text: string }>)[0]!.text;
    expect(JSON.parse(text)).toMatchObject({ dryRun: true, wouldDisconnect: true, account: { id: "acc_1" } });
    expect(text).toContain("confirm");

    await client.callTool({ name: "disconnect_account", arguments: { account: "main-brand", dryRun: false } });
    expect(api.calls.at(-1)).toEqual({ method: "DELETE", path: "/v1/accounts/acc_1" });
  });

  it("disconnect_account reports an unknown account as a tool error, deleting nothing", async () => {
    const api = fakeApi({ "/v1/accounts": { accounts: [] } });
    const client = await connect(api);

    const res = await client.callTool({ name: "disconnect_account", arguments: { account: "nope", dryRun: false } });

    expect(res.isError).toBe(true);
    expect(api.calls.filter((c) => c.method !== "GET")).toEqual([]);
  });

  it("answers the offline tools without touching the API", async () => {
    const api = fakeApi();
    const client = await connect(api);

    const limits = await client.callTool({ name: "list_platform_constraints", arguments: { platform: "x" } });
    const check = await client.callTool({
      name: "validate_post",
      arguments: { content: "a".repeat(300), platforms: ["x"] },
    });

    expect(JSON.parse((limits.content as { text: string }[])[0]!.text)).toEqual([
      expect.objectContaining({ platform: "x", maxContentLength: 280 }),
    ]);
    expect(JSON.parse((check.content as { text: string }[])[0]!.text)).toMatchObject({
      ok: false,
      issues: [expect.objectContaining({ platform: "x", code: "content_too_long" })],
    });
    expect(api.calls).toHaveLength(0);
  });

  it("routes usage and queue to their endpoints", async () => {
    const api = fakeApi();
    const client = await connect(api);

    await client.callTool({ name: "get_usage", arguments: {} });
    await client.callTool({ name: "list_queue_slots", arguments: {} });
    await client.callTool({
      name: "set_queue_slots",
      arguments: { timezone: "Europe/Berlin", slots: [{ weekday: 1, time: "09:00" }] },
    });

    expect(api.calls).toEqual([
      { method: "GET", path: "/v1/usage" },
      { method: "GET", path: "/v1/queue" },
      {
        method: "PUT",
        path: "/v1/queue",
        body: { timezone: "Europe/Berlin", slots: [{ weekday: 1, time: "09:00" }] },
      },
    ]);
  });

  it("surfaces API failures as tool errors instead of protocol crashes", async () => {
    const api = fakeApi();
    (api as unknown as { get: () => Promise<never> }).get = () =>
      Promise.reject(new Error("GET /v1/posts/p-x → 404: {\"error\":\"not_found\"}"));
    const client = await connect(api);

    const result = await client.callTool({ name: "get_post_status", arguments: { postId: "p-x" } });

    expect(result.isError).toBe(true);
    expect((result.content as { text: string }[])[0]!.text).toContain("not_found");
  });

  it("every tool schema converts to JSON Schema without loss of the strict contract", () => {
    for (const tool of TOOLS) {
      const json = toolInputJsonSchema(tool) as { type?: string; additionalProperties?: boolean };
      expect(json.type, tool.name).toBe("object");
      expect(json.additionalProperties, tool.name).toBe(false);
    }
  });
});
