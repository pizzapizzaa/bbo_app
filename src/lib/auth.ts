import { createHmac, timingSafeEqual } from 'crypto';

/**
 * Lazily read SESSION_SECRET so that a missing value throws at runtime
 * (per-request) rather than silently using an insecure fallback.
 */
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

/**
 * In-memory token revocation list.
 * Survives warm-function restarts; cleared on cold start.
 * For persistent revocation, store revoked tokens in the database.
 */
const revokedTokens = new Set<string>();

export function revokeToken(token: string): void {
  revokedTokens.add(token);
  // Guard against unbounded growth in long-lived instances.
  if (revokedTokens.size > 10_000) revokedTokens.clear();
}

/** Issue a signed session token that expires in 12 hours. */
export function signToken(username: string): string {
  const exp     = Date.now() + 12 * 60 * 60 * 1000;
  const payload = `${username}.${exp}`;
  const sig     = createHmac('sha256', getSecret()).update(payload).digest('hex');
  return Buffer.from(`${payload}.${sig}`).toString('base64url');
}

/**
 * Verify a session token.
 * Returns the username if valid, null otherwise.
 */
export function verifyToken(token: string): string | null {
  try {
    // Reject tokens that have been explicitly revoked via /api/auth/logout.
    if (revokedTokens.has(token)) return null;

    const decoded = Buffer.from(token, 'base64url').toString('utf-8');
    // Format: username.exp.sig  (username may contain dots — split from the right)
    const lastDot   = decoded.lastIndexOf('.');
    const sig       = decoded.slice(lastDot + 1);
    const payload   = decoded.slice(0, lastDot);

    const expectedSig = createHmac('sha256', getSecret()).update(payload).digest('hex');

    // Timing-safe comparison
    const sigBuf = Buffer.from(sig,         'hex');
    const expBuf = Buffer.from(expectedSig, 'hex');
    if (sigBuf.length !== expBuf.length || !timingSafeEqual(sigBuf, expBuf)) return null;

    // Check expiry
    const dotIdx  = payload.lastIndexOf('.');
    const exp     = parseInt(payload.slice(dotIdx + 1), 10);
    const username = payload.slice(0, dotIdx);
    if (!username || Date.now() > exp) return null;

    return username;
  } catch {
    return null;
  }
}

/** Extract and verify the Bearer token from an Authorization header. */
export function authFromRequest(request: Request): string | null {
  const header = request.headers.get('Authorization') ?? '';
  const token  = header.startsWith('Bearer ') ? header.slice(7).trim() : null;
  return token ? verifyToken(token) : null;
}

export function unauthorized(): Response {
  return new Response(JSON.stringify({ error: 'Unauthorized' }), {
    status: 401,
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
