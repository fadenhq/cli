/**
 * Convert a human schedule string to an ISO 8601 UTC instant.
 * Accepts:
 *   - a full ISO 8601 string (with offset/Z) — returned as-is in UTC
 *   - "<local-datetime> <IANA timezone>", e.g. "2026-07-01T09:00 America/New_York"
 */
import { zonedWallTimeToUtc } from "@fadenhq/shared";

export function toIsoUtc(input: string): { scheduledFor: string; timezone?: string } {
  const trimmed = input.trim();

  // Already a fully-qualified instant?
  if (/[zZ]$|[+-]\d{2}:?\d{2}$/.test(trimmed)) {
    return { scheduledFor: new Date(trimmed).toISOString() };
  }

  const spaceIdx = trimmed.indexOf(" ");
  if (spaceIdx === -1) {
    // Bare local datetime, no zone — interpret in the host's local zone.
    return { scheduledFor: new Date(trimmed).toISOString() };
  }

  const local = trimmed.slice(0, spaceIdx);
  const timezone = trimmed.slice(spaceIdx + 1).trim();
  return { scheduledFor: zonedWallTimeToUtc(local, timezone), timezone };
}
