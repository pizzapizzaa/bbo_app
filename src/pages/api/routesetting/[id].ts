export const prerender = false;

import type { APIRoute } from 'astro';
import { db } from '../../../lib/db';
import { ok, serverError } from '../../../lib/auth';
import { isValidUUID, isValidDate, MAX_TEXT } from '../../../lib/validate';

/** PATCH /api/routesetting/:id — update an existing routesetting session */
export const PATCH: APIRoute = async ({ params, request }) => {
  const { id } = params;
  if (!id || !isValidUUID(id)) {
    return new Response(JSON.stringify({ error: 'Invalid id' }), { status: 400 });
  }

  let body: { date?: string; walls?: string; setters?: string; styles?: string; notes?: string };
  try { body = await request.json(); }
  catch { return new Response(JSON.stringify({ error: 'Invalid JSON' }), { status: 400 }); }

  const { date, walls, setters, styles, notes } = body;

  if (!date) {
    return new Response(JSON.stringify({ error: 'Missing required field: date' }), { status: 400 });
  }
  if (!isValidDate(String(date))) {
    return new Response(JSON.stringify({ error: 'Invalid date format (expected YYYY-MM-DD)' }), { status: 400 });
  }

  for (const [field, val] of [['walls', walls], ['setters', setters], ['styles', styles]] as [string, string | undefined][]) {
    if (val !== undefined) {
      try { const parsed = JSON.parse(val); if (!Array.isArray(parsed)) throw new Error(); }
      catch { return new Response(JSON.stringify({ error: `${field} must be a valid JSON array` }), { status: 400 }); }
    }
  }

  if ((notes ?? '').length > MAX_TEXT) {
    return new Response(JSON.stringify({ error: 'notes exceeds maximum length' }), { status: 400 });
  }

  const { data, error } = await db
    .from('routesetting_entries')
    .update({
      date,
      walls:   walls   ?? '[]',
      setters: setters ?? '[]',
      styles:  styles  ?? '[]',
      notes:   notes   ?? '',
    })
    .eq('id', id)
    .select()
    .single();

  if (error) return serverError(error.message);
  return ok({ entry: data });
};

/** DELETE /api/routesetting/:id */
export const DELETE: APIRoute = async ({ params }) => {
  const { id } = params;
  if (!id || !isValidUUID(id)) {
    return new Response(JSON.stringify({ error: 'Invalid id' }), { status: 400 });
  }

  const { error } = await db
    .from('routesetting_entries')
    .delete()
    .eq('id', id);

  if (error) return serverError(error.message);
  return ok({ success: true });
};
