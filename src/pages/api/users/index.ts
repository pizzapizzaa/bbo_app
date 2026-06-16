export const prerender = false;

import type { APIRoute } from 'astro';
import { scrypt, randomBytes } from 'crypto';
import { promisify } from 'util';
import { requireAdmin, serverError, ok, unauthorized } from '../../../lib/auth';
import { db } from '../../../lib/db';

const scryptAsync = promisify(scrypt);

/** Hash a plaintext password for DB storage using scrypt. */
export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16).toString('hex');
  const hash = await scryptAsync(password, salt, 64) as Buffer;
  return `${salt}:${hash.toString('hex')}`;
}

/** GET /api/users — list all staff accounts (admin only) */
export const GET: APIRoute = async ({ request }) => {
  if (!await requireAdmin(request)) return unauthorized();

  const { data, error } = await db
    .from('staff_users')
    .select('id, username, role, is_active, created_at')
    .order('created_at', { ascending: true });

  if (error) return serverError(error.message);
  return ok({ users: data });
};

/** POST /api/users — create a new staff account (admin only) */
export const POST: APIRoute = async ({ request }) => {
  if (!await requireAdmin(request)) return unauthorized();

  let body: { username?: string; password?: string; role?: string };
  try { body = await request.json(); }
  catch { return new Response(JSON.stringify({ error: 'Invalid JSON' }), { status: 400 }); }

  const { username, password, role = 'staff' } = body;

  if (!username || !password) {
    return new Response(JSON.stringify({ error: 'username and password are required' }), { status: 400 });
  }
  if (username.trim().length === 0 || username.length > 100) {
    return new Response(JSON.stringify({ error: 'username must be 1–100 characters' }), { status: 400 });
  }
  if (password.length < 8) {
    return new Response(JSON.stringify({ error: 'password must be at least 8 characters' }), { status: 400 });
  }
  if (!['admin', 'staff'].includes(role)) {
    return new Response(JSON.stringify({ error: "role must be 'admin' or 'staff'" }), { status: 400 });
  }

  const password_hash = await hashPassword(password);

  const { data, error } = await db
    .from('staff_users')
    .insert({ username: username.trim(), password_hash, role })
    .select('id, username, role, is_active, created_at')
    .single();

  if (error) {
    if (error.code === '23505') {
      return new Response(JSON.stringify({ error: 'Username already exists' }), { status: 409 });
    }
    return serverError(error.message);
  }

  return ok({ user: data }, 201);
};
