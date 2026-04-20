export const prerender = false;

import type { APIRoute } from 'astro';
import { revokeToken, verifyToken, ok } from '../../../lib/auth';

/**
 * POST /api/auth/logout
 * Revokes the supplied Bearer token server-side.
 * Always returns 200 to avoid leaking information about token validity.
 */
export const POST: APIRoute = async ({ request }) => {
  const header = request.headers.get('Authorization') ?? '';
  const token  = header.startsWith('Bearer ') ? header.slice(7).trim() : null;

  if (token && verifyToken(token)) {
    revokeToken(token);
  }

  return ok({ success: true });
};
