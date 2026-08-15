export const prerender = false;

import type { APIRoute } from 'astro';
import { db } from '../../../lib/db';
import { authFromRequest, forbidden, ok, serverError, unauthorized } from '../../../lib/auth';
import { canModifyRow } from '../../../lib/ownership';
import { isValidUUID } from '../../../lib/validate';

/** DELETE /api/checkins/:id */
export const DELETE: APIRoute = async ({ params, request }) => {
  const { id } = params;
  if (!id || !isValidUUID(id)) return new Response(JSON.stringify({ error: 'Invalid id' }), { status: 400 });

  // Admins may delete any check-in; part-timers only the ones they logged.
  const auth = await authFromRequest(request);
  if (!auth) return unauthorized();
  if (!await canModifyRow('checkins', id, auth)) {
    return forbidden('You can only delete check-ins you logged yourself.');
  }

  // Fetch the check-in first so we can revert any punch deduction
  const { data: checkin, error: fetchError } = await db
    .from('checkins')
    .select('punch_card_holder_id, pt_punch_holder_id')
    .eq('id', id)
    .single();

  if (fetchError) return serverError(fetchError.message);

  // Delete the check-in record
  const { error } = await db
    .from('checkins')
    .delete()
    .eq('id', id);

  if (error) return serverError(error.message);

  // Restore the punch if this check-in deducted one
  if (checkin?.punch_card_holder_id) {
    const { data: holder } = await db
      .from('customers')
      .select('punches_remaining')
      .eq('id', checkin.punch_card_holder_id)
      .single();

    if (holder) {
      await db
        .from('customers')
        .update({ punches_remaining: (holder.punches_remaining ?? 0) + 1 })
        .eq('id', checkin.punch_card_holder_id);
    }
  }

  // Restore the PT punch if this check-in deducted one
  if (checkin?.pt_punch_holder_id) {
    const { data: ptHolder } = await db
      .from('customers')
      .select('pt_punches_remaining')
      .eq('id', checkin.pt_punch_holder_id)
      .single();

    if (ptHolder) {
      await db
        .from('customers')
        .update({ pt_punches_remaining: (ptHolder.pt_punches_remaining ?? 0) + 1 })
        .eq('id', checkin.pt_punch_holder_id);
    }
  }

  return ok({ success: true });
};
