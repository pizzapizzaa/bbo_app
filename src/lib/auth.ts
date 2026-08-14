import { createHmac, createHash, timingSafeEqual } from 'crypto';
import { db } from './db';

// ── Types ─────────────────────────────────────────────────────────────────────
export type UserRole = 'admin' | 'staff';

export interface AuthInfo {
  username: string;
  role: UserRole;
  /**
   * Present only on tokens minted by /api/auth/elevate. Marks a borrowed
   * 30-minute admin session so it cannot be laundered into a full-length one
   * via /api/auth/refresh. Omitted (rather than false) on ordinary tokens.
   */
  elevated?: true;
}

// ── Secret ────────────────────────────────────────────────────────────────────
function getSecret(): string {
  const secret = import.meta.env.SESSION_SECRET;
  if (!secret) {
    throw new Error(
      'SESSION_SECRET environment variable is required. ' +
      'Set it in .env (local) and in Vercel Environment Variables (production).'
    );
  }
  return secret;
}

// ── Token signing ─────────────────────────────────────────────────────────────
// Token lifetime reduced to 8 h; the /api/auth/refresh endpoint handles
// automatic renewal so active sessions are unaffected.
const TOKEN_TTL_MS = 8 * 60 * 60 * 1000;

/**
 * Lifetime of an elevation token — the short-lived admin token minted by
 * /api/auth/elevate when a part-timer types the admin password to open a
 * gated page. Deliberately far shorter than a login session: a shop tablet
 * left unattended re-locks itself.
 */
export const ELEVATED_TTL_MS = 30 * 60 * 1000;

// Token format: base64url(JSON{u,r,e,x?}) + "." + base64url(HMAC-SHA256)
// where u=username, r=role, e=expiry_epoch_ms, x=1 marks an elevated token.
// This format embeds role in the signed payload, avoiding ambiguous dot-splitting.

/** Issue a signed session token for the given user. */
export function signToken(
  username: string,
  role: UserRole,
  ttlMs: number = TOKEN_TTL_MS,
  elevated = false,
): string {
  const claims: Record<string, unknown> = { u: username, r: role, e: Date.now() + ttlMs };
  if (elevated) claims.x = 1;
  const payload = Buffer.from(JSON.stringify(claims)).toString('base64url');
  const sig = createHmac('sha256', getSecret()).update(payload).digest('base64url');
  return `${payload}.${sig}`;
}

// ── Token verification ────────────────────────────────────────────────────────
/**
 * Verify a session token.
 * Returns AuthInfo if the token is valid and not revoked, null otherwise.
 * Performs a DB-backed revocation check, loading from Supabase on cold start
 * and using the in-memory cache for warm invocations.
 */
export async function verifyToken(token: string): Promise<AuthInfo | null> {
  try {
    const dot = token.lastIndexOf('.');
    if (dot < 0) return null;

    const payload = token.slice(0, dot);
    const sig     = token.slice(dot + 1);

    const expectedSig = createHmac('sha256', getSecret()).update(payload).digest('base64url');

    // Timing-safe comparison
    const sigBuf = Buffer.from(sig,         'base64url');
    const expBuf = Buffer.from(expectedSig, 'base64url');
    if (sigBuf.length !== expBuf.length || !timingSafeEqual(sigBuf, expBuf)) return null;

    const { u, r, e, x } = JSON.parse(Buffer.from(payload, 'base64url').toString('utf-8'));
    if (!u || !r || !e || Date.now() > e) return null;

    if (await isTokenRevoked(token)) return null;

    const info: AuthInfo = { username: String(u), role: r as UserRole };
    if (x === 1) info.elevated = true;
    return info;
  } catch {
    return null;
  }
}

/** Extract and verify the Bearer token from an Authorization header. */
export async function authFromRequest(request: Request): Promise<AuthInfo | null> {
  const header = request.headers.get('Authorization') ?? '';
  const token  = header.startsWith('Bearer ') ? header.slice(7).trim() : null;
  return token ? verifyToken(token) : null;
}

/** Returns AuthInfo if the request carries a valid admin token, null otherwise. */
export async function requireAdmin(request: Request): Promise<AuthInfo | null> {
  const auth = await authFromRequest(request);
  return auth?.role === 'admin' ? auth : null;
}

/**
 * Guard for admin-only endpoints (customers, promo codes, expenses).
 *
 * Returns null when the caller is an admin — callers treat that as "proceed".
 * Otherwise returns the Response to send back: 401 when the token is missing
 * or invalid, 403 when it is a valid part-timer token. The two are kept
 * distinct on purpose — the browser turns 401 into a logout, but a 403 means
 * "you are logged in, you just need the admin password", which sends the
 * part-timer to the unlock page instead of destroying their session.
 */
export async function adminOnly(request: Request): Promise<Response | null> {
  const auth = await authFromRequest(request);
  if (!auth) return unauthorized();
  if (auth.role !== 'admin') return forbidden();
  return null;
}

// ── Token revocation (DB-backed, in-memory cached) ────────────────────────────
const revokedHashes = new Set<string>();
let revocationCacheLoaded = false;

function tokenHash(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

/**
 * Load all non-expired revoked token hashes from DB into the in-memory cache.
 * Called once per cold start; subsequent calls are no-ops while the cache is warm.
 */
async function ensureRevocationCache(): Promise<void> {
  if (revocationCacheLoaded) return;
  revocationCacheLoaded = true; // prevent concurrent duplicate loads
  try {
    const { data } = await db
      .from('revoked_tokens')
      .select('token_hash')
      .gte('expires_at', new Date().toISOString());
    (data ?? []).forEach((r: any) => revokedHashes.add(r.token_hash));
  } catch {
    // DB unavailable — continue with empty cache; allow retry on next cold start
    revocationCacheLoaded = false;
  }
}

async function isTokenRevoked(token: string): Promise<boolean> {
  const hash = tokenHash(token);
  if (revokedHashes.has(hash)) return true; // fast path (warm invocation)
  await ensureRevocationCache();             // cold-start DB load
  return revokedHashes.has(hash);
}

/**
 * Revoke a token both in-memory and in the database.
 * In-memory revocation takes effect immediately; DB write persists across cold starts.
 */
export async function revokeToken(token: string): Promise<void> {
  const hash = tokenHash(token);
  revokedHashes.add(hash);

  // Extract the token's own expiry to set the DB row TTL (best-effort)
  let expiresAt = new Date(Date.now() + TOKEN_TTL_MS);
  try {
    const dot = token.lastIndexOf('.');
    if (dot > 0) {
      const { e } = JSON.parse(Buffer.from(token.slice(0, dot), 'base64url').toString('utf-8'));
      if (typeof e === 'number') expiresAt = new Date(e);
    }
  } catch { /* use default */ }

  try {
    await db.from('revoked_tokens').upsert({ token_hash: hash, expires_at: expiresAt.toISOString() });
  } catch {
    // In-memory revocation still took effect; DB failure is non-fatal
  }
}

// ── Response helpers ──────────────────────────────────────────────────────────
export function unauthorized(): Response {
  return new Response(JSON.stringify({ error: 'Unauthorized' }), {
    status: 401,
    headers: { 'Content-Type': 'application/json' },
  });
}

/**
 * 403 — authenticated, but this role may not do that. Distinct from 401 so the
 * browser can offer the admin-password unlock instead of logging the user out.
 */
export function forbidden(msg = 'Admin access required'): Response {
  return new Response(JSON.stringify({ error: msg }), {
    status: 403,
    headers: { 'Content-Type': 'application/json' },
  });
}

export function serverError(internalMsg?: unknown): Response {
  if (internalMsg) console.error('[API Error]', internalMsg);
  return new Response(JSON.stringify({ error: 'Internal server error' }), {
    status: 500,
    headers: { 'Content-Type': 'application/json' },
  });
}

export function ok(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}
