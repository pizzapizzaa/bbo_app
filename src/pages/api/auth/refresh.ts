export const prerender = false;

import type { APIRoute } from 'astro';
import { authFromRequest, signToken, ok } from '../../../lib/auth';

/**
 * POST /api/auth/refresh
 * Accepts a valid (non-expired) token and returns a fresh 30-day token.
 * Called automatically by the client when the token is within 7 days of expiry.
 */
export const POST: APIRoute = async ({ request }) => {
  const username = authFromRequest(request);
  if (!username) {
    return new Response(JSON.stringify({ error: 'Unauthorized' }), {
      status: 401,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  const token = signToken(username);
  return ok({ token });
};
