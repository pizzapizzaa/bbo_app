/** Shared input-validation helpers used across API routes. */

export const UUID_RE  = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
export const HH_MM    = /^\d{2}:\d{2}$/;

/** Max field lengths */
export const MAX_NAME   = 300;
export const MAX_TEXT   = 1000;
/** Max currency amount in VND (100 billion) */
export const MAX_AMOUNT = 100_000_000_000;

export function isValidUUID(s: string):   boolean { return UUID_RE.test(s); }
export function isValidDate(s: string):   boolean { return ISO_DATE.test(s) && !isNaN(Date.parse(s)); }
export function isValidTime(s: string):   boolean { return HH_MM.test(s); }
export function isValidAmount(n: number): boolean { return Number.isFinite(n) && n >= 0 && n <= MAX_AMOUNT; }

/**
 * Escape SQL LIKE/ILIKE wildcards (% and _) so that user-supplied strings
 * are treated as literals rather than patterns.
 */
export function escapeLike(s: string): string {
  return s.replace(/%/g, '\\%').replace(/_/g, '\\_');
}
