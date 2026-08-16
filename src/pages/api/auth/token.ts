export const prerender = false;

import type { APIRoute } from 'astro';
import { scrypt, timingSafeEqual, randomBytes as _randomBytes } from 'crypto';
import { promisify } from 'util';
import { signToken, ok } from '../../../lib/auth';
import { isEnvAccountName, matchEnvAccount } from '../../../lib/env-accounts';
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
  // If the staff_users table has any active accounts, only those accounts — plus
  // the env-configured accounts (step 2) — can log in.
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
        const role = user.role as 'admin' | 'staff';
        loginAttempts.delete(ip);
        return ok({ token: signToken(user.username, role), role });
      }

      // Username not in DB. Unless it names an env-configured account, the
      // login is simply invalid whenever the table holds active users.
      if (!isEnvAccountName(username.trim())) {
        const { count } = await db
          .from('staff_users')
          .select('id', { count: 'exact', head: true })
          .eq('is_active', true);
        if (count && count > 0) {
          return invalidCreds();
        }
      }
      // Env account name, or empty table → fall through to step 2
    }
    // queryErr (e.g. table doesn't exist yet) → fall through to step 2
  } catch {
    // DB unavailable → fall through to step 2
  }

  // ── 2. Env-var accounts (admin bootstrap + shared part-timer) ───────────────
  // Checked regardless of whether staff_users holds rows, so adding staff to
  // that table can never lock the owner out of their own admin credentials.
  const account = matchEnvAccount(username.trim(), password);
  if (!account) {
    return invalidCreds();
  }

  loginAttempts.delete(ip);
  return ok({ token: signToken(account.username, account.role), role: account.role });
};
