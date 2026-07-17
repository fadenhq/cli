import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { describe, expect, it } from "vitest";
import type { ApiClient } from "./client.js";
import { buildMcpServer, TOOLS, toolInputJsonSchema } from "./mcp.js";

/** ApiClient fake recording calls and returning canned responses per path prefix. */
function fakeApi(responses: Record<string, unknown> = {}) {
  const calls: { method: string; path: string; body?: unknown }[] = [];
  const respond = (path: string) => {
    const hit = Object.entries(responses).find(([prefix]) => path.startsWith(prefix));
    return Promise.resolve(hit ? hit[1] : {});
  };
  const api = {
    calls,
    get: (path: string) => (calls.push({ method: "GET", path }), respond(path)),
    post: (path: string, body?: unknown) => (calls.push({ method: "POST", path, body }), respond(path)),
    patch: (path: string, body?: unknown) => (calls.push({ method: "PATCH", path, body }), respond(path)),
    delete: (path: string) => (calls.push({ method: "DELETE", path }), respond(path)),
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
        "get_post_status",
        "list_accounts",
        "list_posts",
        "post_analytics",
        "update_post",
        "upload_media",
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
    await client.callTool({ name: "connect_account", arguments: { platform: "threads" } });
    await client.callTool({ name: "list_accounts", arguments: {} });

    expect(api.calls).toEqual([
      { method: "GET", path: "/v1/posts/p-9" },
      { method: "GET", path: "/v1/posts?status=scheduled&limit=5" },
      { method: "PATCH", path: "/v1/posts/p-9", body: { content: "edited" } },
      { method: "DELETE", path: "/v1/posts/p-9" },
      { method: "POST", path: "/v1/accounts/threads/connect", body: undefined },
      { method: "GET", path: "/v1/accounts" },
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
