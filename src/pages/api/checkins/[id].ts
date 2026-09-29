export const prerender = false;

import type { APIRoute } from 'astro';
import { db } from '../../../lib/db';
import { authFromRequest, forbidden, ok, serverError, unauthorized } from '../../../lib/auth';
import { canModifyRow } from '../../../lib/ownership';
import {
  isValidUUID, isValidDate, isValidTime, MAX_NAME, MAX_TEXT, escapeLike,
  normalizeReferralCode, namesMatch,
} from '../../../lib/validate';
import { lookupReferralCode } from '../../../lib/referral';
import {
  computeCheckinAmount, describeCheckinExtras,
  isKnownCheckinType, isKnownAddon, isKnownDiscount, grantsBalance,
} from '../../../lib/pricing';

const badRequest = (error: string) =>
  new Response(JSON.stringify({ error }), { status: 400 });

/** Move a customer's punch balance by `delta`, never below zero. */
async function adjustPunches(
  holderId: string,
  column: 'punches_remaining' | 'pt_punches_remaining',
  delta: number,
): Promise<void> {
  const { data: holder } = await db
    .from('customers')
    .select(column)
    .eq('id', holderId)
    .single();
  if (!holder) return;

  const current = (holder as Record<string, number | null>)[column] ?? 0;
  // A refund always lands; a deduction is skipped when there is nothing to take,
  // matching how POST declines to push a balance negative.
  if (delta < 0 && current <= 0) return;
  await db
    .from('customers')
    .update({ [column]: Math.max(0, current + delta) })
    .eq('id', holderId);
}

/** DELETE /api/checkins/:id */
export const DELETE: APIRoute = async ({ params, request }) => {
  const { id } = params;
  if (!id || !isValidUUID(id)) return new Response(JSON.stringify({ error: 'Invalid id' }), { status: 400 });

  // Admins may delete any check-in; part-timers their own and any of today's.
  const auth = await authFromRequest(request);
  if (!auth) return unauthorized();
  if (!await canModifyRow('checkins', id, auth)) {
    return forbidden("You can only delete today's check-ins, or ones you logged yourself.");
  }

  // Fetch the check-in first so we can revert any punch deduction
  const { data: checkin, error: fetchError } = await db
    .from('checkins')
    .select('punch_card_holder_id, pt_punch_holder_id')
    .eq('id', id)
    .single();

  if (fetchError) return serverError(fetchError.message);

  // Delete the check-in record
  const { error } = await db
    .from('checkins')
    .delete()
    .eq('id', id);

  if (error) return serverError(error.message);

  // Hand back whichever punch this check-in spent
  if (checkin?.punch_card_holder_id) {
    await adjustPunches(checkin.punch_card_holder_id, 'punches_remaining', +1);
  }
  if (checkin?.pt_punch_holder_id) {
    await adjustPunches(checkin.pt_punch_holder_id, 'pt_punches_remaining', +1);
  }

  return ok({ success: true });
};

/**
 * PUT /api/checkins/:id — correct a check-in that was logged wrongly.
 *
 * A replace, not a merge: the caller sends the same shape POST takes, and the row
 * is re-derived from it. In particular the amount is re-priced here off the
 * submitted date, product and add-ons, so an edit cannot smuggle in a figure the
 * price list would not produce — the one exception being `amount_override`, the
 * same deliberate escape hatch POST offers. Fields the caller omits are cleared,
 * so the form has to send back everything it loaded.
 *
 * What an edit deliberately cannot do is move a sale that credited a customer
 * account — punches, PT punches, membership months. Nothing on the row records
 * what was granted (a membership folds its months into one end date), so the
 * grant cannot be recomputed and taken back. Those sales are corrected by
 * deleting and re-entering them instead; `grantsBalance` draws the line.
 */
export const PUT: APIRoute = async ({ params, request }) => {
  const { id } = params;
  if (!id || !isValidUUID(id)) return badRequest('Invalid id');

  // Admins may edit any check-in; part-timers their own and any of today's.
  const auth = await authFromRequest(request);
  if (!auth) return unauthorized();
  if (!await canModifyRow('checkins', id, auth)) {
    return forbidden("You can only edit today's check-ins, or ones you logged yourself.");
  }

  let body: {
    customer_name: string;
    date: string;
    time: string;
    payment_method: string;
    amount?: number;
    amount_override?: boolean;
    notes?: string;
    punch_card_holder_id?: string;
    punch_card_holder_name?: string;
    pt_punch_holder_id?: string;
    pt_punch_holder_name?: string;
    checkin_type?: string;
    addons?: string[];
    discount?: string;
    referral_code?: string;
  };
  try { body = await request.json(); }
  catch { return badRequest('Invalid JSON'); }

  const { customer_name, date, time, payment_method, amount, amount_override, notes,
          punch_card_holder_id, punch_card_holder_name,
          pt_punch_holder_id, pt_punch_holder_name,
          checkin_type, addons, discount, referral_code } = body;

  if (!customer_name || !date || !time || !payment_method) {
    return badRequest('Missing required fields');
  }
  if (String(customer_name).length > MAX_NAME)  return badRequest('customer_name too long');
  if (!isValidDate(date))                       return badRequest('Invalid date format (expected YYYY-MM-DD)');
  if (!isValidTime(time.slice(0, 5)))           return badRequest('Invalid time format (expected HH:MM)');
  if ((notes ?? '').length > MAX_TEXT)          return badRequest('notes exceeds maximum length');

  // ── Priceable inputs ──
  // Same refusal POST makes: a joined display string cannot be re-priced, and
  // guessing would over- or undercharge a real customer.
  if (typeof addons === 'string' && addons) {
    return badRequest('This page is out of date. Reload the check-in page and enter the visit again.');
  }
  const addonNames = Array.isArray(addons) ? addons.map(String) : [];
  const unknownAddon = addonNames.find((a) => !isKnownAddon(a));
  if (unknownAddon) return badRequest(`Unknown add-on: ${unknownAddon}`);
  if (checkin_type && !isKnownCheckinType(checkin_type)) {
    return badRequest(`Unknown check-in type: ${checkin_type}`);
  }
  const discountId = String(discount ?? '');
  if (!isKnownDiscount(discountId)) return badRequest(`Unknown discount: ${discountId}`);

  // ── The row as it stands ──
  const { data: existing, error: fetchError } = await db
    .from('checkins')
    .select('customer_name, date, checkin_type, punch_card_holder_id, pt_punch_holder_id')
    .eq('id', id)
    .single();

  // PostgREST reports "no rows" from .single() as PGRST116, which is a 404 here
  // rather than a fault — the row was deleted while the form sat open.
  const notFound = fetchError?.code === 'PGRST116' || (!fetchError && !existing);
  if (notFound)   return new Response(JSON.stringify({ error: 'That check-in no longer exists.' }), { status: 404 });
  if (fetchError) return serverError(fetchError.message);

  // ── Guard the sales whose side effects cannot be undone ──
  const wasGrant = grantsBalance(existing.checkin_type ?? '');
  const nowGrant = grantsBalance(checkin_type ?? '');
  if (wasGrant || nowGrant) {
    // The buyer, the product and the date are exactly what decided the credit —
    // the date because a promotion running that day tops a card up beyond its
    // face value. Everything else on the sale stays editable.
    const moved =
      (checkin_type ?? '') !== (existing.checkin_type ?? '') ||
      !namesMatch(existing.customer_name, customer_name) ||
      date !== existing.date;
    if (moved) {
      return badRequest(
        'This check-in sold punches or a membership, so the customer, product and date ' +
        'cannot be changed — the punches or months already credited cannot be taken back. ' +
        'Delete this entry and add it again instead.'
      );
    }
  }

  // Validate membership when payment is "Valid Membership"
  if (payment_method === 'Valid Membership') {
    const { data: memberData } = await db
      .from('customers')
      .select('membership_type, membership_end_date')
      .ilike('full_name', escapeLike(customer_name))
      .limit(1)
      .single();

    if (!memberData || !memberData.membership_type) {
      return badRequest('Customer has no active membership.');
    }
    if (!memberData.membership_end_date || memberData.membership_end_date < date) {
      return badRequest('Membership has expired.');
    }
  }

  // ── Referral / promo code ──
  // Re-resolved rather than carried over, so a code since deactivated stops
  // discounting. Lookup records no redemption, so re-running it costs nothing.
  const referralCode = normalizeReferralCode(referral_code ?? '');
  let referredById:  string | null = null;
  let referredByName = '';
  let referralTerms: { discount_pct: number; rental_discount_pct: number } | null = null;

  let effectiveDiscount = discountId;
  if (referralCode && discountId === '') effectiveDiscount = 'referral';
  if (referralCode && effectiveDiscount !== 'referral') {
    return badRequest('A referral code cannot be combined with another discount — only one discount applies per check-in.');
  }
  if (!referralCode && effectiveDiscount === 'referral') {
    return badRequest('Enter a referral or promo code, or choose a different discount.');
  }

  if (referralCode) {
    const lookup = await lookupReferralCode(referralCode);
    if (lookup.status === 'invalid') return badRequest('Invalid referral code format.');
    if (lookup.status !== 'ok')      return badRequest(lookup.error);

    const owner = lookup.code;
    if (owner.owner_id && namesMatch(owner.owner_name, customer_name)) {
      return badRequest('A customer cannot use their own referral code.');
    }
    referredById   = owner.owner_id;
    referredByName = owner.owner_name;
    referralTerms  = {
      discount_pct:        owner.discount_pct,
      rental_discount_pct: owner.rental_discount_pct,
    };
  }

  // ── Re-price the visit ──
  const price = computeCheckinAmount({
    date,
    checkin_type: checkin_type ?? '',
    addons:       addonNames,
    discount:     effectiveDiscount,
    referral:     referralTerms,
    payment_method,
  });

  const overrideAmount = amount_override === true && Number.isFinite(Number(amount))
    ? Math.max(0, Math.round(Number(amount)))
    : null;
  const finalAmount = overrideAmount ?? price.amount;

  const extras = describeCheckinExtras(addonNames, price);
  const addonsTrail = overrideAmount !== null && overrideAmount !== price.amount
    ? [extras, `Manual amount (price list: ${price.amount.toLocaleString('en-US')} ₫)`].filter(Boolean).join(', ')
    : extras;

  const newPunchHolder   = punch_card_holder_id || null;
  const newPtPunchHolder = pt_punch_holder_id   || null;

  // `created_by` is untouched on purpose: the row keeps naming whoever first
  // logged it, so a same-day fix by a colleague does not rewrite its authorship.
  const { data, error } = await db
    .from('checkins')
    .update({
      customer_name,
      date,
      time,
      payment_method,
      amount: finalAmount,
      notes: notes ?? '',
      punch_card_holder_id:   newPunchHolder,
      punch_card_holder_name: punch_card_holder_name || '',
      pt_punch_holder_id:     newPtPunchHolder,
      pt_punch_holder_name:   pt_punch_holder_name || '',
      checkin_type: checkin_type ?? '',
      addons:       addonsTrail,
      referral_code:         referralCode,
      referred_by_id:        referredById,
      referred_by_name:      referredByName,
      referral_discount_pct: referralCode ? price.base_discount_pct : 0,
    })
    .eq('id', id)
    .select()
    .single();

  if (error) return serverError(error.message);

  // ── Move the punch deduction to whoever now pays for the visit ──
  // Only a changed holder touches a balance; re-saving the same one must not
  // charge a second punch.
  const oldPunchHolder   = existing.punch_card_holder_id ?? null;
  const oldPtPunchHolder = existing.pt_punch_holder_id   ?? null;

  if (oldPunchHolder !== newPunchHolder) {
    if (oldPunchHolder) await adjustPunches(oldPunchHolder, 'punches_remaining', +1);
    if (newPunchHolder) await adjustPunches(newPunchHolder, 'punches_remaining', -1);
  }
  if (oldPtPunchHolder !== newPtPunchHolder) {
    if (oldPtPunchHolder) await adjustPunches(oldPtPunchHolder, 'pt_punches_remaining', +1);
    if (newPtPunchHolder) await adjustPunches(newPtPunchHolder, 'pt_punches_remaining', -1);
  }

  return ok({
    checkin: data,
    price: { ...price, charged: finalAmount, overridden: overrideAmount !== null },
  });
};
