/**
 * Account handles: a workspace-unique, url-safe slug that names a connected account so it can be
 * targeted without its opaque UUID (`accountIds: ["acme-coffee"]`). Strict slug form — lowercase
 * alphanumerics joined by single hyphens, nothing else — so it stays easy to type and unambiguous.
 *
 * Deliberately free of zod (`accountHandleSchema` lives in schemas.ts) so the dashboard can import
 * the rules through the `@fadenhq/shared/handles` subpath without pulling zod into its bundle.
 */
export const HANDLE_MAX_LENGTH = 60;
export const handlePattern = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/**
 * Reduce arbitrary text (typically a display name) to a valid handle: lowercase, non-alphanumerics
 * collapsed to single hyphens, trimmed, length-capped. Returns "" when nothing usable remains
 * (e.g. an all-emoji name) — callers supply their own fallback.
 */
export function slugifyHandle(input: string): string {
  return input
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, HANDLE_MAX_LENGTH)
    .replace(/-+$/g, ""); // a hyphen left dangling by the length cap
}

/**
 * Turn `base` into a handle not already in `taken`, appending `-2`, `-3`, … on collision. `base`
 * is assumed already slugified; an empty base falls back to `fallback`. Does not mutate `taken`.
 */
export function uniqueHandle(base: string, taken: ReadonlySet<string>, fallback = "account"): string {
  const root = base || fallback;
  if (!taken.has(root)) return root;
  for (let n = 2; ; n++) {
    const candidate = `${root.slice(0, HANDLE_MAX_LENGTH - String(n).length - 1)}-${n}`;
    if (!taken.has(candidate)) return candidate;
  }
}
