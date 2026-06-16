export const prerender = false;

import type { APIRoute } from 'astro';
import { createHash, timingSafeEqual, scrypt, randomBytes as _randomBytes } from 'crypto';
import { promisify } from 'util';
import { signToken, ok } from '../../../lib/auth';
import { db } from '../../../lib/db';

const scryptAsync = promisify(scrypt);

// ── Server-side rate limiter ─────────────────────────────────────────────────
const loginAttempts = new Map<string, { count: number; resetAt: number }>();
const RATE_LIMIT_MAX    = 10;
const RATE_LIMIT_WINDOW = 15 * 60 * 1000;

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

// ── scrypt password verification ─────────────────────────────────────────────
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

const invalidCreds = (): Response =>
  new Response(JSON.stringify({ error: 'Invalid credentials' }), {
    status: 401,
    headers: { 'Content-Type': 'application/json' },
  });

export const POST: APIRoute = async ({ request }) => {
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

  // ── 1. DB staff users (primary path) ────────────────────────────────────────
  // If the staff_users table has any active accounts, only those accounts can log in.
  // The env-var bootstrap is only used when the table is empty (initial deployment).
  try {
    const { data: users, error: queryErr } = await db
      .from('staff_users')
      .select('id, username, password_hash, role, is_active')
      .eq('username', username.trim())
      .eq('is_active', true)
      .limit(1);

    if (!queryErr) {
      if (users && users.length > 0) {
        // User found in DB — verify password
        const user = users[0];
        if (!await verifyScryptPassword(user.password_hash, password)) {
          return invalidCreds();
        }
        loginAttempts.delete(ip);
        return ok({ token: signToken(user.username, user.role as 'admin' | 'staff') });
      }

      // Username not in DB — check whether the table has ANY active users.
      // If it does, the unknown username is simply invalid; don't fall through.
      const { count } = await db
        .from('staff_users')
        .select('id', { count: 'exact', head: true })
        .eq('is_active', true);
      if (count && count > 0) {
        return invalidCreds();
      }
      // Table is empty → fall through to env-var bootstrap below
    }
    // queryErr (e.g. table doesn't exist yet) → fall through to env-var bootstrap
  } catch {
    // DB unavailable → fall through to env-var bootstrap
  }

  // ── 2. Env-var bootstrap (fallback when staff_users table is empty) ──────────
  const expectedUser = import.meta.env.ADMIN_USERNAME ?? '';
  const expectedPass = import.meta.env.ADMIN_PASSWORD ?? '';

  const usernameOk = timingSafeEqual(
    createHash('sha256').update(username).digest(),
    createHash('sha256').update(expectedUser).digest(),
  );
  const passwordOk = timingSafeEqual(
    createHash('sha256').update(password).digest(),
    createHash('sha256').update(expectedPass).digest(),
  );

  if (!usernameOk || !passwordOk) {
    return invalidCreds();
  }

  loginAttempts.delete(ip);
  return ok({ token: signToken(username, 'admin') });
};

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
