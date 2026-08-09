export const prerender = false;

import type { APIRoute } from 'astro';
import { db } from '../../../lib/db';
import { ok, serverError } from '../../../lib/auth';
import {
  isValidUUID, escapeLike,
  normalizeReferralCode, isValidReferralCode, isValidReferralPct, referralCodesMatch,
} from '../../../lib/validate';

/** PATCH /api/customers/:id — update punch card, membership and/or referral info */
export const PATCH: APIRoute = async ({ params, request }) => {
  try {
    const { id } = params;
    if (!id || !isValidUUID(id)) return new Response(JSON.stringify({ error: 'Invalid id' }), { status: 400 });

    let body: {
      is_punch_card_holder?: boolean;
      punches_remaining?: number;
      pt_punches_remaining?: number;
      membership_type?: string;
      membership_start_date?: string | null;
      membership_end_date?: string | null;
      referral_code?: string | null;
      referral_discount_pct?: number;
    };
    try { body = await request.json(); }
    catch { return new Response(JSON.stringify({ error: 'Invalid JSON' }), { status: 400 }); }

    const updates: Record<string, any> = {};

    // Punch card fields
    if ('is_punch_card_holder' in body) {
      const isPunchCardHolder = Boolean(body.is_punch_card_holder);
      updates.is_punch_card_holder = isPunchCardHolder;
      updates.punches_remaining    = isPunchCardHolder
        ? Math.max(0, Math.floor(Number(body.punches_remaining) || 0))
        : 0;
    }

    // PT punch field
    if ('pt_punches_remaining' in body) {
      updates.pt_punches_remaining = Math.max(0, Math.floor(Number(body.pt_punches_remaining) || 0));
    }

    // Membership fields
    if ('membership_type' in body) {
      const mType = (body.membership_type ?? '').trim();
      const VALID_TYPES = ['', '1 Month', '3 Months', '6 Months', '12 Months'];
      if (!VALID_TYPES.includes(mType)) {
        return new Response(JSON.stringify({ error: 'Invalid membership type' }), { status: 400 });
      }
      updates.membership_type = mType;

      if (!mType) {
        updates.membership_start_date = null;
        updates.membership_end_date   = null;
      } else {
        const startStr = body.membership_start_date ?? '';
        if (!startStr) {
          return new Response(JSON.stringify({ error: 'membership_start_date is required' }), { status: 400 });
        }
        const start = new Date(startStr);
        if (isNaN(start.getTime())) {
          return new Response(JSON.stringify({ error: 'Invalid membership_start_date' }), { status: 400 });
        }
        const MONTHS: Record<string, number> = { '1 Month': 1, '3 Months': 3, '6 Months': 6, '12 Months': 12 };
        const end = new Date(start);
        end.setMonth(end.getMonth() + MONTHS[mType]);
        updates.membership_start_date = start.toISOString().slice(0, 10);
        updates.membership_end_date   = end.toISOString().slice(0, 10);
      }
    }

    // Referral code fields. Sending an empty code revokes the customer's code
    // (and clears the percentage with it) — a code without a discount is useless.
    if ('referral_code' in body) {
      const code = normalizeReferralCode(body.referral_code ?? '');
      if (!code) {
        updates.referral_code         = '';
        updates.referral_discount_pct = 0;
      } else {
        if (!isValidReferralCode(code)) {
          return new Response(JSON.stringify({
            error: 'Referral code must be 3–20 characters using letters, numbers or dashes.',
          }), { status: 400 });
        }
        const pct = Math.round(Number(body.referral_discount_pct));
        if (!isValidReferralPct(pct)) {
          return new Response(JSON.stringify({
            error: 'Referral discount must be a whole number between 1 and 100.',
          }), { status: 400 });
        }
        // Codes are unique across customers (case-insensitively).
        const { data: clash } = await db
          .from('customers')
          .select('id, full_name, referral_code')
          .ilike('referral_code', escapeLike(code))
          .neq('id', id)
          .limit(1)
          .maybeSingle();
        if (clash && referralCodesMatch(clash.referral_code, code)) {
          return new Response(JSON.stringify({
            error: `That code is already assigned to ${clash.full_name || 'another customer'}.`,
          }), { status: 409 });
        }
        updates.referral_code         = code;
        updates.referral_discount_pct = pct;
      }
    } else if ('referral_discount_pct' in body) {
      const pct = Math.round(Number(body.referral_discount_pct));
      if (!isValidReferralPct(pct)) {
        return new Response(JSON.stringify({
          error: 'Referral discount must be a whole number between 1 and 100.',
        }), { status: 400 });
      }
      updates.referral_discount_pct = pct;
    }

    if (Object.keys(updates).length === 0) {
      return new Response(JSON.stringify({ error: 'No fields to update' }), { status: 400 });
    }

    const { data, error } = await db
      .from('customers')
      .update(updates)
      .eq('id', id)
      .select('id, is_punch_card_holder, punches_remaining, pt_punches_remaining, membership_type, membership_start_date, membership_end_date, referral_code, referral_discount_pct')
      .single();

    if (error) {
      // 23505 = unique violation on idx_customers_referral_code (race with a
      // concurrent assignment that slipped past the check above).
      if (error.code === '23505') {
        return new Response(JSON.stringify({ error: 'That referral code is already taken.' }), { status: 409 });
      }
      if (error.code === '42703' || error.message?.includes('is_punch_card_holder') || error.message?.includes('membership_type') || error.message?.includes('referral_code')) {
        return new Response(JSON.stringify({ error: 'Required columns not found. Please run the database migration first.' }), { status: 400 });
      }
      return serverError(error.message);
    }
    return ok({ row: data });
  } catch (e: any) { return serverError(e?.message ?? String(e)); }
};

/** DELETE /api/customers/:id */
export const DELETE: APIRoute = async ({ params }) => {
  try {
    const { id } = params;
    if (!id || !isValidUUID(id)) return new Response(JSON.stringify({ error: 'Invalid id' }), { status: 400 });

    const { error } = await db
      .from('customers')
      .delete()
      .eq('id', id);

    if (error) return serverError(error.message);
    return ok({ success: true });
  } catch (e: any) { return serverError(e?.message ?? String(e)); }
};
