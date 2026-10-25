export const prerender = false;

import type { APIRoute } from 'astro';
import { db } from '../../../lib/db';
import { adminOnly, ok, serverError } from '../../../lib/auth';
import { isValidUUID } from '../../../lib/validate';

/** PATCH /api/customers/:id — update customer profile, punch card, and/or membership info */
export const PATCH: APIRoute = async ({ params, request }) => {
  const denied = await adminOnly(request);
  if (denied) return denied;

  try {
    const { id } = params;
    if (!id || !isValidUUID(id)) return new Response(JSON.stringify({ error: 'Invalid id' }), { status: 400 });

    let body: {
      full_name?: string;
      dob?: string;
      email?: string;
      telephone?: string;
      emergency_contact?: string;
      note?: string;
      waiver_form?: string;
      is_punch_card_holder?: boolean;
      punches_remaining?: number;
      pt_punches_remaining?: number;
      membership_type?: string;
      membership_start_date?: string | null;
      membership_end_date?: string | null;
    };
    try { body = await request.json(); }
    catch { return new Response(JSON.stringify({ error: 'Invalid JSON' }), { status: 400 }); }

    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      return new Response(JSON.stringify({ error: 'Invalid request body' }), { status: 400 });
    }

    const updates: Record<string, string | number | boolean | null> = {};

    const profileFields = [
      'full_name',
      'dob',
      'email',
      'telephone',
      'emergency_contact',
      'note',
      'waiver_form',
    ] as const;
    for (const field of profileFields) {
      if (!(field in body)) continue;
      if (typeof body[field] !== 'string') {
        return new Response(JSON.stringify({ error: `${field} must be a string` }), { status: 400 });
      }
      const value = body[field].trim();
      if (field === 'full_name' && !value) {
        return new Response(JSON.stringify({ error: 'Full name is required' }), { status: 400 });
      }
      updates[field] = value;
    }

    // Punch card fields
    if ('is_punch_card_holder' in body) {
      if (typeof body.is_punch_card_holder !== 'boolean') {
        return new Response(JSON.stringify({ error: 'is_punch_card_holder must be a boolean' }), { status: 400 });
      }
      const isPunchCardHolder = body.is_punch_card_holder;
      const punches = Number(body.punches_remaining ?? 0);
      if (!Number.isFinite(punches) || punches < 0) {
        return new Response(JSON.stringify({ error: 'punches_remaining must be a non-negative number' }), { status: 400 });
      }
      updates.is_punch_card_holder = isPunchCardHolder;
      updates.punches_remaining    = isPunchCardHolder
        ? Math.floor(punches)
        : 0;
    }

    // PT punch field
    if ('pt_punches_remaining' in body) {
      const punches = Number(body.pt_punches_remaining);
      if (!Number.isFinite(punches) || punches < 0) {
        return new Response(JSON.stringify({ error: 'pt_punches_remaining must be a non-negative number' }), { status: 400 });
      }
      updates.pt_punches_remaining = Math.floor(punches);
    }

    // Membership fields
    if ('membership_type' in body) {
      if (typeof body.membership_type !== 'string') {
        return new Response(JSON.stringify({ error: 'Invalid membership type' }), { status: 400 });
      }
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
        if (typeof startStr !== 'string' || !startStr) {
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

    // Referral codes are no longer stored on the customer row — they live in
    // `referral_codes` (many per customer). See /api/referral-codes.

    if (Object.keys(updates).length === 0) {
      return new Response(JSON.stringify({ error: 'No fields to update' }), { status: 400 });
    }

    const { data, error } = await db
      .from('customers')
      .update(updates)
      .eq('id', id)
      .select('id, full_name, dob, email, telephone, emergency_contact, note, waiver_form, is_punch_card_holder, punches_remaining, pt_punches_remaining, membership_type, membership_start_date, membership_end_date')
      .single();

    if (error) {
      if (error.code === '42703' || error.message?.includes('is_punch_card_holder') || error.message?.includes('membership_type')) {
        return new Response(JSON.stringify({ error: 'Required columns not found. Please run the database migration first.' }), { status: 400 });
      }
      return serverError(error.message);
    }
    return ok({ row: data });
  } catch (e: any) { return serverError(e?.message ?? String(e)); }
};

/** DELETE /api/customers/:id */
export const DELETE: APIRoute = async ({ params, request }) => {
  const denied = await adminOnly(request);
  if (denied) return denied;

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
