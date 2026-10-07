export const prerender = false;

import type { APIRoute } from 'astro';
import { db } from '../../../lib/db';
import { authFromRequest, ok, serverError, unauthorized } from '../../../lib/auth';
import { parseBetaVideoFields } from '../../../lib/beta-videos';

/** GET /api/beta-videos — list records for any signed-in POS user. */
export const GET: APIRoute = async ({ request }) => {
  if (!await authFromRequest(request)) return unauthorized();

  try {
    const { data, error } = await db
      .from('beta_videos')
      .select('*')
      .order('wall', { ascending: true })
      .order('route', { ascending: true });
    if (error) return serverError(error.message);
    return ok({ videos: data ?? [] });
  } catch (error: any) {
    return serverError(error?.message ?? String(error));
  }
};

/** POST /api/beta-videos — create a QR destination; staff and admins may manage it. */
export const POST: APIRoute = async ({ request }) => {
  const auth = await authFromRequest(request);
  if (!auth) return unauthorized();

  try {
    let body: unknown;
    try { body = await request.json(); }
    catch { return new Response(JSON.stringify({ error: 'Invalid JSON' }), { status: 400 }); }

    const parsed = parseBetaVideoFields(body);
    if (parsed.error) return new Response(JSON.stringify({ error: parsed.error }), { status: 400 });

    const { data, error } = await db.from('beta_videos')
      .insert({ ...parsed.fields, created_by: auth.username })
      .select('*')
      .single();
    if (error) return serverError(error.message);
    return ok({ video: data }, 201);
  } catch (error: any) {
    return serverError(error?.message ?? String(error));
  }
};
