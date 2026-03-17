export const prerender = false;

import type { APIRoute } from 'astro';
import { db } from '../../../lib/db';
import { ok, serverError } from '../../../lib/auth';

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
    db.from('expenses').select('*').order('date', { ascending: false }),
    db.from('checkins').select('date, amount'),
  ]);

  if (expRes.error) return serverError(expRes.error.message);
  if (revRes.error) return serverError(revRes.error.message);

  return ok({ expenses: expRes.data ?? [], revenue_rows: revRes.data ?? [] });
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
  if (!VALID_TYPES.includes(type)) {
    return new Response(JSON.stringify({ error: 'Invalid expense type' }), { status: 400 });
  }

  const { data, error } = await db
    .from('expenses')
    .insert({
      description,
      type,
      date,
      location:  location ?? '',
      amount:    Math.round(Math.abs(Number(amount))),
      comment:   comment ?? '',
    })
    .select()
    .single();

  if (error) return serverError(error.message);
  return ok({ expense: data }, 201);
};
