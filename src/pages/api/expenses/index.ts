export const prerender = false;

import type { APIRoute } from 'astro';
import { db } from '../../../lib/db';
import { ok, serverError } from '../../../lib/auth';
import { fetchAllPages } from '../../../lib/paginate';
import { isValidDate, isValidAmount, MAX_TEXT } from '../../../lib/validate';

const VALID_TYPES = [
  'Construction Setup', 'Construction Material', 'Holds',
  'Marketing', 'Rent', 'Utility', 'Manpower Cost', 'Misc',
  'Operation Cost', 'Rental Shoes', 'Other',
];

/**
 * GET /api/expenses
 * Returns all expense records plus all checkin {date, amount} rows so the
 * client can compute balance stats without a second round-trip.
 */
export const GET: APIRoute = async () => {
  const [expRes, revRes] = await Promise.all([
    fetchAllPages((from, to) => db.from('expenses').select('*').order('date', { ascending: false }).range(from, to)),
    fetchAllPages((from, to) => db.from('checkins').select('date, amount').range(from, to)),
  ]);

  if (expRes.error) return serverError(expRes.error.message);
  if (revRes.error) return serverError(revRes.error.message);

  return ok({ expenses: expRes.data, revenue_rows: revRes.data });
};

/** POST /api/expenses — log a new expense */
export const POST: APIRoute = async ({ request }) => {
  let body: {
    description: string;
    type: string;
    date: string;
    location?: string;
    amount: number;
    comment?: string;
  };

  try { body = await request.json(); }
  catch { return new Response(JSON.stringify({ error: 'Invalid JSON' }), { status: 400 }); }

  const { description, type, date, location, amount, comment } = body;

  if (!description || !type || !date || amount == null) {
    return new Response(JSON.stringify({ error: 'Missing required fields' }), { status: 400 });
  }
  if (!isValidDate(String(date))) {
    return new Response(JSON.stringify({ error: 'Invalid date format (expected YYYY-MM-DD)' }), { status: 400 });
  }
  if (!VALID_TYPES.includes(type)) {
    return new Response(JSON.stringify({ error: 'Invalid expense type' }), { status: 400 });
  }
  const numAmount = Number(amount);
  if (!isValidAmount(numAmount)) {
    return new Response(JSON.stringify({ error: 'Invalid amount' }), { status: 400 });
  }
  if (String(description).length > MAX_TEXT || String(comment ?? '').length > MAX_TEXT) {
    return new Response(JSON.stringify({ error: 'description or comment exceeds maximum length' }), { status: 400 });
  }

  const { data, error } = await db
    .from('expenses')
    .insert({
      description,
      type,
      date,
      location:  location ?? '',
      amount:    Math.round(Math.abs(numAmount)),
      comment:   comment ?? '',
    })
    .select()
    .single();

  if (error) return serverError(error.message);
  return ok({ expense: data }, 201);
};
