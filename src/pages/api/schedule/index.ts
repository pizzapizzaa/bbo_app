export const prerender = false;

import type { APIRoute } from 'astro';
import { db } from '../../../lib/db';
import { authFromRequest, forbidden, ok, serverError, unauthorized } from '../../../lib/auth';
import { insertOwned } from '../../../lib/ownership';
import { fetchAllPages } from '../../../lib/paginate';
import { isValidDate, isValidTime, MAX_NAME, MAX_TEXT } from '../../../lib/validate';
import { isKnownPartTimer, toShiftType } from '../../../lib/staff';

/** GET /api/schedule — return all schedule entries */
export const GET: APIRoute = async ({ request }) => {
  // Part-timers read the calendar to find slots to claim, so any signed-in
  // account may read.
  if (!await authFromRequest(request)) return unauthorized();

  const { data, error } = await fetchAllPages((from, to) =>
    db.from('schedule_entries').select('*').order('date', { ascending: false }).range(from, to)
  );

  if (error) return serverError(error.message);
  return ok({ entries: data });
};

/**
 * POST /api/schedule — add a new entry.
 *
 * Part-timers may add ordinary shifts, which are stamped with their username so
 * they can edit their own afterwards. Posting an *open* part-time slot is an
 * admin act, though — it is the gym deciding a shift needs covering, not a
 * part-timer manufacturing work to claim.
 */
export const POST: APIRoute = async ({ request }) => {
  const auth = await authFromRequest(request);
  if (!auth) return unauthorized();

  let body: {
    staff_name?: string; date: string; start_time: string; end_time: string;
    notes?: string; shift_type?: string;
  };
  try { body = await request.json(); }
  catch { return new Response(JSON.stringify({ error: 'Invalid JSON' }), { status: 400 }); }

  const { date, start_time, end_time, notes } = body;
  const shift_type = toShiftType(body.shift_type);
  const staff_name = String(body.staff_name ?? '').trim();

  if (shift_type === 'part_time' && auth.role !== 'admin') {
    return forbidden('Only an admin can post part-time shifts.');
  }
  if (!date || !start_time || !end_time) {
    return new Response(JSON.stringify({ error: 'Missing required fields' }), { status: 400 });
  }
  // Only an unclaimed part-time slot may go in without a name on it.
  if (!staff_name && shift_type !== 'part_time') {
    return new Response(JSON.stringify({ error: 'Missing required fields' }), { status: 400 });
  }
  if (staff_name.length > MAX_NAME) {
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
  if (shift_type === 'part_time' && staff_name && !isKnownPartTimer(staff_name)) {
    return new Response(JSON.stringify({ error: 'Not a known part-timer' }), { status: 400 });
  }

  // A part-time slot created with a name already on it is one the admin filled
  // in themselves — record it as claimed so it doesn't show up as open.
  const preClaimed = shift_type === 'part_time' && !!staff_name;

  const { data, error } = await insertOwned(
    'schedule_entries',
    {
      staff_name, date, start_time, end_time, notes: notes ?? '',
      shift_type,
      claimed_by:         preClaimed ? staff_name    : '',
      claimed_by_account: preClaimed ? auth.username : '',
      claimed_at:         preClaimed ? new Date().toISOString() : null,
    },
    auth,
  );

  if (error) return serverError(error.message);
  return ok({ entry: data });
};
