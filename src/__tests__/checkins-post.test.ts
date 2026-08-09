import { describe, it, expect, vi, beforeEach } from 'vitest';
import { makeBuilder } from './_utils';

// ── Mock src/lib/db before importing the handler ──────────────────────────────
const mockFromFn = vi.hoisted(() => vi.fn());

vi.mock('../lib/db', () => ({
  db: { from: mockFromFn },
}));

import { POST } from '../pages/api/checkins/index';

// ── Helpers ───────────────────────────────────────────────────────────────────
function makeReq(body: unknown): Request {
  return new Request('http://localhost/api/checkins', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

/** Minimal valid body for a cash day-pass check-in. */
const validBody = {
  customer_name:  'Alice Nguyen',
  date:           '2026-06-15',
  time:           '10:30:00',
  payment_method: 'Cash',
  amount:         50_000,
};

/** Checkin row the DB insert is expected to return. */
const mockCheckin = {
  id:                    'aaaa0000-0000-0000-0000-000000000001',
  customer_name:         'Alice Nguyen',
  date:                  '2026-06-15',
  time:                  '10:30:00',
  payment_method:        'Cash',
  amount:                50_000,
  notes:                 '',
  checked_in_at:         '2026-06-15T10:30:00Z',
  punch_card_holder_id:  null,
  punch_card_holder_name:'',
  pt_punch_holder_id:    null,
  pt_punch_holder_name:  '',
  checkin_type:          '',
  addons:                '',
};

beforeEach(() => {
  mockFromFn.mockReset();
  // Sensible defaults: all DB calls succeed with empty/null data
  mockFromFn.mockImplementation(() =>
    makeBuilder({ data: null, error: null })
  );
});

// ── Input validation (all return early before any DB call) ────────────────────
describe('POST /api/checkins — input validation', () => {
  it('returns 400 for malformed JSON body', async () => {
    const req = new Request('http://localhost/api/checkins', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: 'not-json{{}',
    });
    const res = await POST({ request: req } as any);
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: 'Invalid JSON' });
  });

  it('returns 400 when customer_name is missing', async () => {
    const { customer_name: _, ...body } = validBody;
    const res = await POST({ request: makeReq(body) } as any);
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: 'Missing required fields' });
  });

  it('returns 400 when date is missing', async () => {
    const { date: _, ...body } = validBody;
    const res = await POST({ request: makeReq(body) } as any);
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: 'Missing required fields' });
  });

  it('returns 400 when time is missing', async () => {
    const { time: _, ...body } = validBody;
    const res = await POST({ request: makeReq(body) } as any);
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: 'Missing required fields' });
  });

  it('returns 400 when payment_method is missing', async () => {
    const { payment_method: _, ...body } = validBody;
    const res = await POST({ request: makeReq(body) } as any);
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: 'Missing required fields' });
  });

  it('returns 400 when customer_name exceeds MAX_NAME (300 chars)', async () => {
    const res = await POST({
      request: makeReq({ ...validBody, customer_name: 'A'.repeat(301) }),
    } as any);
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: 'customer_name too long' });
  });

  it('returns 400 for an invalid date format (DD/MM/YYYY)', async () => {
    const res = await POST({
      request: makeReq({ ...validBody, date: '15/06/2026' }),
    } as any);
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: expect.stringContaining('Invalid date') });
  });

  it('returns 400 for an impossible calendar date', async () => {
    const res = await POST({
      request: makeReq({ ...validBody, date: '2026-13-01' }),
    } as any);
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: expect.stringContaining('Invalid date') });
  });

  it('returns 400 for an invalid time format (single-digit hour)', async () => {
    const res = await POST({
      request: makeReq({ ...validBody, time: '9:30' }),
    } as any);
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: expect.stringContaining('Invalid time') });
  });

  it('returns 400 when notes exceed MAX_TEXT (1000 chars)', async () => {
    const res = await POST({
      request: makeReq({ ...validBody, notes: 'x'.repeat(1001) }),
    } as any);
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: 'notes exceeds maximum length' });
  });

  it('accepts notes at exactly MAX_TEXT (1000 chars) and proceeds to DB', async () => {
    // Configure DB so the request gets past validation
    mockFromFn.mockImplementation((table: string) => {
      if (table === 'checkins') return makeBuilder({ data: mockCheckin, error: null });
      return makeBuilder({ data: { id: 'cust-1' }, error: null });
    });
    const res = await POST({
      request: makeReq({ ...validBody, notes: 'x'.repeat(1000) }),
    } as any);
    expect(res.status).toBe(200);
  });
});

// ── Membership validation ─────────────────────────────────────────────────────
describe('POST /api/checkins — membership validation', () => {
  it('returns 400 when customer has no membership and payment is "Valid Membership"', async () => {
    // DB returns null → no membership record found
    mockFromFn.mockImplementation(() =>
      makeBuilder({ data: null, error: null })
    );
    const res = await POST({
      request: makeReq({ ...validBody, payment_method: 'Valid Membership' }),
    } as any);
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: 'Customer has no active membership.' });
  });

  it('returns 400 when the membership has expired', async () => {
    mockFromFn.mockImplementation(() =>
      makeBuilder({
        data:  { membership_type: '1 Month', membership_end_date: '2020-01-01' },
        error: null,
      })
    );
    const res = await POST({
      request: makeReq({ ...validBody, payment_method: 'Valid Membership' }),
    } as any);
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: 'Membership has expired.' });
  });

  it('allows check-in when the membership is still active', async () => {
    mockFromFn.mockImplementation((table: string) => {
      if (table === 'checkins') {
        return makeBuilder({ data: mockCheckin, error: null });
      }
      // customers: active membership + existing record (skips auto-create)
      return makeBuilder({
        data:  { id: 'cust-1', membership_type: '1 Month', membership_end_date: '2099-12-31' },
        error: null,
      });
    });
    const res = await POST({
      request: makeReq({ ...validBody, payment_method: 'Valid Membership' }),
    } as any);
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json).toHaveProperty('checkin');
  });
});

// ── Successful insert ─────────────────────────────────────────────────────────
describe('POST /api/checkins — successful insert', () => {
  it('returns 200 with the new checkin for a valid cash payment', async () => {
    mockFromFn.mockImplementation((table: string) => {
      if (table === 'checkins') return makeBuilder({ data: mockCheckin, error: null });
      // customers: maybeSingle returns existing record → skip auto-create
      return makeBuilder({ data: { id: 'cust-1' }, error: null });
    });

    const res  = await POST({ request: makeReq(validBody) } as any);
    expect(res.status).toBe(200);

    const json = await res.json();
    expect(json).toHaveProperty('checkin');
    expect(json.checkin.customer_name).toBe('Alice Nguyen');
    expect(json.checkin.payment_method).toBe('Cash');
    expect(json.checkin.amount).toBe(50_000);
  });

  it('auto-creates a customer record when the name is not found in DB', async () => {
    let customersInsertCalled = false;

    mockFromFn.mockImplementation((table: string) => {
      if (table === 'checkins') return makeBuilder({ data: mockCheckin, error: null });

      if (table === 'customers') {
        const builder = makeBuilder({ data: null, error: null });
        // Intercept insert to track the call
        builder.insert = vi.fn().mockImplementation(() => {
          customersInsertCalled = true;
          return makeBuilder({ data: { id: 'new-cust' }, error: null });
        });
        return builder;
      }
      return makeBuilder({ data: null, error: null });
    });

    await POST({ request: makeReq(validBody) } as any);
    expect(customersInsertCalled).toBe(true);
  });

  it('deducts one punch from the punch card holder when using Punch Card payment', async () => {
    const holderId = 'bbbb0000-0000-0000-0000-000000000002';
    let punchDeducted = false;

    mockFromFn.mockImplementation((table: string) => {
      if (table === 'checkins') return makeBuilder({ data: { ...mockCheckin, payment_method: 'Punch Card', punch_card_holder_id: holderId, punch_card_holder_name: 'Alice Nguyen' }, error: null });

      if (table === 'customers') {
        const builder = makeBuilder({ data: { id: holderId, punches_remaining: 5 }, error: null });
        builder.update = vi.fn().mockImplementation(() => {
          punchDeducted = true;
          return makeBuilder({ data: null, error: null });
        });
        return builder;
      }
      return makeBuilder({ data: null, error: null });
    });

    const body = {
      ...validBody,
      payment_method:        'Punch Card',
      punch_card_holder_id:  holderId,
      punch_card_holder_name:'Alice Nguyen',
    };
    const res = await POST({ request: makeReq(body) } as any);
    expect(res.status).toBe(200);
    expect(punchDeducted).toBe(true);
  });

  it('returns 500 when the checkin DB insert fails', async () => {
    mockFromFn.mockImplementation((table: string) => {
      if (table === 'checkins') {
        return makeBuilder({ data: null, error: { message: 'connection timeout' } });
      }
      return makeBuilder({ data: null, error: null });
    });

    const res = await POST({ request: makeReq(validBody) } as any);
    expect(res.status).toBe(500);
  });
});

// ── Referral codes ────────────────────────────────────────────────────────────
describe('POST /api/checkins — referral code', () => {
  /** Wires the customers table to a single code owner and captures the insert. */
  function mockOwner(owner: any) {
    const captured: { payload: any } = { payload: null };
    mockFromFn.mockImplementation((table: string) => {
      if (table === 'checkins') {
        const builder = makeBuilder({ data: mockCheckin, error: null });
        builder.insert = vi.fn().mockImplementation((payload: any) => {
          captured.payload = payload;
          return makeBuilder({ data: mockCheckin, error: null });
        });
        return builder;
      }
      return makeBuilder({ data: owner, error: null });
    });
    return captured;
  }

  it('records the owner on the check-in when the code is valid', async () => {
    const captured = mockOwner({
      id: 'cccc0000-0000-0000-0000-000000000003',
      full_name: 'Bao Tran',
      referral_code: 'BAOTRAN-4F2K',
      referral_discount_pct: 15,
    });

    const res = await POST({
      request: makeReq({ ...validBody, referral_code: 'baotran-4f2k' }),
    } as any);

    expect(res.status).toBe(200);
    expect(captured.payload).toMatchObject({
      referral_code:         'BAOTRAN-4F2K',   // normalised to uppercase
      referred_by_id:        'cccc0000-0000-0000-0000-000000000003',
      referred_by_name:      'Bao Tran',
      referral_discount_pct: 15,
    });
  });

  it('returns 400 when the code does not belong to any customer', async () => {
    mockOwner(null);
    const res = await POST({
      request: makeReq({ ...validBody, referral_code: 'NOPE-1234' }),
    } as any);
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: 'Referral code not found.' });
  });

  it('returns 400 for a malformed code without hitting the DB', async () => {
    const res = await POST({
      request: makeReq({ ...validBody, referral_code: 'ab' }),
    } as any);
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: 'Invalid referral code format.' });
  });

  it('rejects a customer using their own code, case-insensitively', async () => {
    mockOwner({
      id: 'cccc0000-0000-0000-0000-000000000003',
      full_name: 'alice nguyen',
      referral_code: 'ALICE-9XYZ',
      referral_discount_pct: 10,
    });
    const res = await POST({
      request: makeReq({ ...validBody, referral_code: 'ALICE-9XYZ' }),
    } as any);
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: 'A customer cannot use their own referral code.' });
  });

  it('stores empty referral fields when no code is supplied', async () => {
    const captured = mockOwner({ id: 'cust-1' });
    const res = await POST({ request: makeReq(validBody) } as any);
    expect(res.status).toBe(200);
    expect(captured.payload).toMatchObject({
      referral_code:         '',
      referred_by_id:        null,
      referred_by_name:      '',
      referral_discount_pct: 0,
    });
  });
});

// ── Punch card purchase ───────────────────────────────────────────────────────
describe('POST /api/checkins — punch card purchase via checkin_type', () => {
  it('adds 10 punches to the customer account when buying "10 Punches – Adult"', async () => {
    let updatePayload: any = null;

    mockFromFn.mockImplementation((table: string) => {
      if (table === 'checkins') return makeBuilder({ data: mockCheckin, error: null });

      if (table === 'customers') {
        const builder = makeBuilder({ data: { id: 'cust-1', punches_remaining: 0, pt_punches_remaining: 0, membership_end_date: null }, error: null });
        builder.update = vi.fn().mockImplementation((payload: any) => {
          updatePayload = payload;
          return makeBuilder({ data: null, error: null });
        });
        return builder;
      }
      return makeBuilder({ data: null, error: null });
    });

    const res = await POST({
      request: makeReq({ ...validBody, checkin_type: '10 Punches – Adult' }),
    } as any);
    expect(res.status).toBe(200);
    expect(updatePayload).toMatchObject({ punches_remaining: 10, is_punch_card_holder: true });
  });
});
