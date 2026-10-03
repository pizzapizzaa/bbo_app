export const prerender = false;

import type { APIRoute } from 'astro';
import { db } from '../../../../lib/db';
import { adminOnly, authFromRequest, ok, serverError } from '../../../../lib/auth';
import { fetchAllPages } from '../../../../lib/paginate';
import {
  WALLS,
  getCurrentReset,
  validateWallReset,
  wallResetRow,
} from '../../../../lib/wall-config';

const badRequest = (error: string, status = 400) =>
  new Response(JSON.stringify({ error }), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });

/**
 * GET /api/walls/resets — every reset on record, newest first, plus each
 * wall's current set and how many sends have been logged on it.
 * Any signed-in staff may read; only admins may change resets.
 */
export const GET: APIRoute = async () => {
  const { data: resets, error } = await fetchAllPages((from, to) =>
    db.from('wall_resets').select('*').order('closes_at', { ascending: false }).range(from, to)
  );
  if (error) return serverError(error.message);

  const current = await Promise.all(WALLS.map(async wall => {
    const reset = await getCurrentReset(wall);
    if (!reset) return { wall, resetId: null, sendsLogged: 0 };
    const { count } = await db
      .from('leaderboard_sends')
      .select('id', { count: 'exact', head: true })
      .eq('wall', wall)
      .gte('logged_at', reset.closes_at);
    return { wall, resetId: reset.id, sendsLogged: count ?? 0 };
  }));

  return ok({ resets, current, now: new Date().toISOString() });
};

/** POST /api/walls/resets — record a wall reset (admin only). */
export const POST: APIRoute = async ({ request }) => {
  const denied = await adminOnly(request);
  if (denied) return denied;

  let body: Record<string, unknown>;
  try { body = await request.json(); }
  catch { return badRequest('Invalid JSON'); }

  const result = validateWallReset(body);
  if ('error' in result) return badRequest(result.error);

  const auth = await authFromRequest(request);
  const { data, error } = await db
    .from('wall_resets')
    .insert({ ...wallResetRow(result.value), created_by: auth?.username ?? null })
    .select()
    .single();

  if (error) {
    if (error.code === '23505') {
      return badRequest(`${result.value.wall} already has a reset closing at that time.`, 409);
    }
    return serverError(error.message);
  }
  return ok({ reset: data }, 201);
};
