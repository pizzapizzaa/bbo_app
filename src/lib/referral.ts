/**
 * Referral / promo code lookup shared by the check-in form preview
 * (GET /api/referral) and the check-in itself (POST /api/checkins).
 *
 * A code row lives in `referral_codes`:
 *   owner_id NOT NULL → affiliated referral code owned by a customer
 *   owner_id NULL     → universal promo code owned by the gym
 *
 * Both kinds discount the check-in base price by `discount_pct`. Only owned
 * codes carry a self-referral restriction, which callers apply themselves
 * because only they know the customer being checked in.
 */

import { db } from './db';
import { escapeLike, normalizeReferralCode, isValidReferralCode, referralCodesMatch } from './validate';

export interface ReferralCode {
  id:                  string;
  code:                string;
  discount_pct:        number;
  rental_discount_pct: number;  // cut on the gear rental add-ons; 0 = full price
  owner_id:            string | null;
  owner_name:          string;  // '' for universal promo codes
  label:               string;
  is_active:           boolean;
}

export type ReferralLookup =
  | { status: 'ok';                                  code: ReferralCode }
  | { status: 'invalid' | 'not_found' | 'inactive';  error: string };

// ── rental_discount_pct compatibility ────────────────────────────────────────
/**
 * `referral_codes.rental_discount_pct` arrives with
 * supabase/migration-rental-discount.sql, which is a manual step. Until it is
 * run, Postgres rejects every statement naming the column with 42703, and
 * PostgREST rejects writes with PGRST204 before they reach the database.
 *
 * That is a single point of failure for three unrelated screens — the Promo
 * Codes page, the referral panel on a customer, and the check-in code lookup —
 * so the column is treated as optional rather than assumed. Queries ask for it;
 * the first database that says it does not exist flips the flag below, and the
 * statement is re-issued without it. The discount then reads as 0, i.e. gear
 * rentals bill in full, which is the default for every code anyway.
 *
 * Same bargain as `created_by` in ownership.ts: the feature degrades, the page
 * does not break.
 */
let rentalPctMissing = false;

/** Columns of `referral_codes` that always exist. */
const CODE_COLUMNS = 'id, code, discount_pct, owner_id, label, is_active';

/**
 * Column list for a `referral_codes` select, minus `rental_discount_pct` on a
 * database that lacks it. `extra` is appended verbatim (e.g. `'created_at'`).
 */
export function codeColumns(extra = ''): string {
  return CODE_COLUMNS
    + (rentalPctMissing ? '' : ', rental_discount_pct')
    + (extra ? ', ' + extra : '');
}

/**
 * Drop `rental_discount_pct` from an insert/update payload when the column is
 * absent. Reads the flag at call time, so a payload built inside
 * `withRentalPctFallback` is stripped automatically on the retry.
 */
export function codePayload<T extends Record<string, unknown>>(row: T): Record<string, unknown> {
  if (!rentalPctMissing) return row;
  const { rental_discount_pct, ...rest } = row;
  return rest;
}

function isMissingRentalPct(error: { code?: string; message?: string } | null): boolean {
  if (!error || rentalPctMissing) return false;
  const msg = error.message ?? '';
  if (!/rental_discount_pct/.test(msg)) return false;
  return error.code === '42703' || error.code === 'PGRST204' || /column/i.test(msg);
}

/**
 * Run a `referral_codes` statement, retrying once without
 * `rental_discount_pct` if the database turns out not to have it.
 *
 * `run` receives the column list to select and should build its payload with
 * `codePayload()`, so both halves of the statement drop the column together.
 */
export async function withRentalPctFallback<T extends { error: unknown }>(
  run: (columns: string) => PromiseLike<T>,
  extra = '',
): Promise<T> {
  const first = await run(codeColumns(extra));
  if (!isMissingRentalPct(first.error as { code?: string; message?: string } | null)) return first;

  rentalPctMissing = true;
  console.warn(
    '[referral] referral_codes.rental_discount_pct is missing — run ' +
    'supabase/migration-rental-discount.sql. Codes work, but gear rentals bill ' +
    'in full until then.'
  );
  return run(codeColumns(extra));
}

/**
 * Resolve a quoted code to its row plus the owner's name.
 * Throws on a database error so callers can fall through to serverError().
 */
export async function lookupReferralCode(raw: string): Promise<ReferralLookup> {
  const code = normalizeReferralCode(raw ?? '');
  if (!code)                     return { status: 'invalid', error: 'Enter a referral or promo code.' };
  if (!isValidReferralCode(code)) return { status: 'invalid', error: 'Codes are 3–20 letters, numbers or dashes.' };

  const { data: row, error } = await withRentalPctFallback((columns) => db
    .from('referral_codes')
    .select(columns)
    .ilike('code', escapeLike(code))
    .limit(1)
    .maybeSingle() as PromiseLike<{ data: any; error: any }>);

  if (error) throw new Error(error.message);
  // Exact (case-insensitive) match required — a pattern match is not enough to
  // bill a discount against someone else's code.
  if (!row || !referralCodesMatch(row.code, code)) {
    return { status: 'not_found', error: 'Referral or promo code not found.' };
  }
  if (!row.is_active) {
    return { status: 'inactive', error: 'That code is no longer active.' };
  }

  let ownerName = '';
  if (row.owner_id) {
    const { data: owner } = await db
      .from('customers')
      .select('full_name')
      .eq('id', row.owner_id)
      .limit(1)
      .maybeSingle();
    ownerName = owner?.full_name ?? '';
  }

  return {
    status: 'ok',
    code: {
      id:                  row.id,
      code:                normalizeReferralCode(row.code),
      discount_pct:        row.discount_pct ?? 0,
      rental_discount_pct: row.rental_discount_pct ?? 0,
      owner_id:            row.owner_id ?? null,
      owner_name:          ownerName,
      label:               row.label ?? '',
      is_active:           true,
    },
  };
}
