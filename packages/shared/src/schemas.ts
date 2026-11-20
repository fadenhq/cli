import { z } from "zod";
import { HANDLE_MAX_LENGTH, handlePattern } from "./handles.js";
import { BILLING_MODES } from "./plans.js";
import { ACCEPTED_MEDIA_TYPES, PLATFORMS } from "./platforms.js";
import { POST_STATUSES, WEBHOOK_DELIVERY_STATUSES, WEBHOOK_EVENTS } from "./types.js";

export const platformSchema = z.enum(PLATFORMS);

/** IANA timezone string, lightly validated; resolved against the host's tz database at runtime. */
const timezoneSchema = z
  .string()
  .min(1)
  .refine((tz) => {
    try {
      new Intl.DateTimeFormat("en-US", { timeZone: tz });
      return true;
    } catch {
      return false;
    }
  }, "invalid IANA timezone");

export const mediaUrlSchema = z.string().url();

/**
 * ISO 8601 timestamp with an explicit UTC offset, the one shape every API time field accepts.
 * Seconds and fractions are optional ("2026-07-01T09:00Z" is valid): spelled out here instead of
 * relying on `z.string().datetime()`, whose accepted forms changed between zod releases (4.6
 * started requiring seconds). Values are normalized with `toISOString()` before storage, because
 * timestamps are compared as strings.
 */
const ISO_DATETIME =
  /^(\d{4})-(\d{2})-(\d{2})T([01]\d|2[0-3]):[0-5]\d(?::[0-5]\d(?:\.\d+)?)?(?:Z|[+-](?:[01]\d|2[0-3]):[0-5]\d)$/;

function isCalendarDate(value: string): boolean {
  const match = ISO_DATETIME.exec(value);
  if (!match) return true; // the regex has already rejected it; don't report twice
  const [, y, m, d] = match.map(Number);
  // Date.parse rolls 2026-02-30 over to March 2, so check the day against the real month length.
  // Computed directly: Date.UTC would remap years 0–99 to 1900–1999.
  if (m! < 1 || m! > 12 || d! < 1) return false;
  const leap = (y! % 4 === 0 && y! % 100 !== 0) || y! % 400 === 0;
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][m! - 1]!;
  return d! <= days;
}

export const isoDateTimeSchema = z
  .string()
  .regex(ISO_DATETIME, "expected an ISO 8601 date-time with an offset, e.g. 2026-07-01T09:00Z")
  .refine(isCalendarDate, "not a real calendar date")
  // Keep the OpenAPI `format` so client generators still map these fields to a date type.
  .meta({ format: "date-time" });

/** Fields every platform override may set: caption + media replacing the base post's. */
const overrideBase = {
  content: z.string().max(63206).optional(),
  mediaUrls: z.array(mediaUrlSchema).max(10).optional(),
};

/**
 * Per-platform override input, strictly typed: a platform override may only set fields its
 * platform understands. Extended alongside each connector (IG placement, YouTube title, …).
 */
export const platformConfigurationSchemas = {
  x: z.object(overrideBase).strict(),
  linkedin: z.object(overrideBase).strict(),
  facebook: z.object({ ...overrideBase, linkUrl: z.string().url().optional() }).strict(),
  instagram: z
    .object({
      ...overrideBase,
      placement: z.enum(["feed", "story", "reel"]).optional(),
      coverImageUrl: mediaUrlSchema.optional(),
    })
    .strict(),
  threads: z.object(overrideBase).strict(),
  tiktok: z
    .object({
      ...overrideBase,
      title: z.string().max(2200).optional(),
      draft: z.boolean().optional(),
      isAigc: z.boolean().optional(),
    })
    .strict(),
  youtube: z
    .object({
      ...overrideBase,
      title: z.string().max(100).optional(),
      thumbnailUrl: mediaUrlSchema.optional(),
      visibility: z.enum(["public", "private", "unlisted"]).optional(),
    })
    .strict(),
  bluesky: z.object({ ...overrideBase, linkUrl: z.string().url().optional() }).strict(),
  pinterest: z
    .object({
      ...overrideBase,
      boardId: z.string().min(1).optional(),
      title: z.string().max(100).optional(),
      linkUrl: z.string().url().optional(),
    })
    .strict(),
  google_business: z
    .object({
      ...overrideBase,
      locationId: z.string().min(1).optional(),
      ctaType: z.enum(["BOOK", "ORDER", "SHOP", "LEARN_MORE", "SIGN_UP", "CALL"]).optional(),
      linkUrl: z.string().url().optional(),
    })
    .strict(),
} as const;

export const platformConfigurationsSchema = z
  .object({
    x: platformConfigurationSchemas.x.optional(),
    linkedin: platformConfigurationSchemas.linkedin.optional(),
    facebook: platformConfigurationSchemas.facebook.optional(),
    instagram: platformConfigurationSchemas.instagram.optional(),
    threads: platformConfigurationSchemas.threads.optional(),
    tiktok: platformConfigurationSchemas.tiktok.optional(),
    youtube: platformConfigurationSchemas.youtube.optional(),
    bluesky: platformConfigurationSchemas.bluesky.optional(),
    pinterest: platformConfigurationSchemas.pinterest.optional(),
    google_business: platformConfigurationSchemas.google_business.optional(),
  })
  .strict();

export type PlatformConfigurationsInput = z.infer<typeof platformConfigurationsSchema>;

/**
 * Per-account override, keyed by our social-account id. The account's platform is only known at
 * pre-flight, so the value admits the union of all platform fields; fields another platform owns
 * are simply never read by the target's connector.
 */
export const accountConfigurationSchema = z
  .object({
    ...overrideBase,
    placement: z.enum(["feed", "story", "reel"]).optional(),
    coverImageUrl: mediaUrlSchema.optional(),
    title: z.string().max(2200).optional(),
    thumbnailUrl: mediaUrlSchema.optional(),
    visibility: z.enum(["public", "private", "unlisted"]).optional(),
    draft: z.boolean().optional(),
    isAigc: z.boolean().optional(),
    linkUrl: z.string().url().optional(),
    boardId: z.string().min(1).optional(),
    locationId: z.string().min(1).optional(),
    ctaType: z.enum(["BOOK", "ORDER", "SHOP", "LEARN_MORE", "SIGN_UP", "CALL"]).optional(),
  })
  .strict();

export const accountConfigurationsSchema = z.record(z.string(), accountConfigurationSchema);

export type AccountConfigurationsInput = z.infer<typeof accountConfigurationsSchema>;

/**
 * Body of `POST /v1/posts`. A single standardized payload fans out to every listed platform.
 * Omitting `scheduledFor` means publish as soon as possible.
 */
export const createPostSchema = z
  .object({
    content: z.string().max(63206).default(""),
    platforms: z.array(platformSchema).min(1),
    /**
     * Narrow the fan-out to specific connected accounts, each named by its faden account id or its
     * workspace handle. Omit to fan out to every active account of each targeted platform — the
     * default, so a workspace with two Facebook Pages posts to both unless it names one here. Every
     * entry must resolve to an active account on a targeted platform.
     */
    accountIds: z.array(z.string().min(1)).min(1).optional(),
    mediaUrls: z.array(mediaUrlSchema).max(10).default([]),
    scheduledFor: isoDateTimeSchema.optional(),
    timezone: timezoneSchema.optional(),
    /** Assign the next free posting-queue slot as the schedule (requires configured slots). */
    useQueue: z.boolean().default(false),
    /** When true the post is stored as a draft and never auto-published (HITL safeguard). */
    draft: z.boolean().default(false),
    /** Per-platform tailoring (caption/media/platform fields), merged over the base post. */
    platformConfigurations: platformConfigurationsSchema.optional(),
    /** Per-account tailoring keyed by social-account id; wins over platform overrides. */
    accountConfigurations: accountConfigurationsSchema.optional(),
  })
  .strict()
  .refine((v) => !(v.useQueue && v.scheduledFor), "useQueue and scheduledFor are mutually exclusive")
  .refine((v) => !(v.useQueue && v.draft), "useQueue posts schedule immediately; drafts can't sit in the queue");

export type CreatePostInput = z.infer<typeof createPostSchema>;

/** One weekly recurring posting-queue slot. */
export const queueSlotSchema = z
  .object({
    /** 0 = Sunday … 6 = Saturday. */
    weekday: z.number().int().min(0).max(6),
    /** Wall-clock time `HH:MM` (24h), interpreted in the queue's timezone. */
    time: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, "time must be HH:MM (24h)"),
  })
  .strict();

/** Body of `PUT /v1/queue` — replaces the workspace's posting-queue configuration wholesale. */
export const setQueueSchema = z
  .object({
    timezone: timezoneSchema,
    slots: z.array(queueSlotSchema).min(1).max(56),
  })
  .strict();

export type SetQueueInput = z.infer<typeof setQueueSchema>;

/**
 * Body of `PATCH /v1/posts/:id`. Only draft/scheduled posts are editable; every field is optional
 * and unspecified fields keep their current value.
 */
export const updatePostSchema = z
  .object({
    content: z.string().max(63206).optional(),
    platforms: z.array(platformSchema).min(1).optional(),
    /** Rebuild targets to these accounts (see createPost). Provide with or without `platforms`;
     * either present rebuilds the (still pending) target set. Omit both to keep current targets. */
    accountIds: z.array(z.string().min(1)).min(1).optional(),
    mediaUrls: z.array(mediaUrlSchema).max(10).optional(),
    scheduledFor: isoDateTimeSchema.optional(),
    timezone: timezoneSchema.optional(),
    /** When present, replaces the stored per-platform override map wholesale. */
    platformConfigurations: platformConfigurationsSchema.optional(),
    /** When present, replaces the stored per-account override map wholesale. */
    accountConfigurations: accountConfigurationsSchema.optional(),
  })
  .strict()
  .refine((v) => Object.keys(v).length > 0, "at least one field required");

export type UpdatePostInput = z.infer<typeof updatePostSchema>;

/**
 * Body of `POST /v1/posts/:id/approve` (optional): approve a draft, optionally (re)scheduling it.
 * A future `scheduledFor` queues it for that time; none (and none stored) publishes immediately.
 */
export const approvePostSchema = z
  .object({ scheduledFor: isoDateTimeSchema.optional() })
  .strict();

/** Query of `GET /v1/posts`: filters + cursor pagination. */
export const listPostsQuerySchema = z
  .object({
    status: z.enum(POST_STATUSES).optional(),
    platform: platformSchema.optional(),
    /** Inclusive `createdAt` lower bound. */
    from: isoDateTimeSchema.optional(),
    /** Exclusive `createdAt` upper bound. */
    to: isoDateTimeSchema.optional(),
    /** Inclusive `scheduledFor` lower bound; posts with no schedule are excluded. */
    scheduledFrom: isoDateTimeSchema.optional(),
    /** Exclusive `scheduledFor` upper bound; posts with no schedule are excluded. */
    scheduledTo: isoDateTimeSchema.optional(),
    limit: z.coerce.number().int().min(1).max(100).default(20),
    cursor: z.string().optional(),
  })
  .strict();

export type ListPostsQuery = z.infer<typeof listPostsQuerySchema>;

export const connectAccountSchema = z
  .object({
    /** Optional redirect to send the user back to after OAuth completes. */
    returnTo: z.string().url().optional(),
  })
  .strict();

/**
 * Body of `POST /v1/accounts/{platform}/connect` for credential-connect platforms
 * (see `CREDENTIAL_CONNECT_PLATFORMS`): Bluesky takes a handle/email/DID + app password.
 */
export const credentialsConnectSchema = z
  .object({
    /** Account handle, email, or DID (e.g. `alice.bsky.social`). */
    identifier: z.string().min(1),
    /** App password generated in the platform's settings — never the main account password. */
    appPassword: z.string().min(1),
  })
  .strict();

export type CredentialsConnectInput = z.infer<typeof credentialsConnectSchema>;

/** The handle rules from handles.ts as a validator; that module stays zod-free on purpose. */
export const accountHandleSchema = z
  .string()
  .min(1)
  .max(HANDLE_MAX_LENGTH)
  .regex(handlePattern, "handle must be a slug: lowercase letters, digits and single hyphens (no spaces or symbols)");

/** Body of `PATCH /v1/accounts/{id}`: rename an account's workspace-unique handle. */
export const updateAccountSchema = z.object({ handle: accountHandleSchema }).strict();

export type UpdateAccountInput = z.infer<typeof updateAccountSchema>;

/** Body of `POST /v1/workspaces` (admin bootstrap). */
export const createWorkspaceSchema = z
  .object({
    name: z.string().min(1).max(120),
    /** Seeds an admin invite: this email becomes workspace admin on first dashboard login. */
    ownerEmail: z.string().email().optional(),
  })
  .strict();

/** Body of `POST /v1/me/workspaces` (self-serve signup, #84). */
export const createOwnedWorkspaceSchema = z.object({ name: z.string().min(1).max(120) }).strict();

/** Body of `POST /v1/admin/workspaces/{id}/billing-mode` (operator sandbox toggle, #23). */
export const setBillingModeSchema = z.object({ mode: z.enum(BILLING_MODES) }).strict();

/** Body of `POST /v1/keys`: mint a named workspace API key. */
export const createApiKeySchema = z.object({ name: z.string().min(1).max(120) }).strict();

/** Workspace membership roles: admins manage keys/members; members publish. */
export const MEMBER_ROLES = ["admin", "member"] as const;
export type MemberRole = (typeof MEMBER_ROLES)[number];

/** Body of `POST /v1/members/invites`: invite an email to the workspace. */
export const inviteMemberSchema = z
  .object({
    email: z.string().email(),
    role: z.enum(MEMBER_ROLES).default("member"),
  })
  .strict();

/** Body of `PATCH /v1/members/{userId}`: change a member's role. */
export const updateMemberSchema = z.object({ role: z.enum(MEMBER_ROLES) }).strict();

/**
 * Body of `PUT /v1/sso`: configure a Scale workspace's OIDC SSO connection (#89). The client
 * secret is write-only — it is stored encrypted and never returned. `emailDomain` is the bare
 * domain colleagues sign in under (no `@`).
 */
export const ssoConnectionSchema = z
  .object({
    issuer: z.string().url(),
    clientId: z.string().min(1).max(400),
    clientSecret: z.string().min(1).max(400),
    emailDomain: z
      .string()
      .min(1)
      .max(253)
      .regex(/^[a-z0-9.-]+\.[a-z]{2,}$/i, "must be a bare email domain, e.g. acme.com"),
    defaultRole: z.enum(MEMBER_ROLES).default("member"),
  })
  .strict();

/** `http://` followed by a loopback host and then a port, path, query, fragment or the end. */
const LOOPBACK_HTTP = /^http:\/\/(?:localhost|127\.0\.0\.1|\[::1\])(?::\d+)?(?:[/?#]|$)/i;

/** True for an `http://` URL on a loopback host, the one plain-http webhook URL allowed in dev. */
export function isLoopbackHttpUrl(value: string): boolean {
  return LOOPBACK_HTTP.test(value);
}

/**
 * A webhook delivery URL (#152): `https:` only, so signed payloads never cross the network in
 * plaintext. Plain `http:` passes here for loopback hosts, the one place it can be useful (a
 * receiver next to `wrangler dev`); the API refuses those too outside local dev. Everything
 * else, `file:`/`ftp:` included, is rejected.
 */
export const webhookUrlSchema = z
  .string()
  .url()
  .refine((value) => /^https:\/\//i.test(value) || LOOPBACK_HTTP.test(value), "webhook URLs must use https (http is only allowed for localhost)")
  .meta({ format: "uri" });

/** Body of `POST /v1/webhooks`: register a delivery endpoint for signed status events. */
export const createWebhookSchema = z
  .object({
    url: webhookUrlSchema,
    /** Event types to deliver; omit to subscribe to all events. */
    events: z.array(z.enum(WEBHOOK_EVENTS)).min(1).optional(),
  })
  .strict();

export type CreateWebhookInput = z.infer<typeof createWebhookSchema>;

/**
 * Body of `PATCH /v1/webhooks/:id`. Every field optional (send only what changes); `events: null`
 * clears the filter back to "every event", which an empty array cannot express. `status` pauses an
 * endpoint or brings one back after faden disabled it for repeated failures — re-activating also
 * clears the failure count, so a fixed receiver starts from a clean slate.
 */
export const updateWebhookSchema = z
  .object({
    url: webhookUrlSchema.optional(),
    events: z.array(z.enum(WEBHOOK_EVENTS)).min(1).nullable().optional(),
    status: z.enum(["active", "disabled"]).optional(),
  })
  .strict()
  .refine((v) => v.url !== undefined || v.events !== undefined || v.status !== undefined, {
    message: "provide url, events, status, or a combination",
  });

export type UpdateWebhookInput = z.infer<typeof updateWebhookSchema>;

/** Query of `GET /v1/webhooks/:id/deliveries`: state filter + cursor pagination. */
export const listWebhookDeliveriesQuerySchema = z
  .object({
    status: z.enum(WEBHOOK_DELIVERY_STATUSES).optional(),
    limit: z.coerce.number().int().min(1).max(100).default(20),
    cursor: z.string().optional(),
  })
  .strict();

export type ListWebhookDeliveriesQuery = z.infer<typeof listWebhookDeliveriesQuerySchema>;

/** Body of `POST /v1/media`: reserve an R2 object before uploading bytes. */
export const registerMediaSchema = z
  .object({
    mimeType: z.enum(ACCEPTED_MEDIA_TYPES),
    sizeBytes: z.number().int().positive(),
    /** Video length; declare it so pre-flight can enforce per-platform duration limits (media is pass-through and never probed). */
    durationSeconds: z.number().positive().optional(),
  })
  .strict();

/** One row of a bulk CSV import after parsing. */
export const bulkRowSchema = z
  .object({
    content: z.string().max(63206).default(""),
    platforms: z.array(platformSchema).min(1),
    mediaUrls: z.array(mediaUrlSchema).max(10).default([]),
    scheduledFor: isoDateTimeSchema.optional(),
    timezone: timezoneSchema.optional(),
  })
  .strict();

export type BulkRowInput = z.infer<typeof bulkRowSchema>;
