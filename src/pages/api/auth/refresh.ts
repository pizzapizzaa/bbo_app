export const prerender = false;

import type { APIRoute } from 'astro';
import { authFromRequest, signToken, ok } from '../../../lib/auth';

/**
 * POST /api/auth/refresh
 * Accepts a valid (non-expired) token and returns a fresh 8-hour token.
 * Called automatically by the client when the token is within 1 hour of expiry.
 */
export const POST: APIRoute = async ({ request }) => {
  const auth = await authFromRequest(request);
  if (!auth) {
    return new Response(JSON.stringify({ error: 'Unauthorized' }), {
      status: 401,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  const token = signToken(auth.username, auth.role);
  return ok({ token });
};
