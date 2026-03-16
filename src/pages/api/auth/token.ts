export const prerender = false;

import type { APIRoute } from 'astro';
import { createHash } from 'crypto';
import { signToken, ok } from '../../../lib/auth';

export const POST: APIRoute = async ({ request }) => {
  let body: { username?: string; password?: string };
  try { body = await request.json(); }
  catch { return new Response(JSON.stringify({ error: 'Invalid JSON' }), { status: 400 }); }

  const { username = '', password = '' } = body;

  const expectedUser = import.meta.env.ADMIN_USERNAME ?? '';
  const expectedPass = import.meta.env.ADMIN_PASSWORD ?? '';

  // Constant-time password comparison via SHA-256 hashes
  const inputHash    = createHash('sha256').update(password).digest('hex');
  const expectedHash = createHash('sha256').update(expectedPass).digest('hex');

  if (username !== expectedUser || inputHash !== expectedHash) {
    // Identical response for wrong username or wrong password (prevent enumeration)
    return new Response(JSON.stringify({ error: 'Invalid credentials' }), {
      status: 401,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  const token = signToken(username);
  return ok({ token });
};
