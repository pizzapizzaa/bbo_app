export const prerender = false;

import type { APIRoute } from 'astro';
import { db } from '../../../lib/db';
import { authFromRequest, forbidden, ok, serverError, unauthorized } from '../../../lib/auth';
import { canModifyRow } from '../../../lib/ownership';
import { isValidUUID, isValidDate, isValidTime, MAX_NAME } from '../../../lib/validate';
import { toShiftType } from '../../../lib/staff';

/** PATCH /api/schedule/:id — update an existing entry */
export const PATCH: APIRoute = async ({ params, request }) => {
  const { id } = params;
  if (!id || !isValidUUID(id)) return new Response(JSON.stringify({ error: 'Invalid id' }), { status: 400 });

  // Admins may edit any shift; part-timers only the ones they added. Taking a
  // shift is not editing it — that goes through POST :id/claim, which has its
  // own rules.
  const auth = await authFromRequest(request);
  if (!auth) return unauthorized();
  if (!await canModifyRow('schedule_entries', id, auth)) {
    return forbidden('You can only edit shifts you added yourself.');
  }

  let body: {
    staff_name?: string; date?: string; start_time?: string; end_time?: string;
    notes?: string; shift_type?: string;
  };
  try { body = await request.json(); }
  catch { return new Response(JSON.stringify({ error: 'Invalid JSON' }), { status: 400 }); }

  const { date, start_time, end_time, notes } = body;
  const shift_type = toShiftType(body.shift_type);
  const staff_name = String(body.staff_name ?? '').trim();

  if (!date || !start_time || !end_time) {
    return new Response(JSON.stringify({ error: 'Missing required fields' }), { status: 400 });
  }
  // An unclaimed part-time slot legitimately has no name on it; anything else must.
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

  // Keep the claim columns in step with the name just set. Clearing the name on
  // a part-time slot returns it to the open pool, so the stale claim trail has
  // to go with it; typing a name in counts as the admin filling it.
  const claimPatch = shift_type === 'part_time' && !staff_name
    ? { claimed_by: '', claimed_by_account: '', claimed_at: null }
    : { claimed_by: shift_type === 'part_time' ? staff_name : '' };

  const { data, error } = await db
    .from('schedule_entries')
    .update({ staff_name, date, start_time, end_time, notes: notes ?? '', shift_type, ...claimPatch })
    .eq('id', id)
    .select()
    .single();

  if (error) return serverError(error.message);
  return ok({ entry: data });
};

/** DELETE /api/schedule/:id */
export const DELETE: APIRoute = async ({ params, request }) => {
  const { id } = params;
  if (!id || !isValidUUID(id)) return new Response(JSON.stringify({ error: 'Invalid id' }), { status: 400 });

  const auth = await authFromRequest(request);
  if (!auth) return unauthorized();
  if (!await canModifyRow('schedule_entries', id, auth)) {
    return forbidden('You can only delete shifts you added yourself.');
  }

  const { error } = await db
    .from('schedule_entries')
    .delete()
    .eq('id', id);

  if (error) return serverError(error.message);
  return ok({ success: true });
};
