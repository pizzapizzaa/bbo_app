export const prerender = false;

import type { APIRoute } from 'astro';
import { authFromRequest, signToken, ok, forbidden } from '../../../lib/auth';

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

  // An elevation is a 30-minute loan of admin rights, granted by an admin
  // typing their password on someone else's session. Refreshing it would turn
  // that loan into a full 8-hour admin session, so it has to be re-earned.
  if (auth.elevated) {
    return forbidden('Elevated access cannot be extended — re-enter the admin password.');
  }

  const token = signToken(auth.username, auth.role);
  return ok({ token });
};
