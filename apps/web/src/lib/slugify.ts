/**
 * Kebab-case slugifier used for both the auto-derive-from-name path
 * and the direct slug-input path. Strips accents (so "Cafés" → "cafes"),
 * collapses any non-alphanumeric run to a single dash, trims leading
 * and trailing dashes, lowercases, and caps at 60 chars so the slug
 * fits comfortably in URLs and DB columns.
 */
export function slugify(s: string): string {
  return s
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
}
