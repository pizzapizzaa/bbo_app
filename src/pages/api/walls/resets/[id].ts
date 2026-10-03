export const prerender = false;

import type { APIRoute } from 'astro';
import { db } from '../../../../lib/db';
import { adminOnly, ok, serverError } from '../../../../lib/auth';
import { isValidUUID } from '../../../../lib/validate';
import { validateWallReset, wallResetRow } from '../../../../lib/wall-config';

const badRequest = (error: string, status = 400) =>
  new Response(JSON.stringify({ error }), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });

/**
 * PATCH /api/walls/resets/:id — correct a reset (admin only).
 * Moving `closes_at` changes which sends count against the set; that is the
 * point when fixing a reset entered with the wrong time.
 */
export const PATCH: APIRoute = async ({ params, request }) => {
  const denied = await adminOnly(request);
  if (denied) return denied;

  const { id } = params;
  if (!id || !isValidUUID(id)) return badRequest('Invalid id');

  let body: Record<string, unknown>;
  try { body = await request.json(); }
  catch { return badRequest('Invalid JSON'); }

  const result = validateWallReset(body);
  if ('error' in result) return badRequest(result.error);

  const { data, error } = await db
    .from('wall_resets')
    .update({ ...wallResetRow(result.value), updated_at: new Date().toISOString() })
    .eq('id', id)
    .select()
    .maybeSingle();

  if (error) {
    if (error.code === '23505') {
      return badRequest(`${result.value.wall} already has a reset closing at that time.`, 409);
    }
    return serverError(error.message);
  }
  if (!data) return badRequest('Reset not found', 404);
  return ok({ reset: data });
};

/**
 * DELETE /api/walls/resets/:id — remove a reset entered by mistake (admin only).
 * Sends are kept; they count against whichever set is current at their time.
 */
export const DELETE: APIRoute = async ({ params, request }) => {
  const denied = await adminOnly(request);
  if (denied) return denied;

  const { id } = params;
  if (!id || !isValidUUID(id)) return badRequest('Invalid id');

  const { error } = await db.from('wall_resets').delete().eq('id', id);
  if (error) return serverError(error.message);
  return ok({ success: true });
};
