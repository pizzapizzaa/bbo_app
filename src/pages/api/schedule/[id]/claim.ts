export const prerender = false;

import type { APIRoute } from 'astro';
import { db } from '../../../../lib/db';
import { ok, serverError, unauthorized, authFromRequest } from '../../../../lib/auth';
import { isValidUUID } from '../../../../lib/validate';
import { isKnownPartTimer } from '../../../../lib/staff';

/**
 * Claiming and releasing open part-time shifts.
 *
 * All part-timers share one login, so the account can't say who is standing
 * there — the claimer picks their own name from the roster and the server checks
 * it against `PART_TIMER_NAMES`. The claim writes that name into `staff_name`,
 * which is what every hours calculation in the app reads.
 *
 * There is deliberately no cap on how many slots exist per day or per time
 * range, nor on how many one person may hold: the gym runs several part-time
 * shifts in the same slot.
 */

const conflict = (msg: string): Response =>
  new Response(JSON.stringify({ error: msg }), {
    status: 409,
    headers: { 'Content-Type': 'application/json' },
  });

const forbidden = (msg: string): Response =>
  new Response(JSON.stringify({ error: msg }), {
    status: 403,
    headers: { 'Content-Type': 'application/json' },
  });

/**
 * Today's date at the gym (Asia/Ho_Chi_Minh), as YYYY-MM-DD.
 *
 * The server runs in UTC, seven hours behind, so a plain `new Date()` would call
 * it "yesterday" for the whole Vietnamese evening — long enough for a part-timer
 * to drop a shift they were already meant to be working.
 */
function gymToday(): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Ho_Chi_Minh',
    year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(new Date());
}

/** POST /api/schedule/:id/claim — put your name on an open part-time shift */
export const POST: APIRoute = async ({ params, request }) => {
  const auth = await authFromRequest(request);
  if (!auth) return unauthorized();

  const { id } = params;
  if (!id || !isValidUUID(id)) return new Response(JSON.stringify({ error: 'Invalid id' }), { status: 400 });

  let body: { part_timer_name?: string };
  try { body = await request.json(); }
  catch { return new Response(JSON.stringify({ error: 'Invalid JSON' }), { status: 400 }); }

  const name = String(body.part_timer_name ?? '').trim();
  if (!name) {
    return new Response(JSON.stringify({ error: 'Please select your name' }), { status: 400 });
  }
  if (!isKnownPartTimer(name)) {
    return new Response(JSON.stringify({ error: 'Not a known part-timer' }), { status: 400 });
  }

  // Single conditional UPDATE rather than read-then-write: two part-timers
  // tapping the same slot at once both match on `staff_name = ''`, but only the
  // first one's update finds a row — the second gets 0 rows and a 409.
  const { data, error } = await db
    .from('schedule_entries')
    .update({
      staff_name:         name,
      claimed_by:         name,
      claimed_by_account: auth.username,
      claimed_at:         new Date().toISOString(),
    })
    .eq('id', id)
    .eq('shift_type', 'part_time')
    .eq('staff_name', '')
    .select();

  if (error) return serverError(error.message);
  if (!data || data.length === 0) {
    return conflict('That shift is no longer open — someone just took it.');
  }
  return ok({ entry: data[0] });
};

/** DELETE /api/schedule/:id/claim — give a claimed shift back to the open pool */
export const DELETE: APIRoute = async ({ params, request }) => {
  const auth = await authFromRequest(request);
  if (!auth) return unauthorized();

  const { id } = params;
  if (!id || !isValidUUID(id)) return new Response(JSON.stringify({ error: 'Invalid id' }), { status: 400 });

  const { data: entry, error: readErr } = await db
    .from('schedule_entries')
    .select('id, date, shift_type, staff_name, claimed_by_account')
    .eq('id', id)
    .maybeSingle();

  if (readErr) return serverError(readErr.message);
  if (!entry) return new Response(JSON.stringify({ error: 'Shift not found' }), { status: 404 });

  if (entry.shift_type !== 'part_time') {
    return forbidden('Only part-time shifts can be released.');
  }
  if (!entry.staff_name) {
    return conflict('That shift is already open.');
  }

  const isAdmin = auth.role === 'admin';
  // The shared account can only let go of what it took; an admin can unassign anything.
  if (!isAdmin && entry.claimed_by_account !== auth.username) {
    return forbidden('That shift was claimed from a different account.');
  }
  // Past shifts are payroll history — only an admin may still touch them.
  if (!isAdmin && String(entry.date) < gymToday()) {
    return forbidden('That shift has already passed — ask an admin to change it.');
  }

  const { data, error } = await db
    .from('schedule_entries')
    .update({ staff_name: '', claimed_by: '', claimed_by_account: '', claimed_at: null })
    .eq('id', id)
    .eq('shift_type', 'part_time')
    .select()
    .single();

  if (error) return serverError(error.message);
  return ok({ entry: data });
};
