export const prerender = false;

import type { APIRoute } from 'astro';
import { timingSafeEqual, scrypt } from 'crypto';
import { promisify } from 'util';
import { authFromRequest, signToken, ok, unauthorized, ELEVATED_TTL_MS } from '../../../lib/auth';
import { envAdmin, secretEquals } from '../../../lib/env-accounts';
import { db } from '../../../lib/db';

const scryptAsync = promisify(scrypt);

/**
 * POST /api/auth/elevate — trade the admin password for a short-lived admin token.
 *
 * Used by the unlock page when a part-timer opens Customers, Promo Codes or
 * Expenses. The caller must already hold a valid session token; this endpoint
 * only raises that session's privileges for ELEVATED_TTL_MS, it is not a
 * second way to log in. Admins never hit this path — they already carry an
 * admin token, so their workflow is untouched.
 */

// ── Rate limiter ─────────────────────────────────────────────────────────────
// Tighter than the login limiter: this endpoint is reachable only by someone
// already signed in, so repeated failures mean password guessing.
const attempts = new Map<string, { count: number; resetAt: number }>();
const RATE_LIMIT_MAX    = 5;
const RATE_LIMIT_WINDOW = 15 * 60 * 1000;

function checkRateLimit(key: string): boolean {
  const now = Date.now();
  const rec = attempts.get(key);
  if (!rec || rec.resetAt < now) {
    attempts.set(key, { count: 1, resetAt: now + RATE_LIMIT_WINDOW });
    return true;
  }
  if (rec.count >= RATE_LIMIT_MAX) return false;
  rec.count++;
  return true;
}

async function verifyScryptPassword(stored: string, input: string): Promise<boolean> {
  const [salt, hashHex] = stored.split(':');
  if (!salt || !hashHex) return false;
  try {
    const hash       = await scryptAsync(input, salt, 64) as Buffer;
    const storedHash = Buffer.from(hashHex, 'hex');
    return hash.length === storedHash.length && timingSafeEqual(hash, storedHash);
  } catch {
    return false;
  }
}

/**
 * Check `password` against every admin credential the deployment recognises:
 * the env-var admin, plus any active admin row in staff_users.
 * Returns the admin username that matched, or null.
 */
async function matchAnyAdminPassword(password: string): Promise<string | null> {
  const env = envAdmin();
  if (env && secretEquals(password, env.password)) return env.username;

  try {
    const { data, error } = await db
      .from('staff_users')
      .select('username, password_hash')
      .eq('role', 'admin')
      .eq('is_active', true);
    if (error) return null;
    for (const user of data ?? []) {
      if (await verifyScryptPassword(user.password_hash, password)) return user.username;
    }
  } catch {
    // DB unavailable — the env admin above was the only chance
  }
  return null;
}

const wrongPassword = (): Response =>
  new Response(JSON.stringify({ error: 'Incorrect admin password' }), {
    status: 401,
    headers: { 'Content-Type': 'application/json' },
  });

export const POST: APIRoute = async ({ request }) => {
  // Must already be signed in as someone.
  const auth = await authFromRequest(request);
  if (!auth) return unauthorized();

  const ip  = request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ?? 'unknown';
  const key = `${auth.username}:${ip}`;
  if (!checkRateLimit(key)) {
    return new Response(JSON.stringify({ error: 'Too many attempts. Try again later.' }), {
      status: 429,
      headers: { 'Content-Type': 'application/json', 'Retry-After': '900' },
    });
  }

  let body: { password?: string };
  try { body = await request.json(); }
  catch { return new Response(JSON.stringify({ error: 'Invalid JSON' }), { status: 400 }); }

  const password = body.password ?? '';
  if (!password) return wrongPassword();

  const adminUsername = await matchAnyAdminPassword(password);
  if (!adminUsername) return wrongPassword();

  attempts.delete(key);

  // The elevated token carries the ADMIN's identity, so anything written while
  // elevated is attributed to the admin whose password opened the page.
  return ok({
    token:      signToken(adminUsername, 'admin', ELEVATED_TTL_MS, true),
    expires_at: Date.now() + ELEVATED_TTL_MS,
    expires_in: ELEVATED_TTL_MS,
  });
};
