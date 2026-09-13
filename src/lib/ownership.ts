import { db } from './db';
import type { AuthInfo } from './auth';
import { gymToday } from './validate';

/**
 * Row-level ownership for the two tables part-timers may write to
 * (`checkins`, `schedule_entries`).
 *
 * Admins are unrestricted — nothing here changes what an admin can do.
 * A part-timer may edit or delete a row when either test passes:
 *   • they created it — tracked in a `created_by` column added by
 *     supabase/migration-part-timer.sql, or
 *   • it belongs to today and its table opts into the same-day rule below.
 *
 * That migration is a manual step, so every function here also has to behave
 * sensibly on a database where the column does not exist yet:
 *   • inserts retry without `created_by` (so check-in never breaks), and
 *   • ownership falls back to the same-day rule alone, which needs no column.
 */

/**
 * Tables where a part-timer may also modify *today's* rows whoever logged them,
 * mapped to the column holding the row's own date.
 *
 * This is the shift-desk rule for check-ins: whoever is on duty fixes the day's
 * mistakes, because the person who typed the wrong name has usually gone home.
 * Rows from earlier days stay with their author or an admin, so the takings of a
 * week already counted cannot be quietly rewritten from the front desk.
 *
 * `schedule_entries` is deliberately absent — a shift is not a till entry, and
 * who may claim or drop one is decided by /api/schedule/:id/claim instead.
 */
const sameDayDateColumn: Record<string, string> = {
  checkins: 'date',
};

/** Tables already proven to lack `created_by`, so we stop re-trying per request. */
const missingCreatedBy = new Set<string>();

/**
 * PostgREST reports an unknown column as PGRST204 (schema cache miss) or as
 * Postgres 42703 (undefined_column), depending on whether the insert is
 * rejected before or after it reaches the database.
 */
function isMissingCreatedByError(error: { code?: string; message?: string } | null): boolean {
  if (!error) return false;
  if (error.code === 'PGRST204' || error.code === '42703') return true;
  return /created_by/.test(error.message ?? '') && /column/i.test(error.message ?? '');
}

/**
 * Insert a row, stamping `created_by` with the caller's username.
 *
 * Falls back to an unstamped insert when the column is absent, so a deployment
 * that has not run the migration keeps working — part-timers can still add
 * check-ins and shifts, they just cannot edit them afterwards.
 */
export async function insertOwned(
  table: string,
  row: Record<string, unknown>,
  auth: AuthInfo | null,
) {
  if (missingCreatedBy.has(table)) {
    return db.from(table).insert(row).select().single();
  }

  const stamped = { ...row, created_by: auth?.username ?? '' };
  const res = await db.from(table).insert(stamped).select().single();

  if (res.error && isMissingCreatedByError(res.error)) {
    missingCreatedBy.add(table);
    console.warn(
      `[ownership] ${table}.created_by is missing — run supabase/migration-part-timer.sql. ` +
      'Until then a part-timer can add rows, but may only edit or delete them ' +
      'while the same-day rule covers them.'
    );
    return db.from(table).insert(row).select().single();
  }
  return res;
}

/**
 * May `auth` modify row `id` of `table`?
 *
 * Admins always may. A part-timer may when the row carries their own username,
 * or when it is one of today's rows on a table that opts into the same-day rule.
 * Anything else is refused, including a pre-migration row (`created_by` null) on
 * a past date, which cannot be attributed to anyone.
 */
export async function canModifyRow(
  table: string,
  id: string,
  auth: AuthInfo | null,
): Promise<boolean> {
  if (!auth) return false;
  if (auth.role === 'admin') return true;

  const dateColumn = sameDayDateColumn[table];

  // No ownership column and no same-day rule leaves nothing that could pass.
  if (missingCreatedBy.has(table) && !dateColumn) return false;

  const columns = [
    missingCreatedBy.has(table) ? null : 'created_by',
    dateColumn,
  ].filter(Boolean).join(', ');

  let { data, error } = await db.from(table).select(columns).eq('id', id).single();

  // First check against a database that never ran the migration: drop the
  // column and ask again, so the same-day rule still gets its say.
  if (error && isMissingCreatedByError(error)) {
    missingCreatedBy.add(table);
    if (!dateColumn) return false;
    ({ data, error } = await db.from(table).select(dateColumn).eq('id', id).single());
  }
  if (error || !data) return false;

  const row = data as Record<string, unknown>;
  if (row.created_by && row.created_by === auth.username) return true;
  return !!dateColumn && row[dateColumn] === gymToday();
}
