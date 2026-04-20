export const prerender = false;

import type { APIRoute } from 'astro';
import { createHash, timingSafeEqual } from 'crypto';
import { signToken, ok } from '../../../lib/auth';

// ── Server-side rate limiter ─────────────────────────────────────────────────
// Module-level state persists across warm-function invocations on the same
// instance, providing meaningful protection even in a serverless environment.
const loginAttempts = new Map<string, { count: number; resetAt: number }>();
const RATE_LIMIT_MAX    = 10;              // max attempts per window
const RATE_LIMIT_WINDOW = 15 * 60 * 1000; // 15-minute rolling window

function checkRateLimit(ip: string): boolean {
  const now = Date.now();
  const rec = loginAttempts.get(ip);
  if (!rec || rec.resetAt < now) {
    loginAttempts.set(ip, { count: 1, resetAt: now + RATE_LIMIT_WINDOW });
    return true;
  }
  if (rec.count >= RATE_LIMIT_MAX) return false;
  rec.count++;
  return true;
}

export const POST: APIRoute = async ({ request }) => {
  // Extract client IP (Vercel sets x-forwarded-for)
  const ip = request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ?? 'unknown';
  if (!checkRateLimit(ip)) {
    return new Response(JSON.stringify({ error: 'Too many login attempts. Try again later.' }), {
      status: 429,
      headers: { 'Content-Type': 'application/json', 'Retry-After': '900' },
    });
  }

  let body: { username?: string; password?: string };
  try { body = await request.json(); }
  catch { return new Response(JSON.stringify({ error: 'Invalid JSON' }), { status: 400 }); }

  const { username = '', password = '' } = body;

  const expectedUser = import.meta.env.ADMIN_USERNAME ?? '';
  const expectedPass = import.meta.env.ADMIN_PASSWORD ?? '';

  // Timing-safe comparison for both username and password via SHA-256 hashes.
  // Hashing ensures equal-length buffers; timingSafeEqual prevents timing attacks.
  const usernameOk = timingSafeEqual(
    createHash('sha256').update(username).digest(),
    createHash('sha256').update(expectedUser).digest(),
  );
  const passwordOk = timingSafeEqual(
    createHash('sha256').update(password).digest(),
    createHash('sha256').update(expectedPass).digest(),
  );

  if (!usernameOk || !passwordOk) {
    // Identical response for wrong username or wrong password (prevent enumeration)
    return new Response(JSON.stringify({ error: 'Invalid credentials' }), {
      status: 401,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  // Reset rate-limit counter on successful login
  loginAttempts.delete(ip);

  const token = signToken(username);
  return ok({ token });
};
