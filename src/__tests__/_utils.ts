import { vi } from 'vitest';

/**
 * Creates a chainable Supabase-like query builder mock.
 *
 * `defaultResult` is returned when the builder is awaited directly (via `.then`)
 * or when the terminal methods `.single()` / `.maybeSingle()` are called.
 *
 * All chainable methods (`select`, `insert`, `eq`, etc.) return the same
 * builder instance so they can be arbitrarily chained without extra setup.
 *
 * Usage:
 *   mockFrom.mockImplementation((table) => {
 *     if (table === 'checkins') return makeBuilder({ data: checkinRow, error: null });
 *     return makeBuilder({ data: null, error: null });
 *   });
 */
export function makeBuilder(defaultResult: { data: any; error: any } = { data: null, error: null }) {
  const b: any = {};

  // Make the builder itself thenable so `await db.from(...).select(...).gte(...)` works.
  b.then = (resolve: (v: any) => any) => Promise.resolve(defaultResult).then(resolve);

  for (const m of [
    'select', 'insert', 'update', 'upsert', 'delete',
    'eq', 'neq', 'ilike', 'gte', 'lte',
    'limit', 'order', 'range', 'not', 'in',
  ]) {
    b[m] = vi.fn().mockReturnValue(b);
  }

  // Terminal methods that return their own resolved Promise
  b.single      = vi.fn().mockResolvedValue(defaultResult);
  b.maybeSingle = vi.fn().mockResolvedValue(defaultResult);

  return b;
}
