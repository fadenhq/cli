import type { Platform } from "./platforms.js";
import type { PublishOptions } from "./overrides.js";

/** Lifecycle of a whole post (aggregate of its per-platform targets). */
export const POST_STATUSES = [
  "draft",
  "scheduled",
  "publishing",
  "completed",
  "partial",
  "failed",
] as const;
export type PostStatus = (typeof POST_STATUSES)[number];

/** Lifecycle of a single fan-out target (one platform for one post). */
export const TARGET_STATUSES = [
  "pending",
  "publishing",
  "completed",
  "failed",
] as const;
export type TargetStatus = (typeof TARGET_STATUSES)[number];

/** A media asset referenced by a post. `url` must be publicly reachable at publish time. */
export interface MediaRef {
  url: string;
  mimeType: string;
  sizeBytes: number;
  /** Video length, when known (client-declared at upload; media is never probed with ffmpeg). */
  durationSeconds?: number;
}

/** Normalized result of publishing to a single platform — the granular per-target detail. */
export interface TargetResult {
  platform: Platform;
  status: TargetStatus;
  /** Native id returned by the platform on success (tweet id, share urn, video id, …). */
  nativePostId?: string;
  /** Public URL of the post on the platform, when one exists. */
  permalink?: string;
  /** Stable machine-readable code on failure, e.g. `rate_limited`, `media_invalid`, `auth_expired`. */
  errorCode?: string;
  /** Human-readable diagnostic detail on failure. */
  errorDetail?: string;
  attempts: number;
}

/** What a connector needs to perform a single publish. */
export interface PublishRequest {
  content: string;
  media: MediaRef[];
  /** Decrypted, valid access token for the target account. */
  accessToken: string;
  /** Platform-native account id (page id, channel id, user urn, …). */
  externalAccountId: string;
  /** Merged platform-specific options (account > platform); absent when the post has none. */
  options?: PublishOptions;
  /**
   * Stable per-target key (the `post_targets.id`) passed to platforms that support client-supplied
   * deduplication (e.g. Bluesky's `rkey`). Ensures a redelivered attempt after a lost response
   * cannot create a second native post.
   */
  idempotencyKey?: string;
  /**
   * Immutable ISO 8601 UTC timestamp of the post (used with `idempotencyKey` when a platform's
   * native key embeds a timestamp, such as Bluesky's ATProto TID).
   */
  createdAt?: string;
  /**
   * Set when resuming a publish the platform accepted earlier but was still processing (#156): the
   * connector's own `pending.checkpoint` from that call. The connector must continue from it (poll,
   * then finish) and never start a second upload.
   */
  checkpoint?: PublishCheckpoint;
}

/** Connector-defined, JSON-serializable state for resuming an accepted-but-processing publish. */
export type PublishCheckpoint = Record<string, unknown>;

/** Outcome a connector returns from `publish`. */
export interface PublishResult {
  nativePostId?: string;
  /** Public URL of the post, when only the platform can supply it (see `postPermalink`). */
  permalink?: string;
  errorCode?: string;
  errorDetail?: string;
  /** On `rate_limited`: seconds the platform asked us to wait (Retry-After / reset headers). */
  retryAfterSeconds?: number;
  /**
   * The platform accepted the upload but is still processing it (#156). The caller stores
   * `checkpoint` and calls `publish` again later with it, instead of the connector sleeping
   * through the wait. Not an error, and doesn't count against retries.
   */
  pending?: { checkpoint: PublishCheckpoint; retryAfterSeconds?: number };
}

/**
 * Normalized post metrics, integers only (agent-deterministic). `null` means the platform does
 * not expose that metric for this post — never coerce a missing value to 0.
 */
export interface AnalyticsMetrics {
  impressions: number | null;
  likes: number | null;
  comments: number | null;
  shares: number | null;
  videoViews: number | null;
}

/** Stable error codes connectors map native failures onto, so downstream logic can branch reliably. */
export const ERROR_CODES = [
  "rate_limited",
  "auth_expired",
  /** The account's grant was revoked or its refresh token rejected; the user must reconnect. */
  "account_revoked",
  "media_invalid",
  "content_invalid",
  "permission_denied",
  "upstream_unavailable",
  /** Terminal: the publish queue exhausted its retries (set by the DLQ consumer). */
  "max_retries_exceeded",
  "unknown",
] as const;
export type ErrorCode = (typeof ERROR_CODES)[number];

/** Whether a failure is worth retrying via the queue's backoff, or is permanent. */
export function isRetryable(code: ErrorCode): boolean {
  return code === "rate_limited" || code === "upstream_unavailable";
}

/**
 * Webhook event types. `post.target.updated` fires per target on its terminal outcome
 * (completed/failed); the `post.*` aggregate events fire once when the whole post reaches a
 * terminal status.
 */
export const WEBHOOK_EVENTS = [
  "post.target.updated",
  "post.completed",
  "post.partial",
  "post.failed",
] as const;
export type WebhookEventType = (typeof WEBHOOK_EVENTS)[number];

/**
 * Terminal state of one event's delivery to one endpoint. `pending` means retries remain — only
 * an event that exhausted them is `failed`.
 */
export const WEBHOOK_DELIVERY_STATUSES = ["pending", "delivered", "failed"] as const;
export type WebhookDeliveryStatus = (typeof WEBHOOK_DELIVERY_STATUSES)[number];

/**
 * Events dead-lettered in a row before faden disables an endpoint. Counted per event, not per
 * attempt, so a brief receiver outage costs one. Lives here because the CLI and the dashboard
 * both state the number to users, and a copy of it would quietly drift from the API's behaviour.
 */
export const WEBHOOK_FAILURE_THRESHOLD = 5;

/** How long delivery records are kept before the cron prunes them. */
export const WEBHOOK_DELIVERY_RETENTION_DAYS = 30;
