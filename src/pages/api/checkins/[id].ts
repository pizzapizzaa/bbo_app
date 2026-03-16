export const prerender = false;

import type { APIRoute } from 'astro';
import { db } from '../../../lib/db';
import { ok, serverError } from '../../../lib/auth';

/** DELETE /api/checkins/:id */
export const DELETE: APIRoute = async ({ params }) => {
  const { id } = params;
  if (!id) return new Response(JSON.stringify({ error: 'Missing id' }), { status: 400 });

  const { error } = await db
    .from('checkins')
    .delete()
    .eq('id', id);

  if (error) return serverError(error.message);
  return ok({ success: true });
};
