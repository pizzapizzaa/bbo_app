import { describe, it, expect, vi, beforeEach } from 'vitest';
import { makeBuilder } from './_utils';
import { scrypt } from 'crypto';
import { promisify } from 'util';

// ── Mock src/lib/db before importing anything that depends on it ───────────────
const mockFromFn = vi.hoisted(() => vi.fn());

vi.mock('../lib/db', () => ({
  db: { from: mockFromFn },
}));

import { signToken, adminOnly, forbidden, ELEVATED_TTL_MS } from '../lib/auth';
import { matchEnvAccount, isEnvAccountName, secretEquals, envValue } from '../lib/env-accounts';
import { insertOwned, canModifyRow } from '../lib/ownership';
import { verifyToken } from '../lib/auth';
import { POST as loginPost } from '../pages/api/auth/token';
import { POST as elevatePost } from '../pages/api/auth/elevate';
import { POST as refreshPost } from '../pages/api/auth/refresh';

/** Test env credentials come from vitest.config.ts `define`. */
const ADMIN    = { username: 'admin',     password: 'test-password' };
const PARTTIME = { username: 'parttimer', password: 'test-pt-password' };

const bearer = (token: string) => ({ Authorization: `Bearer ${token}` });

/** A login/elevate request. Each test uses its own IP so the rate limiters don't bleed. */
function jsonRequest(url: string, body: unknown, ip: string, headers: Record<string, string> = {}) {
  return new Request(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-forwarded-for': ip, ...headers },
    body: JSON.stringify(body),
  });
}

/** Invoke an APIRoute handler with only the fields these routes actually read. */
const call = (handler: any, request: Request, params: Record<string, string> = {}) =>
  handler({ request, params, url: new URL(request.url) } as any);

beforeEach(() => {
  mockFromFn.mockReset();
  mockFromFn.mockImplementation(() => makeBuilder({ data: [], error: null }));
});

// ── Env accounts ──────────────────────────────────────────────────────────────
describe('env accounts', () => {
  it('matches the admin account and reports the admin role', () => {
    expect(matchEnvAccount(ADMIN.username, ADMIN.password)).toEqual({
      ...ADMIN, role: 'admin',
    });
  });

  it('matches the part-timer account and reports the staff role', () => {
    expect(matchEnvAccount(PARTTIME.username, PARTTIME.password)).toEqual({
      ...PARTTIME, role: 'staff',
    });
  });

  it('rejects a correct username with the wrong password', () => {
    expect(matchEnvAccount(PARTTIME.username, ADMIN.password)).toBeNull();
    expect(matchEnvAccount(ADMIN.username, PARTTIME.password)).toBeNull();
  });

  it('rejects an unknown username', () => {
    expect(matchEnvAccount('nobody', PARTTIME.password)).toBeNull();
  });

  it('recognises env account names without checking the password', () => {
    expect(isEnvAccountName('admin')).toBe(true);
    expect(isEnvAccountName('parttimer')).toBe(true);
    expect(isEnvAccountName('someone-else')).toBe(false);
  });

  it('compares secrets of differing lengths without throwing', () => {
    expect(secretEquals('short', 'a-much-longer-secret')).toBe(false);
    expect(secretEquals('same', 'same')).toBe(true);
  });
});

// ── Login ─────────────────────────────────────────────────────────────────────
describe('POST /api/auth/token', () => {
  it('issues a staff-role token for the part-timer account', async () => {
    const res  = await call(loginPost, jsonRequest('http://localhost/api/auth/token', PARTTIME, '10.0.0.1'));
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.role).toBe('staff');

    const { u, r } = JSON.parse(Buffer.from(body.token.split('.')[0], 'base64url').toString('utf-8'));
    expect(u).toBe('parttimer');
    expect(r).toBe('staff');
  });

  it('issues an admin-role token for the admin account', async () => {
    const res  = await call(loginPost, jsonRequest('http://localhost/api/auth/token', ADMIN, '10.0.0.2'));
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.role).toBe('admin');
  });

  it('still logs the env admin in when staff_users holds active rows', async () => {
    // Regression guard: seeding staff_users must never lock the owner out of
    // their own env-var admin credentials.
    mockFromFn.mockImplementation(() =>
      makeBuilder({ data: [], error: null, count: 4 } as any)
    );

    const res  = await call(loginPost, jsonRequest('http://localhost/api/auth/token', ADMIN, '10.0.0.3'));
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.role).toBe('admin');
  });

  it('still logs the part-timer in when staff_users holds active rows', async () => {
    mockFromFn.mockImplementation(() =>
      makeBuilder({ data: [], error: null, count: 4 } as any)
    );

    const res = await call(loginPost, jsonRequest('http://localhost/api/auth/token', PARTTIME, '10.0.0.4'));
    expect(res.status).toBe(200);
    expect((await res.json()).role).toBe('staff');
  });

  it('rejects an unknown username when staff_users holds active rows', async () => {
    mockFromFn.mockImplementation(() =>
      makeBuilder({ data: [], error: null, count: 4 } as any)
    );

    const res = await call(
      loginPost,
      jsonRequest('http://localhost/api/auth/token', { username: 'ghost', password: 'x' }, '10.0.0.5'),
    );
    expect(res.status).toBe(401);
  });

  it('rejects the part-timer password given the admin username', async () => {
    const res = await call(
      loginPost,
      jsonRequest(
        'http://localhost/api/auth/token',
        { username: ADMIN.username, password: PARTTIME.password },
        '10.0.0.6',
      ),
    );
    expect(res.status).toBe(401);
  });

  it('logs in a staff_users row against its stored scrypt hash', async () => {
    // Regression guard: verifyScryptPassword calls timingSafeEqual, and the
    // function swallows its own errors. A missing import therefore surfaced as
    // "Invalid credentials" for every DB account rather than as a crash.
    const salt = 'a1b2c3d4';
    const hash = (await promisify(scrypt)('db-user-password', salt, 64) as Buffer).toString('hex');

    mockFromFn.mockImplementation(() => makeBuilder({
      data: [{
        id: 'u1', username: 'huyen', password_hash: `${salt}:${hash}`,
        role: 'admin', is_active: true,
      }],
      error: null,
    }));

    const res = await call(
      loginPost,
      jsonRequest('http://localhost/api/auth/token',
        { username: 'huyen', password: 'db-user-password' }, '10.0.0.7'),
    );
    expect(res.status).toBe(200);
    expect((await res.json()).role).toBe('admin');
  });

  it('rejects a staff_users row when the password is wrong', async () => {
    const salt = 'a1b2c3d4';
    const hash = (await promisify(scrypt)('db-user-password', salt, 64) as Buffer).toString('hex');

    mockFromFn.mockImplementation(() => makeBuilder({
      data: [{
        id: 'u1', username: 'huyen', password_hash: `${salt}:${hash}`,
        role: 'admin', is_active: true,
      }],
      error: null,
    }));

    const res = await call(
      loginPost,
      jsonRequest('http://localhost/api/auth/token',
        { username: 'huyen', password: 'not-it' }, '10.0.0.8'),
    );
    expect(res.status).toBe(401);
  });
});

// ── Env vars added after the build ────────────────────────────────────────────
// Vite inlines import.meta.env at build time, so a variable set in the hosting
// dashboard after the last deploy is `undefined` in the bundle — which folded
// the whole account away and rejected every login. The process.env fallback is
// what makes setting a credential take effect without a rebuild.
describe('envValue', () => {
  it('prefers the value baked in at build time', () => {
    process.env.BBO_TEST_CRED = 'from-runtime';
    expect(envValue('from-build', 'BBO_TEST_CRED')).toBe('from-build');
    delete process.env.BBO_TEST_CRED;
  });

  it('falls back to process.env when the build had no value', () => {
    process.env.BBO_TEST_CRED = 'from-runtime';
    expect(envValue(undefined, 'BBO_TEST_CRED')).toBe('from-runtime');
    delete process.env.BBO_TEST_CRED;
  });

  it('is empty when the variable is set in neither place', () => {
    delete process.env.BBO_TEST_CRED;
    expect(envValue(undefined, 'BBO_TEST_CRED')).toBe('');
  });

  it('falls back when the build value is an empty string, not just undefined', () => {
    // ?? would stop here and hand back "", defeating the runtime lookup.
    process.env.BBO_TEST_CRED = 'from-runtime';
    expect(envValue('', 'BBO_TEST_CRED')).toBe('from-runtime');
    delete process.env.BBO_TEST_CRED;
  });

  it('trims a pasted trailing newline or space', () => {
    // The credential compare is exact, so an invisible character is
    // indistinguishable from a wrong password.
    expect(envValue('  parttimer\n', 'BBO_TEST_CRED')).toBe('parttimer');
    process.env.BBO_TEST_CRED = 'secret \n';
    expect(envValue(undefined, 'BBO_TEST_CRED')).toBe('secret');
    delete process.env.BBO_TEST_CRED;
  });
});

// ── adminOnly guard ───────────────────────────────────────────────────────────
describe('adminOnly', () => {
  it('lets an admin token through', async () => {
    const req = new Request('http://localhost/api/expenses', { headers: bearer(signToken('boss', 'admin')) });
    await expect(adminOnly(req)).resolves.toBeNull();
  });

  it('returns 403 — not 401 — for a valid part-timer token', async () => {
    // 403 keeps the part-timer signed in and sends them to /unlock;
    // a 401 would blow away their session instead.
    const req = new Request('http://localhost/api/expenses', { headers: bearer(signToken('parttimer', 'staff')) });
    const res = await adminOnly(req);
    expect(res?.status).toBe(403);
  });

  it('returns 401 when no token is present', async () => {
    const res = await adminOnly(new Request('http://localhost/api/expenses'));
    expect(res?.status).toBe(401);
  });

  it('forbidden() carries a JSON error message', async () => {
    expect(await forbidden('nope').json()).toEqual({ error: 'nope' });
  });
});

// ── Elevation ─────────────────────────────────────────────────────────────────
describe('POST /api/auth/elevate', () => {
  it('trades the admin password for a short-lived admin token', async () => {
    const req = jsonRequest(
      'http://localhost/api/auth/elevate',
      { password: ADMIN.password },
      '10.0.1.1',
      bearer(signToken('parttimer', 'staff')),
    );
    const res  = await call(elevatePost, req);
    const body = await res.json();
    expect(res.status).toBe(200);

    const { u, r, e } = JSON.parse(Buffer.from(body.token.split('.')[0], 'base64url').toString('utf-8'));
    expect(r).toBe('admin');
    expect(u).toBe('admin');           // attributed to the admin who unlocked it
    expect(e - Date.now()).toBeLessThanOrEqual(ELEVATED_TTL_MS);
  });

  it('expires far sooner than a normal login token', async () => {
    const normal = JSON.parse(
      Buffer.from(signToken('admin', 'admin').split('.')[0], 'base64url').toString('utf-8'),
    );
    const elevated = JSON.parse(
      Buffer.from(signToken('admin', 'admin', ELEVATED_TTL_MS).split('.')[0], 'base64url').toString('utf-8'),
    );
    expect(elevated.e).toBeLessThan(normal.e);
  });

  it('rejects the part-timer password — only the admin password unlocks', async () => {
    const req = jsonRequest(
      'http://localhost/api/auth/elevate',
      { password: PARTTIME.password },
      '10.0.1.2',
      bearer(signToken('parttimer', 'staff')),
    );
    expect((await call(elevatePost, req)).status).toBe(401);
  });

  it('rejects an empty password', async () => {
    const req = jsonRequest(
      'http://localhost/api/auth/elevate',
      { password: '' },
      '10.0.1.3',
      bearer(signToken('parttimer', 'staff')),
    );
    expect((await call(elevatePost, req)).status).toBe(401);
  });

  it('refuses callers who are not signed in at all', async () => {
    const req = jsonRequest('http://localhost/api/auth/elevate', { password: ADMIN.password }, '10.0.1.4');
    expect((await call(elevatePost, req)).status).toBe(401);
  });

  it('rate-limits repeated wrong passwords', async () => {
    const attempt = () => call(elevatePost, jsonRequest(
      'http://localhost/api/auth/elevate',
      { password: 'guess' },
      '10.0.1.5',
      bearer(signToken('parttimer', 'staff')),
    ));

    for (let i = 0; i < 5; i++) expect((await attempt()).status).toBe(401);
    expect((await attempt()).status).toBe(429);
  });
});

// ── Elevation cannot be laundered into a long session ─────────────────────────
describe('POST /api/auth/refresh', () => {
  it('marks elevated tokens so they are distinguishable', async () => {
    expect(await verifyToken(signToken('admin', 'admin', ELEVATED_TTL_MS, true)))
      .toEqual({ username: 'admin', role: 'admin', elevated: true });
  });

  it('leaves ordinary tokens unmarked', async () => {
    expect(await verifyToken(signToken('admin', 'admin')))
      .toEqual({ username: 'admin', role: 'admin' });
  });

  it('refuses to extend an elevated token into a full session', async () => {
    // Otherwise a part-timer could lift the elevated token an admin left in
    // sessionStorage and refresh it into 8 hours of admin access.
    const elevated = signToken('admin', 'admin', ELEVATED_TTL_MS, true);
    const req = new Request('http://localhost/api/auth/refresh', {
      method: 'POST', headers: bearer(elevated),
    });
    expect((await call(refreshPost, req)).status).toBe(403);
  });

  it('still refreshes an ordinary part-timer token, preserving the staff role', async () => {
    const req = new Request('http://localhost/api/auth/refresh', {
      method: 'POST', headers: bearer(signToken('parttimer', 'staff')),
    });
    const res = await call(refreshPost, req);
    expect(res.status).toBe(200);

    const { r } = JSON.parse(
      Buffer.from((await res.json()).token.split('.')[0], 'base64url').toString('utf-8'),
    );
    expect(r).toBe('staff');
  });
});

// ── Row ownership ─────────────────────────────────────────────────────────────
describe('row ownership', () => {
  const staff = { username: 'parttimer', role: 'staff' as const };
  const admin = { username: 'boss',      role: 'admin' as const };

  it('stamps created_by with the inserting username', async () => {
    const builder = makeBuilder({ data: { id: 'x' }, error: null });
    mockFromFn.mockImplementation(() => builder);

    await insertOwned('schedule_entries', { staff_name: 'Kim An' }, staff);

    expect(builder.insert).toHaveBeenCalledWith({
      staff_name: 'Kim An',
      created_by: 'parttimer',
    });
  });

  it('lets an admin modify any row without a lookup', async () => {
    await expect(canModifyRow('checkins', 'row-1', admin)).resolves.toBe(true);
    expect(mockFromFn).not.toHaveBeenCalled();
  });

  it('lets a part-timer modify a row they created', async () => {
    mockFromFn.mockImplementation(() =>
      makeBuilder({ data: { created_by: 'parttimer' }, error: null })
    );
    await expect(canModifyRow('checkins', 'row-1', staff)).resolves.toBe(true);
  });

  it("refuses a part-timer another user's row", async () => {
    mockFromFn.mockImplementation(() =>
      makeBuilder({ data: { created_by: 'someone-else' }, error: null })
    );
    await expect(canModifyRow('checkins', 'row-1', staff)).resolves.toBe(false);
  });

  it('refuses a part-timer an unowned pre-migration row', async () => {
    mockFromFn.mockImplementation(() =>
      makeBuilder({ data: { created_by: null }, error: null })
    );
    await expect(canModifyRow('checkins', 'row-1', staff)).resolves.toBe(false);
  });

  it('refuses an unauthenticated caller', async () => {
    await expect(canModifyRow('checkins', 'row-1', null)).resolves.toBe(false);
  });

  it('retries the insert without created_by when the column is missing', async () => {
    // Fresh module instance: the "column is missing" flag is process-wide.
    vi.resetModules();
    const { insertOwned: freshInsert, canModifyRow: freshCanModify } = await import('../lib/ownership');

    const rejecting = makeBuilder({ data: null, error: { code: 'PGRST204', message: "column 'created_by' not found" } });
    const accepting = makeBuilder({ data: { id: 'x' }, error: null });
    mockFromFn.mockImplementationOnce(() => rejecting).mockImplementation(() => accepting);

    const res = await freshInsert('checkins', { customer_name: 'Ann' }, staff);

    expect(rejecting.insert).toHaveBeenCalledWith({ customer_name: 'Ann', created_by: 'parttimer' });
    expect(accepting.insert).toHaveBeenCalledWith({ customer_name: 'Ann' });
    expect(res.error).toBeNull();

    // With no ownership column, edit/delete stays admin-only.
    await expect(freshCanModify('checkins', 'row-1', staff)).resolves.toBe(false);
    await expect(freshCanModify('checkins', 'row-1', admin)).resolves.toBe(true);
  });
});
