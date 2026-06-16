import { describe, it, expect, vi, beforeEach } from 'vitest';
import { makeBuilder } from './_utils';

// ── Mock src/lib/db before importing anything that depends on it ───────────────
// vi.hoisted ensures the variable exists when vi.mock's factory runs (which is
// hoisted to the top of the file by vitest).
const mockFromFn = vi.hoisted(() => vi.fn());

vi.mock('../lib/db', () => ({
  db: { from: mockFromFn },
}));

// Import auth AFTER the mock is registered
import {
  signToken,
  verifyToken,
  revokeToken,
  authFromRequest,
  requireAdmin,
} from '../lib/auth';

beforeEach(() => {
  mockFromFn.mockReset();
  // Default: empty revoked-token list for cold-start cache load; upserts succeed.
  mockFromFn.mockImplementation(() =>
    makeBuilder({ data: [], error: null })
  );
});

// ── signToken ─────────────────────────────────────────────────────────────────
describe('signToken', () => {
  it('returns a non-empty two-part dot-separated string', () => {
    const token = signToken('alice', 'admin');
    expect(token).toMatch(/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
  });

  it('encodes username and role in the base64url payload', () => {
    const token = signToken('bob', 'staff');
    const [payload] = token.split('.');
    const { u, r } = JSON.parse(Buffer.from(payload, 'base64url').toString('utf-8'));
    expect(u).toBe('bob');
    expect(r).toBe('staff');
  });

  it('includes a future expiry timestamp in the payload', () => {
    const before = Date.now();
    const token  = signToken('carol', 'admin');
    const [payload] = token.split('.');
    const { e } = JSON.parse(Buffer.from(payload, 'base64url').toString('utf-8'));
    expect(e).toBeGreaterThan(before);
  });

  it('produces distinct tokens for different usernames', () => {
    expect(signToken('user-a', 'admin')).not.toBe(signToken('user-b', 'admin'));
  });
});

// ── verifyToken ───────────────────────────────────────────────────────────────
describe('verifyToken', () => {
  it('returns AuthInfo for a freshly signed admin token', async () => {
    const token = signToken('alice', 'admin');
    await expect(verifyToken(token)).resolves.toEqual({ username: 'alice', role: 'admin' });
  });

  it('returns AuthInfo for a freshly signed staff token', async () => {
    const token = signToken('staff-member', 'staff');
    await expect(verifyToken(token)).resolves.toEqual({ username: 'staff-member', role: 'staff' });
  });

  it('returns null for an empty string', async () => {
    await expect(verifyToken('')).resolves.toBeNull();
  });

  it('returns null for a completely invalid string', async () => {
    await expect(verifyToken('not.a.valid.token')).resolves.toBeNull();
  });

  it('returns null when the signature is tampered', async () => {
    const token   = signToken('alice', 'admin');
    const flipped = token.slice(0, -1) + (token.endsWith('A') ? 'B' : 'A');
    await expect(verifyToken(flipped)).resolves.toBeNull();
  });

  it('returns null when the payload is tampered (username change)', async () => {
    const token = signToken('alice', 'admin');
    const [payload, sig] = token.split('.');
    // Decode, change username, re-encode — signature no longer matches
    const obj      = JSON.parse(Buffer.from(payload, 'base64url').toString('utf-8'));
    obj.u          = 'hacker';
    const newPayload = Buffer.from(JSON.stringify(obj)).toString('base64url');
    await expect(verifyToken(`${newPayload}.${sig}`)).resolves.toBeNull();
  });

  it('returns null for an expired token', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));

    const token = signToken('alice', 'admin');

    // Advance 9 hours — past the 8-hour TTL
    vi.advanceTimersByTime(9 * 60 * 60 * 1000);
    await expect(verifyToken(token)).resolves.toBeNull();

    vi.useRealTimers();
  });

  it('returns null for a token that has been revoked', async () => {
    const token = signToken('revoked-user', 'staff');
    await revokeToken(token);
    await expect(verifyToken(token)).resolves.toBeNull();
  });
});

// ── revokeToken ───────────────────────────────────────────────────────────────
describe('revokeToken', () => {
  it('causes verifyToken to return null for the revoked token', async () => {
    const token = signToken('dave', 'staff');
    // Confirm valid before revocation
    await expect(verifyToken(token)).resolves.not.toBeNull();

    await revokeToken(token);
    await expect(verifyToken(token)).resolves.toBeNull();
  });

  it('does not invalidate a different token', async () => {
    const tokenA = signToken('user-a', 'staff');
    const tokenB = signToken('user-b', 'admin');

    await revokeToken(tokenA);

    await expect(verifyToken(tokenA)).resolves.toBeNull();
    await expect(verifyToken(tokenB)).resolves.not.toBeNull();
  });
});

// ── authFromRequest ───────────────────────────────────────────────────────────
describe('authFromRequest', () => {
  it('returns AuthInfo for a valid Bearer token', async () => {
    const token = signToken('carol', 'admin');
    const req   = new Request('http://localhost/', {
      headers: { Authorization: `Bearer ${token}` },
    });
    await expect(authFromRequest(req)).resolves.toEqual({ username: 'carol', role: 'admin' });
  });

  it('returns null when the Authorization header is absent', async () => {
    const req = new Request('http://localhost/');
    await expect(authFromRequest(req)).resolves.toBeNull();
  });

  it('returns null for Basic auth scheme (non-Bearer)', async () => {
    const req = new Request('http://localhost/', {
      headers: { Authorization: 'Basic dXNlcjpwYXNz' },
    });
    await expect(authFromRequest(req)).resolves.toBeNull();
  });

  it('returns null for an empty Bearer value', async () => {
    const req = new Request('http://localhost/', {
      headers: { Authorization: 'Bearer ' },
    });
    await expect(authFromRequest(req)).resolves.toBeNull();
  });
});

// ── requireAdmin ──────────────────────────────────────────────────────────────
describe('requireAdmin', () => {
  it('returns AuthInfo for a valid admin token', async () => {
    const token = signToken('admin-user', 'admin');
    const req   = new Request('http://localhost/', {
      headers: { Authorization: `Bearer ${token}` },
    });
    await expect(requireAdmin(req)).resolves.toEqual({ username: 'admin-user', role: 'admin' });
  });

  it('returns null for a staff token (insufficient role)', async () => {
    const token = signToken('staff-user', 'staff');
    const req   = new Request('http://localhost/', {
      headers: { Authorization: `Bearer ${token}` },
    });
    await expect(requireAdmin(req)).resolves.toBeNull();
  });

  it('returns null when no token is provided', async () => {
    const req = new Request('http://localhost/');
    await expect(requireAdmin(req)).resolves.toBeNull();
  });
});
