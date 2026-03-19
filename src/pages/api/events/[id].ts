export const prerender = false;

import type { APIRoute } from 'astro';
import { db } from '../../../lib/db';
import { ok, serverError } from '../../../lib/auth';

/** PATCH /api/events/:id — admin only */
export const PATCH: APIRoute = async ({ params, request }) => {
  const { id } = params;
  if (!id) return new Response(JSON.stringify({ error: 'Missing id' }), { status: 400 });

  let body: {
    event_type?: string;
    title?: string;
    date?: string;
    start_time?: string;
    end_time?: string;
    description?: string;
  };

  try { body = await request.json(); }
  catch { return new Response(JSON.stringify({ error: 'Invalid JSON' }), { status: 400 }); }

  const VALID_TYPES = ['beginner101', 'pt_classes', 'jp_classes', 'other'];
  if (body.event_type && !VALID_TYPES.includes(body.event_type)) {
    return new Response(JSON.stringify({ error: 'Invalid event_type' }), { status: 400 });
  }

  // Only update provided fields
  const updates: Record<string, string> = {};
  if (body.event_type  !== undefined) updates.event_type  = body.event_type;
  if (body.title       !== undefined) updates.title       = body.title;
  if (body.date        !== undefined) updates.date        = body.date;
  if (body.start_time  !== undefined) updates.start_time  = body.start_time;
  if (body.end_time    !== undefined) updates.end_time    = body.end_time;
  if (body.description !== undefined) updates.description = body.description;

  if (Object.keys(updates).length === 0) {
    return new Response(JSON.stringify({ error: 'No fields to update' }), { status: 400 });
  }

  const { data, error } = await db
    .from('event_entries')
    .update(updates)
    .eq('id', id)
    .select()
    .single();

  if (error) return serverError(error.message);
  return ok({ entry: data });
};

/** DELETE /api/events/:id — admin only */
export const DELETE: APIRoute = async ({ params }) => {
  const { id } = params;
  if (!id) return new Response(JSON.stringify({ error: 'Missing id' }), { status: 400 });

  const { error } = await db
    .from('event_entries')
    .delete()
    .eq('id', id);

  if (error) return serverError(error.message);
  return ok({ success: true });
};
