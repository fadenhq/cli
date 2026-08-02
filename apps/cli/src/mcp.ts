import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import {
  createPostSchema,
  PLATFORM_CONSTRAINTS,
  PLATFORMS,
  POST_STATUSES,
  setQueueSchema,
  updatePostSchema,
  type Platform,
} from "@fadenhq/shared";
import { z } from "zod";
import type { ApiClient } from "./client.js";
import { uploadMedia } from "./media.js";
import { preflight } from "./preflight.js";

/**
 * MCP server as a thin wrapper over the REST API: every tool is one endpoint call, tool input
 * schemas are the SAME Zod validators the API parses with (converted to JSON Schema for the
 * wire, used directly to validate arguments before the request goes out). Runs on stdio via
 * `faden mcp`, authenticating like the CLI (FADEN_API_KEY env or `faden login`).
 */

interface ToolDef {
  name: string;
  description: string;
  schema: z.ZodObject<z.ZodRawShape>;
  handler: (client: ApiClient, args: Record<string, unknown>) => Promise<unknown>;
}

const postIdSchema = z.object({ postId: z.string().min(1).describe("Post id returned by create_post") }).strict();

const listPostsInput = z
  .object({
    status: z.enum(POST_STATUSES).optional().describe("Filter by aggregate post status"),
    platform: z.enum(PLATFORMS).optional().describe("Only posts targeting this platform"),
    from: z.string().datetime({ offset: true }).optional().describe("createdAt lower bound (inclusive, ISO 8601)"),
    to: z.string().datetime({ offset: true }).optional().describe("createdAt upper bound (exclusive, ISO 8601)"),
    limit: z.number().int().min(1).max(100).optional().describe("Page size (default 20)"),
    cursor: z.string().optional().describe("Opaque cursor from the previous page"),
  })
  .strict();

export const TOOLS: ToolDef[] = [
  {
    name: "create_post",
    description:
      "Create or schedule a unified social-media post that fans out to every listed platform, and " +
      "to every active account of each (e.g. both connected Facebook Pages). Pass accountIds to " +
      "narrow the fan-out to specific accounts. Omit scheduledFor to publish immediately, or set " +
      "draft: true to store without publishing. Use platformConfigurations/accountConfigurations " +
      "to tailor content per target (merge precedence: account > platform > base). Returns postId. " +
      "Poll get_post_status for per-target results. Pass idempotencyKey to make retries safe: " +
      "replaying a key returns the original post (replayed: true) instead of publishing twice.",
    schema: createPostSchema.extend({
      idempotencyKey: z
        .string()
        .min(1)
        .max(255)
        .optional()
        .describe("Caller-chosen key, unique per intended post. Replaying it never creates a second post"),
    }),
    handler: (client, args) => {
      // The key travels as a header, not a field — it identifies the request, not the post.
      const { idempotencyKey, ...body } = args;
      if (!idempotencyKey) return client.post("/v1/posts", body);
      return client.post("/v1/posts", body, { headers: { "idempotency-key": idempotencyKey as string } });
    },
  },
  {
    name: "get_post_status",
    description:
      "Post status with the granular per-target breakdown: platform, status, native post id, " +
      "stable errorCode and attempts for each fan-out target.",
    schema: postIdSchema,
    handler: (client, args) => client.get(`/v1/posts/${encodeURIComponent(args.postId as string)}`),
  },
  {
    name: "list_posts",
    description: "List posts newest-first with optional status/platform/date filters and cursor pagination.",
    schema: listPostsInput,
    handler: (client, args) => {
      const query = new URLSearchParams();
      for (const [key, value] of Object.entries(args)) {
        if (value !== undefined) query.set(key, String(value));
      }
      const qs = query.toString();
      return client.get(`/v1/posts${qs ? `?${qs}` : ""}`);
    },
  },
  {
    name: "update_post",
    description:
      "Edit a draft or scheduled post before it publishes. Unspecified fields keep their value; " +
      "fails with a conflict once the post is publishing.",
    schema: updatePostSchema.extend(postIdSchema.shape),
    handler: (client, args) => {
      const { postId, ...body } = args;
      return client.patch(`/v1/posts/${encodeURIComponent(postId as string)}`, body);
    },
  },
  {
    name: "cancel_post",
    description: "Cancel a scheduled or draft post (not one already publishing or finished).",
    schema: postIdSchema,
    handler: (client, args) => client.delete(`/v1/posts/${encodeURIComponent(args.postId as string)}`),
  },
  {
    name: "approve_post",
    description:
      "Approve a draft post after human sign-off: it publishes immediately, or at scheduledFor " +
      "when given (or when the draft already has one in the future). Only drafts can be approved.",
    schema: postIdSchema.extend({
      scheduledFor: z
        .string()
        .datetime({ offset: true })
        .optional()
        .describe("Publish time (ISO 8601 with offset); omit to use the draft's stored time or publish now"),
    }),
    handler: (client, args) => {
      const body = args.scheduledFor ? { scheduledFor: args.scheduledFor } : {};
      return client.post(`/v1/posts/${encodeURIComponent(args.postId as string)}/approve`, body);
    },
  },
  {
    name: "post_analytics",
    description:
      "Normalized metrics for a published post: latest snapshot plus time series per platform " +
      "target. Integers only, and null means the platform does not expose that metric (never 0).",
    schema: postIdSchema,
    handler: (client, args) => client.get(`/v1/posts/${encodeURIComponent(args.postId as string)}/analytics`),
  },
  {
    name: "list_accounts",
    description:
      "List the workspace's connected social accounts with platform, display name and status. " +
      "Account ids are the keys accepted by accountConfigurations.",
    schema: z.object({}).strict(),
    handler: (client) => client.get("/v1/accounts"),
  },
  {
    name: "connect_account",
    description:
      "Connect a social account. For OAuth platforms this returns an authUrl the user must open " +
      "in a browser to authorize. The account appears in list_accounts once they complete it. " +
      "Bluesky instead connects directly: pass identifier (handle) + appPassword (from " +
      "bsky.app Settings → App Passwords) and the account is connected in this call.",
    schema: z
      .object({
        platform: z.enum(PLATFORMS),
        returnTo: z.string().url().optional().describe("Redirect target after OAuth completes (OAuth platforms)"),
        identifier: z.string().optional().describe("Account handle/email (credential platforms, e.g. bluesky)"),
        appPassword: z.string().optional().describe("App password (credential platforms, never the main password)"),
      })
      .strict(),
    handler: (client, args) => {
      if (args.appPassword) {
        return client.post(`/v1/accounts/${args.platform as string}/connect`, {
          identifier: args.identifier,
          appPassword: args.appPassword,
        });
      }
      const query = args.returnTo ? `?returnTo=${encodeURIComponent(args.returnTo as string)}` : "";
      return client.post(`/v1/accounts/${args.platform as string}/connect${query}`);
    },
  },
  {
    name: "upload_media",
    description:
      "Upload a local file as post media: registers the asset, uploads the bytes to faden's " +
      "public media host, and returns the publicUrl to use in create_post's mediaUrls.",
    schema: z
      .object({
        filePath: z.string().min(1).describe("Absolute path of the local file to upload"),
        mimeType: z.string().optional().describe("Override the extension-based MIME type guess"),
      })
      .strict(),
    handler: (client, args) =>
      uploadMedia(client, args.filePath as string, args.mimeType as string | undefined),
  },
  {
    name: "get_usage",
    description:
      "Workspace consumption against the plan's quotas. Check this before a bulk run: a post that " +
      "would exceed the quota fails with quota_exceeded rather than queueing.",
    schema: z.object({}).strict(),
    handler: (client) => client.get("/v1/usage"),
  },
  {
    name: "list_queue_slots",
    description:
      "The recurring posting-queue slots and the next free one. create_post with useQueue: true " +
      "fills the next free slot, and fails with queue_not_configured when no slots exist.",
    schema: z.object({}).strict(),
    handler: (client) => client.get("/v1/queue"),
  },
  {
    name: "set_queue_slots",
    description:
      "REPLACE every queue slot with the ones given (this is a PUT, not an append). Read " +
      "list_queue_slots first. Times are wall-clock in the given IANA timezone.",
    schema: setQueueSchema,
    handler: (client, args) => client.put("/v1/queue", args),
  },
  {
    name: "list_platform_constraints",
    description:
      "Per-platform limits: character ceiling, media count, accepted image/video types and byte " +
      "sizes. Answered locally with no API call, so size content with this instead of learning the " +
      "limit from a rejected create_post.",
    schema: z
      .object({ platform: z.enum(PLATFORMS).optional().describe("Only this platform, omit for all") })
      .strict(),
    handler: (_client, args) => {
      const wanted = args.platform ? [args.platform as Platform] : [...PLATFORMS];
      return Promise.resolve(wanted.map((platform) => ({ platform, ...PLATFORM_CONSTRAINTS[platform] })));
    },
  },
  {
    name: "validate_post",
    description:
      "Dry-run a post against every target platform's constraints without creating anything. " +
      "Runs locally (no API call), so it is free to call before every create_post.",
    schema: z
      .object({
        content: z.string().describe("The post text"),
        platforms: z.array(z.enum(PLATFORMS)).min(1),
        mediaUrls: z.array(z.string().url()).optional(),
        boardId: z.string().optional().describe("Pinterest destination board (required for pinterest)"),
        locationId: z.string().optional().describe("Google Business destination (required for google_business)"),
      })
      .strict(),
    handler: (_client, args) =>
      Promise.resolve(
        preflight(args.platforms as Platform[], args.content as string, (args.mediaUrls as string[]) ?? [], {
          ...(args.boardId ? { pinterest: { boardId: args.boardId as string } } : {}),
          ...(args.locationId ? { google_business: { locationId: args.locationId as string } } : {}),
        }),
      ),
  },
];

/** JSON Schema for the tool listing, derived from the same Zod schema that validates calls. */
export function toolInputJsonSchema(tool: ToolDef): Record<string, unknown> {
  const json = z.toJSONSchema(tool.schema, { target: "draft-07", io: "input" }) as Record<string, unknown>;
  delete json.$schema;
  return json;
}

export function buildMcpServer(client: ApiClient): Server {
  const server = new Server({ name: "faden", version: "0.1.0" }, { capabilities: { tools: {} } });

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: TOOLS.map((tool) => ({
      name: tool.name,
      description: tool.description,
      inputSchema: toolInputJsonSchema(tool),
    })),
  }));

  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const tool = TOOLS.find((t) => t.name === req.params.name);
    if (!tool) {
      return { content: [{ type: "text", text: `unknown tool: ${req.params.name}` }], isError: true };
    }
    const parsed = tool.schema.safeParse(req.params.arguments ?? {});
    if (!parsed.success) {
      return {
        content: [{ type: "text", text: JSON.stringify({ error: "invalid_arguments", issues: parsed.error.issues }) }],
        isError: true,
      };
    }
    try {
      const result = await tool.handler(client, parsed.data as Record<string, unknown>);
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    } catch (err) {
      // API errors carry the endpoint + status + body from ApiClient — already agent-readable.
      return { content: [{ type: "text", text: (err as Error).message }], isError: true };
    }
  });

  return server;
}

export async function runMcpServer(client: ApiClient): Promise<void> {
  await buildMcpServer(client).connect(new StdioServerTransport());
}
