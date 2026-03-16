import { createHmac, timingSafeEqual } from 'crypto';

const SESSION_SECRET = import.meta.env.SESSION_SECRET ?? 'dev-insecure-secret';

/** Issue a signed session token that expires in 12 hours. */
export function signToken(username: string): string {
  const exp     = Date.now() + 12 * 60 * 60 * 1000;
  const payload = `${username}.${exp}`;
  const sig     = createHmac('sha256', SESSION_SECRET).update(payload).digest('hex');
  return Buffer.from(`${payload}.${sig}`).toString('base64url');
}

/**
 * Verify a session token.
 * Returns the username if valid, null otherwise.
 */
export function verifyToken(token: string): string | null {
  try {
    const decoded = Buffer.from(token, 'base64url').toString('utf-8');
    // Format: username.exp.sig  (username may contain dots — split from the right)
    const lastDot   = decoded.lastIndexOf('.');
    const sig       = decoded.slice(lastDot + 1);
    const payload   = decoded.slice(0, lastDot);

    const expectedSig = createHmac('sha256', SESSION_SECRET).update(payload).digest('hex');

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

export function serverError(msg: string): Response {
  return new Response(JSON.stringify({ error: msg }), {
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
