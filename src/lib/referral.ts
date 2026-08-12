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
  id:           string;
  code:         string;
  discount_pct: number;
  owner_id:     string | null;
  owner_name:   string;   // '' for universal promo codes
  label:        string;
  is_active:    boolean;
}

export type ReferralLookup =
  | { status: 'ok';                                  code: ReferralCode }
  | { status: 'invalid' | 'not_found' | 'inactive';  error: string };

/**
 * Resolve a quoted code to its row plus the owner's name.
 * Throws on a database error so callers can fall through to serverError().
 */
export async function lookupReferralCode(raw: string): Promise<ReferralLookup> {
  const code = normalizeReferralCode(raw ?? '');
  if (!code)                     return { status: 'invalid', error: 'Enter a referral or promo code.' };
  if (!isValidReferralCode(code)) return { status: 'invalid', error: 'Codes are 3–20 letters, numbers or dashes.' };

  const { data: row, error } = await db
    .from('referral_codes')
    .select('id, code, discount_pct, owner_id, label, is_active')
    .ilike('code', escapeLike(code))
    .limit(1)
    .maybeSingle();

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
      id:           row.id,
      code:         normalizeReferralCode(row.code),
      discount_pct: row.discount_pct ?? 0,
      owner_id:     row.owner_id ?? null,
      owner_name:   ownerName,
      label:        row.label ?? '',
      is_active:    true,
    },
  };
}
