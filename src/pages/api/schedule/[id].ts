export const prerender = false;

import type { APIRoute } from 'astro';
import { db } from '../../../lib/db';
import { authFromRequest, forbidden, ok, serverError, unauthorized, requireAdmin } from '../../../lib/auth';
import { isValidUUID, isValidDate, isValidTime, MAX_NAME } from '../../../lib/validate';
import { toShiftType } from '../../../lib/staff';

/**
 * Reject a non-admin without destroying their session.
 *
 * Editing the schedule is the admin's job; a part-timer changes their own
 * standing on it by claiming and releasing slots (POST/DELETE :id/claim), which
 * is guarded separately.
 */
async function adminOrRefusal(request: Request, action: string): Promise<Response | null> {
  if (await requireAdmin(request)) return null;
  return await authFromRequest(request)
    ? forbidden(`Only an admin can ${action} shifts. Take or hand back a shift instead.`)
    : unauthorized();
}

/** PATCH /api/schedule/:id — update an existing entry (admin only) */
export const PATCH: APIRoute = async ({ params, request }) => {
  const { id } = params;
  if (!id || !isValidUUID(id)) return new Response(JSON.stringify({ error: 'Invalid id' }), { status: 400 });

  const refusal = await adminOrRefusal(request, 'edit');
  if (refusal) return refusal;

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

/** DELETE /api/schedule/:id (admin only) */
export const DELETE: APIRoute = async ({ params, request }) => {
  const { id } = params;
  if (!id || !isValidUUID(id)) return new Response(JSON.stringify({ error: 'Invalid id' }), { status: 400 });

  const refusal = await adminOrRefusal(request, 'delete');
  if (refusal) return refusal;

  const { error } = await db
    .from('schedule_entries')
    .delete()
    .eq('id', id);

  if (error) return serverError(error.message);
  return ok({ success: true });
};
