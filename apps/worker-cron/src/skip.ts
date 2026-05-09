/** Format `now` as YYYY-MM-DD in the given IANA tz. Pure. */
export function dateInTz(now: Date, tz: string): string {
  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone: tz,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  });
  // en-CA always emits ISO-style YYYY-MM-DD via formatToParts.
  const parts = fmt.formatToParts(now);
  const y = parts.find((p) => p.type === 'year')?.value ?? '0000';
  const m = parts.find((p) => p.type === 'month')?.value ?? '01';
  const d = parts.find((p) => p.type === 'day')?.value ?? '01';
  return `${y}-${m}-${d}`;
}

/** True if today (in `tz`) is one of the skip dates. */
export function isSkipped(skipDates: readonly string[], tz: string, now: Date): boolean {
  if (!skipDates || skipDates.length === 0) return false;
  return skipDates.includes(dateInTz(now, tz));
}
