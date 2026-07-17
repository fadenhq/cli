/** Timezone math on the platform's Intl tables — no bundled tz database. */

/** Interpret `local` (e.g. "2026-07-01T09:00") as wall-clock time in `timeZone`, return UTC ISO. */
export function zonedWallTimeToUtc(local: string, timeZone: string): string {
  const guess = new Date(`${local}Z`); // pretend the wall time is UTC
  if (Number.isNaN(guess.getTime())) throw new Error(`invalid datetime: ${local}`);
  const offsetMin = tzOffsetMinutes(timeZone, guess);
  return new Date(guess.getTime() - offsetMin * 60_000).toISOString();
}

/** Offset (minutes) of `timeZone` from UTC at the given instant. */
export function tzOffsetMinutes(timeZone: string, at: Date): number {
  const dtf = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  });
  const parts: Record<string, number> = {};
  for (const p of dtf.formatToParts(at)) {
    if (p.type !== "literal") parts[p.type] = Number(p.value);
  }
  const asUtc = Date.UTC(
    parts.year!,
    parts.month! - 1,
    parts.day!,
    parts.hour! === 24 ? 0 : parts.hour!,
    parts.minute!,
    parts.second!,
  );
  return (asUtc - at.getTime()) / 60_000;
}

/** Today's calendar date in `timeZone` as UTC-noon anchor (safe to walk by whole days). */
export function todayInZone(timeZone: string, nowMs: number): Date {
  const dtf = new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" });
  const [y, m, d] = dtf.format(new Date(nowMs)).split("-").map(Number);
  return new Date(Date.UTC(y!, m! - 1, d!, 12));
}
