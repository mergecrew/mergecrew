/**
 * Tag-pattern interpolation for the tag-driven PromotionStrategy
 * (#471). Supports two placeholders:
 *
 *   - `${YYYY-MM-DD}` — UTC date at interpolation time
 *   - `${shortSha}`   — first 7 chars of the release branch HEAD
 *
 * Anything else is left as a literal so a misspelled placeholder
 * (`${ShortSha}`, `${date}`) doesn't silently produce a bad tag —
 * the user sees the literal in the resulting tag name and fixes the
 * pattern in their PromotionStrategy.
 */
export function interpolateTagPattern(pattern: string, headSha: string, now: Date = new Date()): string {
  const date = now.toISOString().slice(0, 10);
  return pattern
    .replace(/\$\{YYYY-MM-DD\}/g, date)
    .replace(/\$\{shortSha\}/g, headSha.slice(0, 7));
}
