export const prerender = false;

import type { APIRoute } from 'astro';
import { ok, serverError } from '../../lib/auth';
import { lookupReferralCode } from '../../lib/referral';
import { namesMatch } from '../../lib/validate';

/** GET /api/referral?code=BBO-1234[&customer=<full name>]
 *  Looks up a referral or promo code so the check-in form can show who it
 *  belongs to and the discount before submitting. `customer` is optional and
 *  only used to warn early about self-referral — POST /api/checkins enforces
 *  it regardless.
 *
 *  Always 200; `valid` says whether the code can be used. */
export const GET: APIRoute = async ({ url }) => {
  try {
    const customer = (url.searchParams.get('customer') ?? '').trim();
    const result   = await lookupReferralCode(url.searchParams.get('code') ?? '');

    if (result.status !== 'ok') return ok({ valid: false, error: result.error });

    const code = result.code;
    // Universal promo codes have no owner, so self-referral cannot apply.
    if (code.owner_id && customer && namesMatch(code.owner_name, customer)) {
      return ok({ valid: false, error: 'A customer cannot use their own referral code.' });
    }

    return ok({
      valid:               true,
      code:                code.code,
      code_id:             code.id,
      kind:                code.owner_id ? 'referral' : 'promo',
      owner_id:            code.owner_id,
      owner_name:          code.owner_name,
      label:               code.label,
      discount_pct:        code.discount_pct,
      rental_discount_pct: code.rental_discount_pct,
    });
  } catch (e: any) { return serverError(e?.message ?? String(e)); }
};
