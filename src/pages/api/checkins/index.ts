export const prerender = false;

import type { APIRoute } from 'astro';
import { db } from '../../../lib/db';
import { ok, serverError } from '../../../lib/auth';

/** GET /api/checkins?date=YYYY-MM-DD — return all check-ins for a date */
export const GET: APIRoute = async ({ url }) => {
  const date = url.searchParams.get('date');
  if (!date) return new Response(JSON.stringify({ error: 'Missing date' }), { status: 400 });

  const { data, error } = await db
    .from('checkins')
    .select('*')
    .eq('date', date)
    .order('checked_in_at', { ascending: true });

  if (error) return serverError(error.message);
  return ok({ checkins: data ?? [] });
};

/** POST /api/checkins — add a new check-in */
export const POST: APIRoute = async ({ request }) => {
  let body: {
    customer_name: string;
    date: string;
    time: string;
    payment_method: string;
    amount: number;
    notes?: string;
    punch_card_holder_id?: string;
    punch_card_holder_name?: string;
  };
  try { body = await request.json(); }
  catch { return new Response(JSON.stringify({ error: 'Invalid JSON' }), { status: 400 }); }

  const { customer_name, date, time, payment_method, amount, notes,
          punch_card_holder_id, punch_card_holder_name } = body;
  if (!customer_name || !date || !time || !payment_method) {
    return new Response(JSON.stringify({ error: 'Missing required fields' }), { status: 400 });
  }

  // Validate membership when payment is "Valid Membership"
  if (payment_method === 'Valid Membership') {
    const { data: memberData } = await db
      .from('customers')
      .select('membership_type, membership_end_date')
      .ilike('full_name', customer_name)
      .limit(1)
      .single();

    if (!memberData || !memberData.membership_type) {
      return new Response(JSON.stringify({ error: 'Customer has no active membership.' }), { status: 400 });
    }
    if (!memberData.membership_end_date || memberData.membership_end_date < date) {
      return new Response(JSON.stringify({ error: 'Membership has expired.' }), { status: 400 });
    }
  }

  const { data, error } = await db
    .from('checkins')
    .insert({
      customer_name,
      date,
      time,
      payment_method,
      amount: amount ?? 0,
      notes: notes ?? '',
      punch_card_holder_id:   punch_card_holder_id   || null,
      punch_card_holder_name: punch_card_holder_name || '',
    })
    .select()
    .single();

  if (error) return serverError(error.message);

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

  return ok({ checkin: data });
};
