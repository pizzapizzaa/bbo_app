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
  };
  try { body = await request.json(); }
  catch { return new Response(JSON.stringify({ error: 'Invalid JSON' }), { status: 400 }); }

  const { customer_name, date, time, payment_method, amount, notes } = body;
  if (!customer_name || !date || !time || !payment_method) {
    return new Response(JSON.stringify({ error: 'Missing required fields' }), { status: 400 });
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
    })
    .select()
    .single();

  if (error) return serverError(error.message);
  return ok({ checkin: data });
};
