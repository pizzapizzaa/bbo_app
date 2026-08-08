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
export function isValidDate(s: string): boolean {
  if (!ISO_DATE.test(s)) return false;
  // Parse the components and verify no rollover occurred (e.g. 2025-02-29 → 2025-03-01).
  const [y, m, d] = s.split('-').map(Number);
  const date = new Date(s);
  return !isNaN(date.getTime()) &&
         date.getUTCFullYear() === y &&
         date.getUTCMonth() + 1 === m &&
         date.getUTCDate()        === d;
}
export function isValidTime(s: string):   boolean { return HH_MM.test(s); }
export function isValidAmount(n: number): boolean { return Number.isFinite(n) && n >= 0 && n <= MAX_AMOUNT; }

/**
 * Escape wildcards so a user-supplied string is matched literally by LIKE/ILIKE.
 *
 * Order matters — the backslash must be escaped first. Otherwise an input of
 * "\%" would become "\\%": a literal backslash followed by a *live* wildcard,
 * re-opening the very hole the other replacements close.
 *
 *   \  the LIKE escape character itself
 *   %  SQL "any sequence of characters" wildcard
 *   _  SQL "any single character" wildcard
 *   *  PostgREST's alias for %, substituted into the pattern before it reaches
 *      SQL — so an unescaped "*" is just as dangerous as an unescaped "%".
 */
export function escapeLike(s: string): string {
  return s
    .replace(/\\/g, '\\\\')
    .replace(/%/g,  '\\%')
    .replace(/_/g,  '\\_')
    .replace(/\*/g, '\\*');
}

/**
 * Case-insensitive exact comparison of two customer names.
 *
 * Defence in depth for the `.ilike()` name lookups: even if a wildcard were to
 * slip past escapeLike, the row it matched would not equal the supplied name,
 * so the caller can reject it instead of acting on someone else's record.
 */
export function namesMatch(a: string | null | undefined, b: string | null | undefined): boolean {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  return a.trim().toLowerCase() === b.trim().toLowerCase();
}
