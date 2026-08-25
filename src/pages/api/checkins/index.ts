export const prerender = false;

import type { APIRoute } from 'astro';
import { db } from '../../../lib/db';
import { authFromRequest, ok, serverError } from '../../../lib/auth';
import { insertOwned } from '../../../lib/ownership';
import { fetchAllPages } from '../../../lib/paginate';
import {
  isValidDate, isValidTime, MAX_NAME, MAX_TEXT, escapeLike,
  normalizeReferralCode, namesMatch,
} from '../../../lib/validate';
import { lookupReferralCode } from '../../../lib/referral';
import {
  computeCheckinAmount, describeCheckinExtras,
  isKnownCheckinType, isKnownAddon, isKnownDiscount,
} from '../../../lib/pricing';

/** GET /api/checkins?date=YYYY-MM-DD          — single date
 *  GET /api/checkins?from=YYYY-MM-DD&to=YYYY-MM-DD — inclusive date range */
export const GET: APIRoute = async ({ url }) => {
  const date = url.searchParams.get('date');
  const from = url.searchParams.get('from');
  const to   = url.searchParams.get('to');

  // Validate date params to prevent unexpected query behaviour
  if (date && !isValidDate(date)) {
    return new Response(JSON.stringify({ error: 'Invalid date format' }), { status: 400 });
  }
  if ((from && !isValidDate(from)) || (to && !isValidDate(to))) {
    return new Response(JSON.stringify({ error: 'Invalid from/to date format' }), { status: 400 });
  }

  let query = db
    .from('checkins')
    .select('*')
    .order('date',          { ascending: true })
    .order('checked_in_at', { ascending: true });

  if (date) {
    query = query.eq('date', date);
  } else if (from && to) {
    query = query.gte('date', from).lte('date', to);
  } else {
    return new Response(JSON.stringify({ error: 'Missing date or from/to range' }), { status: 400 });
  }

  const { data, error } = await fetchAllPages((from, to) => (query as any).range(from, to));
  if (error) return serverError(error.message);
  return ok({ checkins: data });
};

/** POST /api/checkins — add a new check-in.
 *
 *  The caller sends what was bought, not what it costs: `checkin_type`, an
 *  `addons` array of product names, the `discount` picked and any `referral_code`
 *  quoted. src/lib/pricing.ts turns those into the amount that is banked, so the
 *  price list and the discount rules are enforced here rather than trusted from
 *  the browser. `amount` in the body is ignored unless `amount_override` is set,
 *  which is the one way staff can bill a figure the price list would not produce.
 */
export const POST: APIRoute = async ({ request }) => {
  let body: {
    customer_name: string;
    date: string;
    time: string;
    payment_method: string;
    /** Only honoured alongside amount_override; otherwise the till decides. */
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
  catch { return new Response(JSON.stringify({ error: 'Invalid JSON' }), { status: 400 }); }

  const { customer_name, date, time, payment_method, amount, amount_override, notes,
          punch_card_holder_id, punch_card_holder_name,
          pt_punch_holder_id, pt_punch_holder_name,
          checkin_type, addons, discount, referral_code } = body;
  if (!customer_name || !date || !time || !payment_method) {
    return new Response(JSON.stringify({ error: 'Missing required fields' }), { status: 400 });
  }
  if (String(customer_name).length > MAX_NAME) {
    return new Response(JSON.stringify({ error: 'customer_name too long' }), { status: 400 });
  }
  if (!isValidDate(date)) {
    return new Response(JSON.stringify({ error: 'Invalid date format (expected YYYY-MM-DD)' }), { status: 400 });
  }
  if (!isValidTime(time.slice(0, 5))) {
    return new Response(JSON.stringify({ error: 'Invalid time format (expected HH:MM)' }), { status: 400 });
  }
  if ((notes ?? '').length > MAX_TEXT) {
    return new Response(JSON.stringify({ error: 'notes exceeds maximum length' }), { status: 400 });
  }

  // ── Priceable inputs ──
  // A client that predates server-side pricing sends `addons` as the joined
  // display string, discount labels and all. There is no way to price that
  // reliably, and guessing would undercharge or overcharge a real customer, so
  // say plainly what is wrong instead.
  if (typeof addons === 'string' && addons) {
    return new Response(JSON.stringify({
      error: 'This page is out of date. Reload the check-in page and enter the visit again.',
    }), { status: 400 });
  }
  const addonNames = Array.isArray(addons) ? addons.map(String) : [];
  const unknownAddon = addonNames.find((a) => !isKnownAddon(a));
  if (unknownAddon) {
    return new Response(JSON.stringify({ error: `Unknown add-on: ${unknownAddon}` }), { status: 400 });
  }
  if (checkin_type && !isKnownCheckinType(checkin_type)) {
    return new Response(JSON.stringify({ error: `Unknown check-in type: ${checkin_type}` }), { status: 400 });
  }
  const discountId = String(discount ?? '');
  if (!isKnownDiscount(discountId)) {
    return new Response(JSON.stringify({ error: `Unknown discount: ${discountId}` }), { status: 400 });
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
      return new Response(JSON.stringify({ error: 'Customer has no active membership.' }), { status: 400 });
    }
    if (!memberData.membership_end_date || memberData.membership_end_date < date) {
      return new Response(JSON.stringify({ error: 'Membership has expired.' }), { status: 400 });
    }
  }

  // ── Referral / promo code: resolve it and record the redemption ──
  // The code may be quoted on every visit. A code owned by a customer is
  // rejected for that customer's own check-in; a universal promo code
  // (owner_id = null) has no owner and so no such restriction.
  const referralCode = normalizeReferralCode(referral_code ?? '');
  let referredById:  string | null = null;
  let referredByName = '';
  let referralTerms: { discount_pct: number; rental_discount_pct: number } | null = null;

  // The code and the radio have to agree. A code quoted with no discount picked
  // is the ordinary case from an older payload, so it is read as the intent it
  // plainly is; a code quoted alongside a *different* discount is a contradiction
  // the server cannot resolve on the customer's behalf.
  let effectiveDiscount = discountId;
  if (referralCode && discountId === '') effectiveDiscount = 'referral';
  if (referralCode && effectiveDiscount !== 'referral') {
    return new Response(JSON.stringify({
      error: 'A referral code cannot be combined with another discount — only one discount applies per check-in.',
    }), { status: 400 });
  }
  if (!referralCode && effectiveDiscount === 'referral') {
    return new Response(JSON.stringify({ error: 'Enter a referral or promo code, or choose a different discount.' }), { status: 400 });
  }

  if (referralCode) {
    const lookup = await lookupReferralCode(referralCode);
    if (lookup.status === 'invalid') {
      return new Response(JSON.stringify({ error: 'Invalid referral code format.' }), { status: 400 });
    }
    if (lookup.status !== 'ok') {
      return new Response(JSON.stringify({ error: lookup.error }), { status: 400 });
    }
    const owner = lookup.code;
    if (owner.owner_id && namesMatch(owner.owner_name, customer_name)) {
      return new Response(JSON.stringify({ error: 'A customer cannot use their own referral code.' }), { status: 400 });
    }
    referredById   = owner.owner_id;
    referredByName = owner.owner_name;
    // Read from the code row, never from the request — a quoted code buys the
    // discount the gym set on it, whatever percentage the caller claims.
    referralTerms = {
      discount_pct:        owner.discount_pct,
      rental_discount_pct: owner.rental_discount_pct,
    };
  }

  // ── Price the visit ──
  // Everything above is an input; this is the only place an amount is decided.
  const price = computeCheckinAmount({
    date,
    checkin_type: checkin_type ?? '',
    addons:       addonNames,
    discount:     effectiveDiscount,
    referral:     referralTerms,
  });

  // Staff may still bill a figure the price list would not produce — a goodwill
  // adjustment, a part payment — but it has to be asked for, and the row says so.
  const overrideAmount = amount_override === true && Number.isFinite(Number(amount))
    ? Math.max(0, Math.round(Number(amount)))
    : null;
  const finalAmount = overrideAmount ?? price.amount;

  const extras = describeCheckinExtras(addonNames, price);
  const addonsTrail = overrideAmount !== null && overrideAmount !== price.amount
    ? [extras, `Manual amount (price list: ${price.amount.toLocaleString('en-US')} ₫)`].filter(Boolean).join(', ')
    : extras;

  const { data, error } = await insertOwned('checkins', {
    customer_name,
    date,
    time,
    payment_method,
    amount: finalAmount,
    notes: notes ?? '',
    punch_card_holder_id:   punch_card_holder_id   || null,
    punch_card_holder_name: punch_card_holder_name || '',
    pt_punch_holder_id:     pt_punch_holder_id     || null,
    pt_punch_holder_name:   pt_punch_holder_name   || '',
    checkin_type: checkin_type ?? '',
    addons:       addonsTrail,
    referral_code:         referralCode,
    referred_by_id:        referredById,
    referred_by_name:      referredByName,
    referral_discount_pct: referralCode ? price.base_discount_pct : 0,
  }, await authFromRequest(request));

  if (error) return serverError(error.message);

  // Auto-create a customer record if this name doesn't exist yet
  // Skip placeholder names that are not real customers
  const NON_CUSTOMER_NAMES = ['Other', 'New Customer'];
  if (!NON_CUSTOMER_NAMES.includes(customer_name)) {
    const { data: existing } = await db
      .from('customers')
      .select('id')
      .ilike('full_name', escapeLike(customer_name))
      .limit(1)
      .maybeSingle();

    if (!existing) {
      await db.from('customers').insert({ full_name: customer_name });
    }
  }

  // ── Punch card purchase: add punches to the buyer's account ──
  const PUNCH_ADDS: Record<string, number> = {
    '10 Punches – Adult':   10,
    '10 Punches – Student': 10,
    '10 Punches – Kid':     10,
    '20 Punches – Adult':   20,
  };

  // ── PT punch purchase: add PT punches to the buyer's account ──
  const PT_PUNCH_ADDS: Record<string, number> = {
    '10 PT Punches – Shingo PT': 10,
    '10 PT Punches – Other PT':  10,
  };
  const MEMBERSHIP_TYPE_MAP: Record<string, string> = {
    'Membership – 1 Month':   '1 Month',
    'Membership – 3 Months':  '3 Months',
    'Membership – 6 Months':  '6 Months',
    'Membership – 12 Months': '12 Months',
  };
  const MONTHS_TO_ADD: Record<string, number> = {
    '1 Month': 1, '3 Months': 3, '6 Months': 6, '12 Months': 12,
  };

  // A promotion running on the check-in date tops the card up beyond its face
  // value (National Day: a 10-punch card is worth 12). `price` already resolved
  // it off the submitted date, not "today", so a backdated entry grants what the
  // promo gave that day. The face value must be non-zero first, so a bonus can
  // never conjure punches for a product that is not a punch card.
  const faceValuePunches = checkin_type ? (PUNCH_ADDS[checkin_type] ?? 0) : 0;
  const punchesToAdd  = faceValuePunches > 0
    ? faceValuePunches + price.promo_bonus_punches
    : 0;
  const ptPunchesToAdd = checkin_type ? (PT_PUNCH_ADDS[checkin_type] ?? 0) : 0;
  const newMemberType = checkin_type ? (MEMBERSHIP_TYPE_MAP[checkin_type] ?? '') : '';

  if (punchesToAdd > 0 || ptPunchesToAdd > 0 || newMemberType) {
    const { data: cust } = await db
      .from('customers')
      .select('id, punches_remaining, pt_punches_remaining, membership_end_date')
      .ilike('full_name', escapeLike(customer_name))
      .limit(1)
      .maybeSingle();

    if (cust) {
      if (punchesToAdd > 0) {
        await db.from('customers').update({
          is_punch_card_holder: true,
          punches_remaining: (cust.punches_remaining ?? 0) + punchesToAdd,
        }).eq('id', cust.id);
      }

      if (ptPunchesToAdd > 0) {
        await db.from('customers').update({
          pt_punches_remaining: (cust.pt_punches_remaining ?? 0) + ptPunchesToAdd,
        }).eq('id', cust.id);
      }

      if (newMemberType) {
        const checkinDay  = new Date(date);
        const existingEnd = cust.membership_end_date ? new Date(cust.membership_end_date) : null;
        // Stack onto existing membership if still active, otherwise start from check-in date
        const startDate   = (existingEnd && existingEnd > checkinDay) ? existingEnd : checkinDay;
        const endDate     = new Date(startDate);
        endDate.setMonth(endDate.getMonth() + MONTHS_TO_ADD[newMemberType]);
        await db.from('customers').update({
          membership_type:       newMemberType,
          membership_start_date: startDate.toISOString().slice(0, 10),
          membership_end_date:   endDate.toISOString().slice(0, 10),
        }).eq('id', cust.id);
      }
    }
  }

  // Deduct one punch from the punch card holder
  if (punch_card_holder_id) {
    const { data: holder } = await db
      .from('customers')
      .select('punches_remaining')
      .eq('id', punch_card_holder_id)
      .single();

    if (holder && holder.punches_remaining > 0) {
      await db
        .from('customers')
        .update({ punches_remaining: holder.punches_remaining - 1 })
        .eq('id', punch_card_holder_id);
    }
  }

  // Deduct one PT punch from the PT punch holder
  if (pt_punch_holder_id) {
    const { data: ptHolder } = await db
      .from('customers')
      .select('pt_punches_remaining')
      .eq('id', pt_punch_holder_id)
      .single();

    if (ptHolder && ptHolder.pt_punches_remaining > 0) {
      await db
        .from('customers')
        .update({ pt_punches_remaining: ptHolder.pt_punches_remaining - 1 })
        .eq('id', pt_punch_holder_id);
    }
  }

  // Hand back what was actually billed and why, so the form can show the till's
  // figure rather than trusting its own preview of it.
  return ok({
    checkin: data,
    price: { ...price, charged: finalAmount, overridden: overrideAmount !== null },
  });
};
