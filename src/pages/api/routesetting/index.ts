export const prerender = false;

import type { APIRoute } from 'astro';
import { db } from '../../../lib/db';
import { ok, serverError } from '../../../lib/auth';
import { fetchAllPages } from '../../../lib/paginate';
import { isValidDate, MAX_TEXT } from '../../../lib/validate';

/** GET /api/routesetting — return all routesetting entries */
export const GET: APIRoute = async () => {
  const { data, error } = await fetchAllPages((from, to) =>
    db.from('routesetting_entries').select('*').order('date', { ascending: false }).range(from, to)
  );

  if (error) return serverError(error.message);
  return ok({ entries: data });
};

/** POST /api/routesetting — add a new routesetting session */
export const POST: APIRoute = async ({ request }) => {
  let body: { date: string; walls?: string; setters?: string; styles?: string; notes?: string };
  try { body = await request.json(); }
  catch { return new Response(JSON.stringify({ error: 'Invalid JSON' }), { status: 400 }); }

  const { date, walls, setters, styles, notes } = body;

  if (!date) {
    return new Response(JSON.stringify({ error: 'Missing required field: date' }), { status: 400 });
  }
  if (!isValidDate(String(date))) {
    return new Response(JSON.stringify({ error: 'Invalid date format (expected YYYY-MM-DD)' }), { status: 400 });
  }

  // Validate JSON strings are valid JSON arrays
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
    .insert({
      date,
      walls:   walls   ?? '[]',
      setters: setters ?? '[]',
      styles:  styles  ?? '[]',
      notes:   notes   ?? '',
    })
    .select()
    .single();

  if (error) return serverError(error.message);
  return ok({ entry: data });
};
