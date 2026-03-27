export const prerender = false;

import type { APIRoute } from 'astro';
import { db } from '../../../lib/db';
import { ok, serverError } from '../../../lib/auth';

/** DELETE /api/checkins/:id */
export const DELETE: APIRoute = async ({ params }) => {
  const { id } = params;
  if (!id) return new Response(JSON.stringify({ error: 'Missing id' }), { status: 400 });

  // Fetch the check-in first so we can revert any punch deduction
  const { data: checkin, error: fetchError } = await db
    .from('checkins')
    .select('punch_card_holder_id')
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

  return ok({ success: true });
};
