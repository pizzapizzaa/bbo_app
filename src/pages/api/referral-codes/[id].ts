export const prerender = false;

import type { APIRoute } from 'astro';
import { db } from '../../../lib/db';
import { adminOnly, ok, serverError } from '../../../lib/auth';
import {
  isValidUUID, escapeLike,
  normalizeReferralCode, isValidReferralCode, isValidReferralPct, isValidRentalPct,
  referralCodesMatch, normalizeCodeLabel,
} from '../../../lib/validate';

/** PATCH /api/referral-codes/:id — edit code, discount, label or active flag. */
export const PATCH: APIRoute = async ({ params, request }) => {
  const denied = await adminOnly(request);
  if (denied) return denied;

  try {
    const { id } = params;
    if (!id || !isValidUUID(id)) return new Response(JSON.stringify({ error: 'Invalid id' }), { status: 400 });

    let body: {
      code?: string;
      discount_pct?: number;
      rental_discount_pct?: number;
      label?: string;
      is_active?: boolean;
    };
    try { body = await request.json(); }
    catch { return new Response(JSON.stringify({ error: 'Invalid JSON' }), { status: 400 }); }

    const updates: Record<string, any> = {};

    if ('code' in body) {
      const code = normalizeReferralCode(body.code ?? '');
      if (!isValidReferralCode(code)) {
        return new Response(JSON.stringify({
          error: 'Code must be 3–20 characters using letters, numbers or dashes.',
        }), { status: 400 });
      }
      const { data: clash } = await db
        .from('referral_codes')
        .select('id, code')
        .ilike('code', escapeLike(code))
        .neq('id', id)
        .limit(1)
        .maybeSingle();
      if (clash && referralCodesMatch(clash.code, code)) {
        return new Response(JSON.stringify({ error: 'That code is already in use.' }), { status: 409 });
      }
      updates.code = code;
    }

    if ('discount_pct' in body) {
      const pct = Math.round(Number(body.discount_pct));
      if (!isValidReferralPct(pct)) {
        return new Response(JSON.stringify({
          error: 'Discount must be a whole number between 1 and 100.',
        }), { status: 400 });
      }
      updates.discount_pct = pct;
    }

    if ('rental_discount_pct' in body) {
      const rentalPct = Math.round(Number(body.rental_discount_pct));
      if (!isValidRentalPct(rentalPct)) {
        return new Response(JSON.stringify({
          error: 'Rental discount must be a whole number between 0 and 100.',
        }), { status: 400 });
      }
      updates.rental_discount_pct = rentalPct;
    }

    if ('label' in body)     updates.label     = normalizeCodeLabel(body.label ?? '');
    if ('is_active' in body) updates.is_active = Boolean(body.is_active);

    if (Object.keys(updates).length === 0) {
      return new Response(JSON.stringify({ error: 'No fields to update' }), { status: 400 });
    }

    const { data, error } = await db
      .from('referral_codes')
      .update(updates)
      .eq('id', id)
      .select('id, code, discount_pct, rental_discount_pct, owner_id, label, is_active, created_at')
      .single();

    if (error) {
      if (error.code === '23505') {
        return new Response(JSON.stringify({ error: 'That code is already in use.' }), { status: 409 });
      }
      return serverError(error.message);
    }
    if (!data) return new Response(JSON.stringify({ error: 'Code not found.' }), { status: 404 });

    let ownerName = '';
    if (data.owner_id) {
      const { data: owner } = await db
        .from('customers').select('full_name').eq('id', data.owner_id).limit(1).maybeSingle();
      ownerName = owner?.full_name ?? '';
    }

    return ok({ row: { ...data, owner_name: ownerName } });
  } catch (e: any) { return serverError(e?.message ?? String(e)); }
};

/** DELETE /api/referral-codes/:id — remove a code permanently.
 *  Past check-ins keep their recorded code, owner and percentage. */
export const DELETE: APIRoute = async ({ params, request }) => {
  const denied = await adminOnly(request);
  if (denied) return denied;

  try {
    const { id } = params;
    if (!id || !isValidUUID(id)) return new Response(JSON.stringify({ error: 'Invalid id' }), { status: 400 });

    const { error } = await db.from('referral_codes').delete().eq('id', id);
    if (error) return serverError(error.message);
    return ok({ success: true });
  } catch (e: any) { return serverError(e?.message ?? String(e)); }
};
