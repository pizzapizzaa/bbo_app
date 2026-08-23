export const prerender = false;

import type { APIRoute } from 'astro';
import { db } from '../../../lib/db';
import { adminOnly, ok, serverError } from '../../../lib/auth';
import { fetchAllPages } from '../../../lib/paginate';
import { codeColumns, codePayload, withRentalPctFallback } from '../../../lib/referral';
import {
  isValidUUID, escapeLike,
  normalizeReferralCode, isValidReferralCode, isValidReferralPct, isValidRentalPct,
  referralCodesMatch, normalizeCodeLabel,
} from '../../../lib/validate';

/** Shape returned to the client for one code row. */
function toRow(r: any, ownerNames: Map<string, string>) {
  return {
    id:                  r.id,
    code:                r.code ?? '',
    discount_pct:        r.discount_pct ?? 0,
    rental_discount_pct: r.rental_discount_pct ?? 0,
    owner_id:            r.owner_id ?? null,
    owner_name:          r.owner_id ? (ownerNames.get(r.owner_id) ?? '') : '',
    label:               r.label ?? '',
    is_active:           r.is_active !== false,
    created_at:          r.created_at ?? '',
  };
}

/** Look up the display names of the owners referenced by the given rows. */
async function loadOwnerNames(rows: any[]): Promise<Map<string, string>> {
  const ids = [...new Set(rows.map((r) => r.owner_id).filter(Boolean))] as string[];
  const names = new Map<string, string>();
  const BATCH = 200;
  for (let i = 0; i < ids.length; i += BATCH) {
    const { data } = await db
      .from('customers')
      .select('id, full_name')
      .in('id', ids.slice(i, i + BATCH));
    (data ?? []).forEach((c: any) => names.set(c.id, c.full_name ?? ''));
  }
  return names;
}

/** GET /api/referral-codes[?owner=<uuid>|?scope=promo|customer]
 *  Lists referral / promo codes, newest first. */
export const GET: APIRoute = async ({ url, request }) => {
  const denied = await adminOnly(request);
  if (denied) return denied;

  try {
    const owner = url.searchParams.get('owner');
    const scope = url.searchParams.get('scope') ?? 'all';
    if (owner && !isValidUUID(owner)) {
      return new Response(JSON.stringify({ error: 'Invalid owner id' }), { status: 400 });
    }

    const { data, error } = await withRentalPctFallback((columns) =>
      fetchAllPages((from, to) => {
        let q = db
          .from('referral_codes')
          .select(columns)
          .order('created_at', { ascending: false })
          .range(from, to);
        if (owner)                  q = q.eq('owner_id', owner);
        else if (scope === 'promo') q = q.is('owner_id', null);
        else if (scope === 'customer') q = q.not('owner_id', 'is', null);
        return q as PromiseLike<{ data: any[] | null; error: any }>;
      }), 'created_at');

    if (error) {
      // 42P01 = table missing → the migration has not been run yet.
      if (error.code === '42P01') {
        return new Response(JSON.stringify({
          error: 'The referral_codes table is missing. Please run the database migration first.',
        }), { status: 400 });
      }
      return serverError(error.message);
    }

    const ownerNames = await loadOwnerNames(data);
    return ok({ codes: data.map((r: any) => toRow(r, ownerNames)) });
  } catch (e: any) { return serverError(e?.message ?? String(e)); }
};

/** POST /api/referral-codes — create a code.
 *  owner_id omitted / null → universal promo code. */
export const POST: APIRoute = async ({ request }) => {
  const denied = await adminOnly(request);
  if (denied) return denied;

  try {
    let body: {
      code?: string;
      discount_pct?: number;
      rental_discount_pct?: number;
      owner_id?: string | null;
      label?: string;
      is_active?: boolean;
    };
    try { body = await request.json(); }
    catch { return new Response(JSON.stringify({ error: 'Invalid JSON' }), { status: 400 }); }

    const code = normalizeReferralCode(body.code ?? '');
    if (!isValidReferralCode(code)) {
      return new Response(JSON.stringify({
        error: 'Code must be 3–20 characters using letters, numbers or dashes.',
      }), { status: 400 });
    }

    const pct = Math.round(Number(body.discount_pct));
    if (!isValidReferralPct(pct)) {
      return new Response(JSON.stringify({
        error: 'Discount must be a whole number between 1 and 100.',
      }), { status: 400 });
    }

    // Rentals are charged in full unless the code says otherwise.
    const rentalPct = 'rental_discount_pct' in body ? Math.round(Number(body.rental_discount_pct)) : 0;
    if (!isValidRentalPct(rentalPct)) {
      return new Response(JSON.stringify({
        error: 'Rental discount must be a whole number between 0 and 100.',
      }), { status: 400 });
    }

    const ownerId = body.owner_id ?? null;
    if (ownerId !== null && !isValidUUID(String(ownerId))) {
      return new Response(JSON.stringify({ error: 'Invalid owner id' }), { status: 400 });
    }
    if (ownerId) {
      const { data: owner } = await db
        .from('customers').select('id').eq('id', ownerId).limit(1).maybeSingle();
      if (!owner) return new Response(JSON.stringify({ error: 'Customer not found.' }), { status: 404 });
    }

    // Codes are unique across every customer and promo (case-insensitively).
    const { data: clash } = await db
      .from('referral_codes')
      .select('id, code')
      .ilike('code', escapeLike(code))
      .limit(1)
      .maybeSingle();
    if (clash && referralCodesMatch(clash.code, code)) {
      return new Response(JSON.stringify({ error: 'That code is already in use.' }), { status: 409 });
    }

    const { data, error } = await withRentalPctFallback((columns) => db
      .from('referral_codes')
      .insert(codePayload({
        code,
        discount_pct:        pct,
        rental_discount_pct: rentalPct,
        owner_id:            ownerId,
        label:               normalizeCodeLabel(body.label ?? ''),
        is_active:           body.is_active !== false,
      }))
      .select(columns)
      .single() as PromiseLike<{ data: any; error: any }>, 'created_at');

    if (error) {
      // 23505 = unique violation (race with a concurrent create).
      if (error.code === '23505') {
        return new Response(JSON.stringify({ error: 'That code is already in use.' }), { status: 409 });
      }
      if (error.code === '42P01') {
        return new Response(JSON.stringify({
          error: 'The referral_codes table is missing. Please run the database migration first.',
        }), { status: 400 });
      }
      return serverError(error.message);
    }

    const ownerNames = await loadOwnerNames([data]);
    return ok({ row: toRow(data, ownerNames) });
  } catch (e: any) { return serverError(e?.message ?? String(e)); }
};
