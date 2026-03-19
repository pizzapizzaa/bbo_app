export const prerender = false;

import type { APIRoute } from 'astro';
import { db } from '../../../lib/db';
import { ok, serverError } from '../../../lib/auth';
import { fetchAllPages } from '../../../lib/paginate';

/** GET /api/events — public, returns all event entries ordered by date/time */
export const GET: APIRoute = async () => {
  const { data, error } = await fetchAllPages((from, to) =>
    db
      .from('event_entries')
      .select('*')
      .order('date', { ascending: true })
      .order('start_time', { ascending: true })
      .range(from, to)
  );

  if (error) return serverError(error.message);
  return ok({ entries: data });
};

/** POST /api/events — admin only (enforced in middleware) */
export const POST: APIRoute = async ({ request }) => {
  let body: {
    event_type: string;
    title?: string;
    date: string;
    start_time: string;
    end_time: string;
    description?: string;
  };

  try { body = await request.json(); }
  catch { return new Response(JSON.stringify({ error: 'Invalid JSON' }), { status: 400 }); }

  const { event_type, title, date, start_time, end_time, description } = body;

  const VALID_TYPES = ['beginner101', 'pt_classes', 'jp_classes', 'other'];
  if (!event_type || !VALID_TYPES.includes(event_type)) {
    return new Response(JSON.stringify({ error: 'Invalid or missing event_type' }), { status: 400 });
  }
  if (!date || !start_time || !end_time) {
    return new Response(JSON.stringify({ error: 'Missing required fields: date, start_time, end_time' }), { status: 400 });
  }

  const { data, error } = await db
    .from('event_entries')
    .insert({
      event_type,
      title:       title       ?? '',
      date,
      start_time,
      end_time,
      description: description ?? '',
    })
    .select()
    .single();

  if (error) return serverError(error.message);
  return ok({ entry: data }, 201);
};
