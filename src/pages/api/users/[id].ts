export const prerender = false;

import type { APIRoute } from 'astro';
import { requireAdmin, serverError, ok, unauthorized } from '../../../lib/auth';
import { db } from '../../../lib/db';
import { isValidUUID } from '../../../lib/validate';

/** PATCH /api/users/[id] — update a user's role or active status (admin only) */
export const PATCH: APIRoute = async ({ request, params }) => {
  if (!await requireAdmin(request)) return unauthorized();

  const { id } = params;
  if (!id || !isValidUUID(id)) {
    return new Response(JSON.stringify({ error: 'Invalid user ID' }), { status: 400 });
  }

  let body: { role?: string; is_active?: boolean };
  try { body = await request.json(); }
  catch { return new Response(JSON.stringify({ error: 'Invalid JSON' }), { status: 400 }); }

  const updates: Record<string, unknown> = {};
  if (body.role !== undefined) {
    if (!['admin', 'staff'].includes(body.role)) {
      return new Response(JSON.stringify({ error: "role must be 'admin' or 'staff'" }), { status: 400 });
    }
    updates.role = body.role;
  }
  if (body.is_active !== undefined) {
    updates.is_active = Boolean(body.is_active);
  }
  if (Object.keys(updates).length === 0) {
    return new Response(JSON.stringify({ error: 'No fields to update' }), { status: 400 });
  }

  const { data, error } = await db
    .from('staff_users')
    .update(updates)
    .eq('id', id)
    .select('id, username, role, is_active, created_at')
    .single();

  if (error) return serverError(error.message);
  if (!data) return new Response(JSON.stringify({ error: 'User not found' }), { status: 404 });

  return ok({ user: data });
};

/** DELETE /api/users/[id] — deactivate a staff account (admin only, soft delete) */
export const DELETE: APIRoute = async ({ request, params }) => {
  if (!await requireAdmin(request)) return unauthorized();

  const { id } = params;
  if (!id || !isValidUUID(id)) {
    return new Response(JSON.stringify({ error: 'Invalid user ID' }), { status: 400 });
  }

  const { data, error } = await db
    .from('staff_users')
    .update({ is_active: false })
    .eq('id', id)
    .select('id')
    .single();

  if (error) return serverError(error.message);
  if (!data) return new Response(JSON.stringify({ error: 'User not found' }), { status: 404 });

  return ok({ deactivated: true });
};
