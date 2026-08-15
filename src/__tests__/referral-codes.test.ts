import { describe, it, expect, vi, beforeEach } from 'vitest';
import { makeBuilder } from './_utils';

// ── Mock src/lib/db before importing the handlers ─────────────────────────────
const mockFromFn = vi.hoisted(() => vi.fn());

vi.mock('../lib/db', () => ({
  db: { from: mockFromFn },
}));

import { POST } from '../pages/api/referral-codes/index';
import { PATCH, DELETE } from '../pages/api/referral-codes/[id]';
import { GET as REFERRAL_GET } from '../pages/api/referral';
import { signToken } from '../lib/auth';

const OWNER_ID = 'cccc0000-0000-0000-0000-000000000003';
const CODE_ID  = 'dddd0000-0000-0000-0000-000000000004';

/** Promo codes are admin-only, so every request here carries an admin token. */
const ADMIN_AUTH = { Authorization: `Bearer ${signToken('test-admin', 'admin')}` };

function makeReq(body: unknown): Request {
  return new Request('http://localhost/api/referral-codes', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...ADMIN_AUTH },
    body: JSON.stringify(body),
  });
}

/** A bodyless authenticated request, for DELETE. */
function makeAuthedReq(): Request {
  return new Request('http://localhost/api/referral-codes', { headers: ADMIN_AUTH });
}

/** Wires each table to its own canned result and captures the insert payload. */
function mockTables(opts: {
  existingCode?: any;      // referral_codes lookup result (clash / current row)
  insertedCode?: any;      // row returned by insert/update .single()
  customer?: any;          // customers lookup result
}) {
  const captured: { insert: any; update: any } = { insert: null, update: null };
  mockFromFn.mockImplementation((table: string) => {
    if (table === 'referral_codes') {
      const builder = makeBuilder({ data: opts.existingCode ?? null, error: null });
      builder.insert = vi.fn().mockImplementation((payload: any) => {
        captured.insert = payload;
        return makeBuilder({ data: opts.insertedCode ?? null, error: null });
      });
      builder.update = vi.fn().mockImplementation((payload: any) => {
        captured.update = payload;
        return makeBuilder({ data: opts.insertedCode ?? null, error: null });
      });
      return builder;
    }
    // customers: `.in()` resolves to an array, `.maybeSingle()` to one row.
    const customers = makeBuilder({ data: opts.customer ? [opts.customer] : [], error: null });
    customers.maybeSingle = vi.fn().mockResolvedValue({ data: opts.customer ?? null, error: null });
    customers.single      = customers.maybeSingle;
    return customers;
  });
  return captured;
}

beforeEach(() => {
  mockFromFn.mockReset();
  mockFromFn.mockImplementation(() => makeBuilder({ data: null, error: null }));
});

// ── POST /api/referral-codes ──────────────────────────────────────────────────
describe('POST /api/referral-codes', () => {
  it('creates a universal promo code when owner_id is omitted', async () => {
    const captured = mockTables({
      insertedCode: {
        id: CODE_ID, code: 'SUMMER26', discount_pct: 20,
        owner_id: null, label: 'Summer 2026', is_active: true, created_at: '2026-06-01T00:00:00Z',
      },
    });

    const res = await POST({ request: makeReq({ code: 'summer26', discount_pct: 20, label: '  Summer  2026 ' }) } as any);

    expect(res.status).toBe(200);
    expect(captured.insert).toMatchObject({
      code:         'SUMMER26',      // normalised to uppercase
      discount_pct: 20,
      owner_id:     null,            // no owner → gym-wide promo
      label:        'Summer 2026',   // whitespace collapsed
      is_active:    true,
    });
    expect(await res.json()).toMatchObject({ row: { code: 'SUMMER26', owner_name: '' } });
  });

  it('stores a rental discount when one is given', async () => {
    const captured = mockTables({
      insertedCode: {
        id: CODE_ID, code: 'HANIE10', discount_pct: 10, rental_discount_pct: 50,
        owner_id: null, label: '', is_active: true, created_at: '2026-08-12T00:00:00Z',
      },
    });

    const res = await POST({ request: makeReq({ code: 'HANIE10', discount_pct: 10, rental_discount_pct: 50 }) } as any);

    expect(res.status).toBe(200);
    expect(captured.insert).toMatchObject({ code: 'HANIE10', discount_pct: 10, rental_discount_pct: 50 });
    expect(await res.json()).toMatchObject({ row: { rental_discount_pct: 50 } });
  });

  it('defaults the rental discount to 0 when omitted', async () => {
    const captured = mockTables({
      insertedCode: {
        id: CODE_ID, code: 'SUMMER26', discount_pct: 20, rental_discount_pct: 0,
        owner_id: null, label: '', is_active: true, created_at: '2026-06-01T00:00:00Z',
      },
    });
    await POST({ request: makeReq({ code: 'SUMMER26', discount_pct: 20 }) } as any);
    expect(captured.insert).toMatchObject({ rental_discount_pct: 0 });
  });

  it('returns 400 for an out-of-range rental discount', async () => {
    const res = await POST({ request: makeReq({ code: 'SUMMER26', discount_pct: 20, rental_discount_pct: 150 }) } as any);
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({
      error: 'Rental discount must be a whole number between 0 and 100.',
    });
  });

  it('creates a customer-owned code and reports the owner name', async () => {
    mockTables({
      customer:     { id: OWNER_ID, full_name: 'Bao Tran' },
      insertedCode: {
        id: CODE_ID, code: 'BAOTRAN-4F2K', discount_pct: 15,
        owner_id: OWNER_ID, label: '', is_active: true, created_at: '2026-06-01T00:00:00Z',
      },
    });

    const res = await POST({ request: makeReq({ code: 'BAOTRAN-4F2K', discount_pct: 15, owner_id: OWNER_ID }) } as any);

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      row: { code: 'BAOTRAN-4F2K', owner_id: OWNER_ID, owner_name: 'Bao Tran' },
    });
  });

  it('lets one customer hold several codes', async () => {
    // A clash check that finds an *unrelated* code must not block the insert.
    const captured = mockTables({
      existingCode: { id: 'other-id', code: 'BAOTRAN-4F2K' },
      customer:     { id: OWNER_ID, full_name: 'Bao Tran' },
      insertedCode: {
        id: 'eeee0000-0000-0000-0000-000000000005', code: 'BAOTRAN-2ND', discount_pct: 25,
        owner_id: OWNER_ID, label: 'Gym poster', is_active: true, created_at: '2026-06-02T00:00:00Z',
      },
    });

    const res = await POST({ request: makeReq({ code: 'BAOTRAN-2ND', discount_pct: 25, label: 'Gym poster', owner_id: OWNER_ID }) } as any);

    expect(res.status).toBe(200);
    expect(captured.insert).toMatchObject({ code: 'BAOTRAN-2ND', owner_id: OWNER_ID });
  });

  it('returns 409 when the code already exists, case-insensitively', async () => {
    mockTables({ existingCode: { id: 'other-id', code: 'summer26' } });
    const res = await POST({ request: makeReq({ code: 'SUMMER26', discount_pct: 20 }) } as any);
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ error: 'That code is already in use.' });
  });

  it('returns 400 for a malformed code', async () => {
    const res = await POST({ request: makeReq({ code: 'ab', discount_pct: 20 }) } as any);
    expect(res.status).toBe(400);
  });

  it('returns 400 for an out-of-range discount', async () => {
    const res = await POST({ request: makeReq({ code: 'SUMMER26', discount_pct: 0 }) } as any);
    expect(res.status).toBe(400);
  });

  it('returns 400 for a non-UUID owner_id', async () => {
    const res = await POST({ request: makeReq({ code: 'SUMMER26', discount_pct: 20, owner_id: 'not-a-uuid' }) } as any);
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: 'Invalid owner id' });
  });

  it('returns 404 when the owner does not exist', async () => {
    mockTables({ customer: null });
    const res = await POST({ request: makeReq({ code: 'SUMMER26', discount_pct: 20, owner_id: OWNER_ID }) } as any);
    expect(res.status).toBe(404);
  });
});

// ── PATCH / DELETE /api/referral-codes/:id ────────────────────────────────────
describe('PATCH /api/referral-codes/:id', () => {
  it('pauses a code without touching its other fields', async () => {
    const captured = mockTables({
      insertedCode: {
        id: CODE_ID, code: 'SUMMER26', discount_pct: 20,
        owner_id: null, label: '', is_active: false, created_at: '2026-06-01T00:00:00Z',
      },
    });

    const res = await PATCH({
      params:  { id: CODE_ID },
      request: makeReq({ is_active: false }),
    } as any);

    expect(res.status).toBe(200);
    expect(captured.update).toEqual({ is_active: false });
  });

  it('returns 400 when no updatable field is supplied', async () => {
    const res = await PATCH({ params: { id: CODE_ID }, request: makeReq({}) } as any);
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: 'No fields to update' });
  });

  it('returns 409 when renaming onto an existing code', async () => {
    mockTables({ existingCode: { id: 'other-id', code: 'TAKEN-123' } });
    const res = await PATCH({ params: { id: CODE_ID }, request: makeReq({ code: 'taken-123' }) } as any);
    expect(res.status).toBe(409);
  });

  it('returns 400 for a non-UUID id', async () => {
    const res = await PATCH({ params: { id: 'nope' }, request: makeReq({ is_active: false }) } as any);
    expect(res.status).toBe(400);
  });

  it('deletes a code by id', async () => {
    mockTables({});
    const res = await DELETE({ params: { id: CODE_ID }, request: makeAuthedReq() } as any);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ success: true });
  });
});

// ── GET /api/referral (check-in form lookup) ──────────────────────────────────
describe('GET /api/referral', () => {
  function lookupReq(qs: string) {
    return REFERRAL_GET({ url: new URL('http://localhost/api/referral?' + qs) } as any);
  }

  it('reports a promo code as kind "promo" with no owner', async () => {
    mockTables({
      existingCode: {
        id: CODE_ID, code: 'SUMMER26', discount_pct: 20,
        owner_id: null, label: 'Summer 2026', is_active: true,
      },
    });
    const res = await lookupReq('code=summer26');
    expect(await res.json()).toMatchObject({
      valid: true, code: 'SUMMER26', kind: 'promo', owner_name: '', label: 'Summer 2026',
      discount_pct: 20, rental_discount_pct: 0,
    });
  });

  it('passes the rental discount through to the check-in form', async () => {
    mockTables({
      existingCode: {
        id: CODE_ID, code: 'HANIE10', discount_pct: 10, rental_discount_pct: 50,
        owner_id: null, label: '', is_active: true,
      },
    });
    const res = await lookupReq('code=hanie10');
    expect(await res.json()).toMatchObject({
      valid: true, code: 'HANIE10', discount_pct: 10, rental_discount_pct: 50,
    });
  });

  it('reports a customer code as kind "referral" with the owner name', async () => {
    mockFromFn.mockImplementation((table: string) => {
      if (table === 'referral_codes') {
        return makeBuilder({
          data: { id: CODE_ID, code: 'BAOTRAN-4F2K', discount_pct: 15, owner_id: OWNER_ID, label: '', is_active: true },
          error: null,
        });
      }
      return makeBuilder({ data: { full_name: 'Bao Tran' }, error: null });
    });
    const res = await lookupReq('code=BAOTRAN-4F2K');
    expect(await res.json()).toMatchObject({
      valid: true, kind: 'referral', owner_id: OWNER_ID, owner_name: 'Bao Tran', discount_pct: 15,
    });
  });

  it('rejects a customer quoting their own code', async () => {
    mockFromFn.mockImplementation((table: string) => {
      if (table === 'referral_codes') {
        return makeBuilder({
          data: { id: CODE_ID, code: 'BAOTRAN-4F2K', discount_pct: 15, owner_id: OWNER_ID, label: '', is_active: true },
          error: null,
        });
      }
      return makeBuilder({ data: { full_name: 'Bao Tran' }, error: null });
    });
    const res = await lookupReq('code=BAOTRAN-4F2K&customer=bao%20tran');
    expect(await res.json()).toMatchObject({
      valid: false, error: 'A customer cannot use their own referral code.',
    });
  });

  it('accepts a promo code for any customer', async () => {
    mockTables({
      existingCode: {
        id: CODE_ID, code: 'SUMMER26', discount_pct: 20, owner_id: null, label: '', is_active: true,
      },
    });
    const res = await lookupReq('code=SUMMER26&customer=Alice%20Nguyen');
    expect(await res.json()).toMatchObject({ valid: true, kind: 'promo' });
  });

  it('reports a paused code as unusable', async () => {
    mockTables({
      existingCode: {
        id: CODE_ID, code: 'OLDPROMO', discount_pct: 20, owner_id: null, label: '', is_active: false,
      },
    });
    const res = await lookupReq('code=OLDPROMO');
    expect(await res.json()).toMatchObject({ valid: false, error: 'That code is no longer active.' });
  });

  it('reports an unknown code as not found', async () => {
    mockTables({ existingCode: null });
    const res = await lookupReq('code=NOPE-1234');
    expect(await res.json()).toMatchObject({ valid: false, error: 'Referral or promo code not found.' });
  });
});
