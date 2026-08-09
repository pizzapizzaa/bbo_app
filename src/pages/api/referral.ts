export const prerender = false;

import type { APIRoute } from 'astro';
import { db } from '../../lib/db';
import { ok, serverError } from '../../lib/auth';
import {
  escapeLike, normalizeReferralCode, isValidReferralCode, referralCodesMatch, namesMatch,
} from '../../lib/validate';

/** GET /api/referral?code=BBO-1234[&customer=<full name>]
 *  Looks up a referral code so the check-in form can show the owner and the
 *  discount before submitting. `customer` is optional and only used to warn
 *  early about self-referral — POST /api/checkins enforces it regardless.
 *
 *  Always 200; `valid` says whether the code can be used. */
export const GET: APIRoute = async ({ url }) => {
  try {
    const code     = normalizeReferralCode(url.searchParams.get('code') ?? '');
    const customer = (url.searchParams.get('customer') ?? '').trim();

    if (!code) return ok({ valid: false, error: 'Enter a referral code.' });
    if (!isValidReferralCode(code)) {
      return ok({ valid: false, error: 'Codes are 3–20 letters, numbers or dashes.' });
    }

    const { data: owner, error } = await db
      .from('customers')
      .select('id, full_name, referral_code, referral_discount_pct')
      .ilike('referral_code', escapeLike(code))
      .limit(1)
      .maybeSingle();

    if (error) return serverError(error.message);
    // Exact (case-insensitive) match required — a pattern match is not enough.
    if (!owner || !referralCodesMatch(owner.referral_code, code)) {
      return ok({ valid: false, error: 'Referral code not found.' });
    }
    if (customer && namesMatch(owner.full_name, customer)) {
      return ok({ valid: false, error: 'A customer cannot use their own referral code.' });
    }

    return ok({
      valid:        true,
      code:         owner.referral_code,
      owner_id:     owner.id,
      owner_name:   owner.full_name ?? '',
      discount_pct: owner.referral_discount_pct ?? 0,
    });
  } catch (e: any) { return serverError(e?.message ?? String(e)); }
};
