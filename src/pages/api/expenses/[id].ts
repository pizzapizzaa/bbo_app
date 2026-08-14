export const prerender = false;

import type { APIRoute } from 'astro';
import { db } from '../../../lib/db';
import { adminOnly, ok, serverError } from '../../../lib/auth';
import { isValidUUID } from '../../../lib/validate';

/** DELETE /api/expenses/:id */
export const DELETE: APIRoute = async ({ params, request }) => {
  const denied = await adminOnly(request);
  if (denied) return denied;

  const { id } = params;
  if (!id || !isValidUUID(id)) return new Response(JSON.stringify({ error: 'Invalid id' }), { status: 400 });

  const { error } = await db.from('expenses').delete().eq('id', id);
  if (error) return serverError(error.message);
  return ok({ success: true });
};
