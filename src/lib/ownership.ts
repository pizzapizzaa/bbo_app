import { db } from './db';
import type { AuthInfo } from './auth';

/**
 * Row-level ownership for the two tables part-timers may write to
 * (`checkins`, `schedule_entries`).
 *
 * Admins are unrestricted — nothing here changes what an admin can do.
 * A part-timer may edit or delete only the rows they created, which is tracked
 * in a `created_by` column added by supabase/migration-part-timer.sql.
 *
 * That migration is a manual step, so every function here also has to behave
 * sensibly on a database where the column does not exist yet:
 *   • inserts retry without `created_by` (so check-in never breaks), and
 *   • ownership checks fail closed, leaving edit/delete admin-only.
 */

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
      'Part-timers can add rows but not edit or delete them until then.'
    );
    return db.from(table).insert(row).select().single();
  }
  return res;
}

/**
 * May `auth` modify row `id` of `table`?
 *
 * Admins always may. Part-timers may only touch rows stamped with their own
 * username — which excludes rows that predate the migration (`created_by` null
 * or absent), since those cannot be attributed to anyone.
 */
export async function canModifyRow(
  table: string,
  id: string,
  auth: AuthInfo | null,
): Promise<boolean> {
  if (!auth) return false;
  if (auth.role === 'admin') return true;
  if (missingCreatedBy.has(table)) return false;

  const { data, error } = await db.from(table).select('created_by').eq('id', id).single();

  if (error) {
    if (isMissingCreatedByError(error)) missingCreatedBy.add(table);
    return false;
  }
  return !!data?.created_by && data.created_by === auth.username;
}
