export const prerender = false;

import type { APIRoute } from 'astro';
import { db } from '../../../lib/db';
import { ok, serverError } from '../../../lib/auth';

/** GET /api/schedule — return all schedule entries */
export const GET: APIRoute = async () => {
  const { data, error } = await db
    .from('schedule_entries')
    .select('*')
    .order('date', { ascending: false });

  if (error) return serverError(error.message);
  return ok({ entries: data ?? [] });
};

/** POST /api/schedule — add a new entry */
export const POST: APIRoute = async ({ request }) => {
  let body: { staff_name: string; date: string; start_time: string; end_time: string; notes?: string };
  try { body = await request.json(); }
  catch { return new Response(JSON.stringify({ error: 'Invalid JSON' }), { status: 400 }); }

  const { staff_name, date, start_time, end_time, notes } = body;
  if (!staff_name || !date || !start_time || !end_time) {
    return new Response(JSON.stringify({ error: 'Missing required fields' }), { status: 400 });
  }

  const { data, error } = await db
    .from('schedule_entries')
    .insert({ staff_name, date, start_time, end_time, notes: notes ?? '' })
    .select()
    .single();

  if (error) return serverError(error.message);
  return ok({ entry: data });
};
