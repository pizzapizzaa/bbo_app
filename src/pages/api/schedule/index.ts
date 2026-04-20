export const prerender = false;

import type { APIRoute } from 'astro';
import { db } from '../../../lib/db';
import { ok, serverError } from '../../../lib/auth';
import { fetchAllPages } from '../../../lib/paginate';
import { isValidDate, isValidTime, MAX_NAME, MAX_TEXT } from '../../../lib/validate';

/** GET /api/schedule — return all schedule entries */
export const GET: APIRoute = async () => {
  const { data, error } = await fetchAllPages((from, to) =>
    db.from('schedule_entries').select('*').order('date', { ascending: false }).range(from, to)
  );

  if (error) return serverError(error.message);
  return ok({ entries: data });
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
  if (String(staff_name).length > MAX_NAME) {
    return new Response(JSON.stringify({ error: 'staff_name too long' }), { status: 400 });
  }
  if (!isValidDate(String(date))) {
    return new Response(JSON.stringify({ error: 'Invalid date format (expected YYYY-MM-DD)' }), { status: 400 });
  }
  if (!isValidTime(String(start_time)) || !isValidTime(String(end_time))) {
    return new Response(JSON.stringify({ error: 'Invalid time format (expected HH:MM)' }), { status: 400 });
  }
  if ((notes ?? '').length > MAX_TEXT) {
    return new Response(JSON.stringify({ error: 'notes exceeds maximum length' }), { status: 400 });
  }

  const { data, error } = await db
    .from('schedule_entries')
    .insert({ staff_name, date, start_time, end_time, notes: notes ?? '' })
    .select()
    .single();

  if (error) return serverError(error.message);
  return ok({ entry: data });
};
