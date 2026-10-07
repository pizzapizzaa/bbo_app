export const prerender = false;

import type { APIRoute } from 'astro';
import { db } from '../../../lib/db';
import { authFromRequest, ok, serverError, unauthorized } from '../../../lib/auth';
import { isValidUUID } from '../../../lib/validate';
import { parseBetaVideoFields } from '../../../lib/beta-videos';

/** PATCH /api/beta-videos/:id — edit a destination or archive/restore its QR. */
export const PATCH: APIRoute = async ({ params, request }) => {
  if (!await authFromRequest(request)) return unauthorized();
  const { id } = params;
  if (!id || !isValidUUID(id)) {
    return new Response(JSON.stringify({ error: 'Invalid id' }), { status: 400 });
  }

  try {
    let body: unknown;
    try { body = await request.json(); }
    catch { return new Response(JSON.stringify({ error: 'Invalid JSON' }), { status: 400 }); }

    const parsed = parseBetaVideoFields(body, true);
    if (parsed.error) return new Response(JSON.stringify({ error: parsed.error }), { status: 400 });

    const { data, error } = await db.from('beta_videos')
      .update({ ...parsed.fields, updated_at: new Date().toISOString() })
      .eq('id', id)
      .select('*')
      .single();
    if (error?.code === 'PGRST116' || (!error && !data)) {
      return new Response(JSON.stringify({ error: 'Beta video not found' }), { status: 404 });
    }
    if (error) return serverError(error.message);
    return ok({ video: data });
  } catch (error: any) {
    return serverError(error?.message ?? String(error));
  }
};
