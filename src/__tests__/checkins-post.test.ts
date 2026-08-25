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

/** Minimal valid body for a cash check-in. The price is the server's to decide,
 *  so nothing here quotes one — see the "server-side pricing" block below. */
const validBody = {
  customer_name:  'Alice Nguyen',
  date:           '2026-06-15',
  time:           '10:30:00',
  payment_method: 'Cash',
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

// ── Referral / promo codes ────────────────────────────────────────────────────
describe('POST /api/checkins — referral & promo codes', () => {
  /**
   * Wires referral_codes to a single code row, customers to its owner, and
   * captures the check-in insert payload.
   */
  function mockCode(code: any, owner: any = null) {
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
      if (table === 'referral_codes') return makeBuilder({ data: code, error: null });
      return makeBuilder({ data: owner, error: null });
    });
    return captured;
  }

  it('records the owner on the check-in when a customer code is valid', async () => {
    const captured = mockCode(
      {
        id: 'dddd0000-0000-0000-0000-000000000004',
        code: 'BAOTRAN-4F2K',
        discount_pct: 15,
        owner_id: 'cccc0000-0000-0000-0000-000000000003',
        label: '',
        is_active: true,
      },
      { id: 'cccc0000-0000-0000-0000-000000000003', full_name: 'Bao Tran' },
    );

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

  it('records a universal promo code with no referrer', async () => {
    const captured = mockCode({
      id: 'dddd0000-0000-0000-0000-000000000005',
      code: 'SUMMER26',
      discount_pct: 20,
      owner_id: null,
      label: 'Summer 2026',
      is_active: true,
    });

    const res = await POST({
      request: makeReq({ ...validBody, referral_code: 'summer26' }),
    } as any);

    expect(res.status).toBe(200);
    expect(captured.payload).toMatchObject({
      referral_code:         'SUMMER26',
      referred_by_id:        null,
      referred_by_name:      '',
      referral_discount_pct: 20,
    });
  });

  it('lets a customer use a promo code that no one owns', async () => {
    const captured = mockCode({
      id: 'dddd0000-0000-0000-0000-000000000006',
      code: 'PROMO-1234',
      discount_pct: 10,
      owner_id: null,
      label: '',
      is_active: true,
    });
    const res = await POST({
      request: makeReq({ ...validBody, referral_code: 'PROMO-1234' }),
    } as any);
    expect(res.status).toBe(200);
    expect(captured.payload).toMatchObject({ referral_code: 'PROMO-1234' });
  });

  it('returns 400 when the code does not exist', async () => {
    mockCode(null);
    const res = await POST({
      request: makeReq({ ...validBody, referral_code: 'NOPE-1234' }),
    } as any);
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: 'Referral or promo code not found.' });
  });

  it('returns 400 when the code has been paused', async () => {
    mockCode({
      id: 'dddd0000-0000-0000-0000-000000000007',
      code: 'OLDPROMO',
      discount_pct: 25,
      owner_id: null,
      label: '',
      is_active: false,
    });
    const res = await POST({
      request: makeReq({ ...validBody, referral_code: 'OLDPROMO' }),
    } as any);
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: 'That code is no longer active.' });
  });

  it('returns 400 for a malformed code without hitting the DB', async () => {
    const res = await POST({
      request: makeReq({ ...validBody, referral_code: 'ab' }),
    } as any);
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: 'Invalid referral code format.' });
  });

  it('rejects a customer using their own code, case-insensitively', async () => {
    mockCode(
      {
        id: 'dddd0000-0000-0000-0000-000000000008',
        code: 'ALICE-9XYZ',
        discount_pct: 10,
        owner_id: 'cccc0000-0000-0000-0000-000000000003',
        label: '',
        is_active: true,
      },
      { id: 'cccc0000-0000-0000-0000-000000000003', full_name: 'alice nguyen' },
    );
    const res = await POST({
      request: makeReq({ ...validBody, referral_code: 'ALICE-9XYZ' }),
    } as any);
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: 'A customer cannot use their own referral code.' });
  });

  it('stores empty referral fields when no code is supplied', async () => {
    const captured = mockCode(null, { id: 'cust-1' });
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

describe('POST /api/checkins — National Day promo (2026-08-30 → 2026-09-03)', () => {
  /** Captures the customers.update payload for a punch-card purchase. */
  function trackPunchUpdate() {
    const seen: { payload: any } = { payload: null };
    mockFromFn.mockImplementation((table: string) => {
      if (table === 'checkins') return makeBuilder({ data: mockCheckin, error: null });
      if (table === 'customers') {
        const builder = makeBuilder({ data: { id: 'cust-1', punches_remaining: 0, pt_punches_remaining: 0, membership_end_date: null }, error: null });
        builder.update = vi.fn().mockImplementation((payload: any) => {
          seen.payload = payload;
          return makeBuilder({ data: null, error: null });
        });
        return builder;
      }
      return makeBuilder({ data: null, error: null });
    });
    return seen;
  }

  it('grants 12 punches for a 10-punch card bought inside the window', async () => {
    const seen = trackPunchUpdate();
    const res = await POST({
      request: makeReq({ ...validBody, date: '2026-08-30', checkin_type: '10 Punches – Adult' }),
    } as any);
    expect(res.status).toBe(200);
    expect(seen.payload).toMatchObject({ punches_remaining: 12, is_punch_card_holder: true });
  });

  it('grants 25 punches for a 20-punch card on the final day of the window', async () => {
    const seen = trackPunchUpdate();
    const res = await POST({
      request: makeReq({ ...validBody, date: '2026-09-03', checkin_type: '20 Punches – Adult' }),
    } as any);
    expect(res.status).toBe(200);
    expect(seen.payload).toMatchObject({ punches_remaining: 25 });
  });

  it('tops up student and kid cards too', async () => {
    for (const type of ['10 Punches – Student', '10 Punches – Kid']) {
      const seen = trackPunchUpdate();
      await POST({ request: makeReq({ ...validBody, date: '2026-09-01', checkin_type: type }) } as any);
      expect(seen.payload, type).toMatchObject({ punches_remaining: 12 });
    }
  });

  it('grants only the face value the day before the promo opens', async () => {
    const seen = trackPunchUpdate();
    const res = await POST({
      request: makeReq({ ...validBody, date: '2026-08-29', checkin_type: '10 Punches – Adult' }),
    } as any);
    expect(res.status).toBe(200);
    expect(seen.payload).toMatchObject({ punches_remaining: 10 });
  });

  it('grants only the face value the day after the promo closes', async () => {
    const seen = trackPunchUpdate();
    await POST({
      request: makeReq({ ...validBody, date: '2026-09-04', checkin_type: '10 Punches – Adult' }),
    } as any);
    expect(seen.payload).toMatchObject({ punches_remaining: 10 });
  });

  it('keys off the submitted date, not today, so backdated entries stay correct', async () => {
    const seen = trackPunchUpdate();
    await POST({ request: makeReq({ ...validBody, date: '2026-09-02', checkin_type: '10 Punches – Adult' }) } as any);
    expect(seen.payload).toMatchObject({ punches_remaining: 12 });
  });

  it('does not conjure punches for a day pass bought during the promo', async () => {
    const seen = trackPunchUpdate();
    const res = await POST({
      request: makeReq({ ...validBody, date: '2026-09-01', checkin_type: 'Day Pass – Adult' }),
    } as any);
    expect(res.status).toBe(200);
    expect(seen.payload).toBeNull();
  });

  it('leaves PT punch cards at 10 — they are outside the offer', async () => {
    const seen = trackPunchUpdate();
    await POST({ request: makeReq({ ...validBody, date: '2026-09-01', checkin_type: '10 PT Punches – Shingo PT' }) } as any);
    expect(seen.payload).toMatchObject({ pt_punches_remaining: 10 });
  });

  it('stacks the bonus onto punches the customer already has', async () => {
    let payload: any = null;
    mockFromFn.mockImplementation((table: string) => {
      if (table === 'checkins') return makeBuilder({ data: mockCheckin, error: null });
      if (table === 'customers') {
        const builder = makeBuilder({ data: { id: 'cust-1', punches_remaining: 3, pt_punches_remaining: 0, membership_end_date: null }, error: null });
        builder.update = vi.fn().mockImplementation((p: any) => { payload = p; return makeBuilder({ data: null, error: null }); });
        return builder;
      }
      return makeBuilder({ data: null, error: null });
    });
    await POST({ request: makeReq({ ...validBody, date: '2026-09-01', checkin_type: '10 Punches – Adult' }) } as any);
    expect(payload).toMatchObject({ punches_remaining: 15 });  // 3 existing + 10 + 2 bonus
  });
});

// ── Server-side pricing ───────────────────────────────────────────────────────
// The browser sends what was bought; the amount banked against the visit is
// derived here. These assert what actually reaches the `checkins` insert, not
// what the mock echoes back.
describe('POST /api/checkins — server-side pricing', () => {
  /** Captures the row handed to `checkins.insert`. */
  function trackInsert(extraTables: (table: string) => any = () => null) {
    const seen: { row: any } = { row: null };
    mockFromFn.mockImplementation((table: string) => {
      if (table === 'checkins') {
        const builder = makeBuilder({ data: mockCheckin, error: null });
        builder.insert = vi.fn().mockImplementation((row: any) => {
          seen.row = row;
          return makeBuilder({ data: mockCheckin, error: null });
        });
        return builder;
      }
      return extraTables(table) ?? makeBuilder({ data: { id: 'cust-1' }, error: null });
    });
    return seen;
  }

  /** As above, with a `referral_codes` row for the lookup in src/lib/referral.ts. */
  function trackInsertWithCode(code: any) {
    return trackInsert((table) =>
      table === 'referral_codes' ? makeBuilder({ data: code, error: null }) : null);
  }

  it('prices a day pass from the price list, not from the body', async () => {
    const seen = trackInsert();
    const res = await POST({ request: makeReq({
      ...validBody, checkin_type: 'Day Pass – Adult', addons: [], discount: '', amount: 1,
    }) } as any);
    expect(res.status).toBe(200);
    expect(seen.row.amount).toBe(160_000);
  });

  it('ignores a zero amount a tampered client sends', async () => {
    const seen = trackInsert();
    await POST({ request: makeReq({
      ...validBody, checkin_type: 'Day Pass – Adult', addons: [], discount: '', amount: 0,
    }) } as any);
    expect(seen.row.amount).toBe(160_000);
  });

  it('adds up add-ons server-side', async () => {
    const seen = trackInsert();
    await POST({ request: makeReq({
      ...validBody, checkin_type: 'Day Pass – Student',
      addons: ['Shoes Rental', 'Pocari'], discount: '',
    }) } as any);
    expect(seen.row.amount).toBe(120_000 + 20_000 + 18_000);
  });

  it('applies a hand-picked discount server-side', async () => {
    const seen = trackInsert();
    await POST({ request: makeReq({
      ...validBody, checkin_type: 'Day Pass – Adult', discount: 'lasthour50',
    }) } as any);
    expect(seen.row.amount).toBe(80_000);
  });

  it('applies a running promotion when no discount is picked', async () => {
    const seen = trackInsert();
    await POST({ request: makeReq({
      ...validBody, date: '2026-09-01', checkin_type: 'Day Pass – Adult',
    }) } as any);
    expect(seen.row.amount).toBe(144_000);
  });

  it('takes the referral percentage from the code row, not from the request', async () => {
    const seen = trackInsertWithCode({
      id: 'code-1', code: 'PROMO10', discount_pct: 10, rental_discount_pct: 0,
      owner_id: null, label: '', is_active: true,
    });
    // A client quoting a bargain price gets the 10% the gym actually set.
    await POST({ request: makeReq({
      ...validBody, checkin_type: 'Day Pass – Adult',
      discount: 'referral', referral_code: 'PROMO10', amount: 16_000,
    }) } as any);
    expect(seen.row.amount).toBe(144_000);
    expect(seen.row.referral_discount_pct).toBe(10);
  });

  it('cuts gear rental by the code rental percentage, retail stock never', async () => {
    const seen = trackInsertWithCode({
      id: 'code-1', code: 'HANIE10', discount_pct: 10, rental_discount_pct: 50,
      owner_id: null, label: '', is_active: true,
    });
    await POST({ request: makeReq({
      ...validBody, checkin_type: 'Day Pass – Adult',
      addons: ['Shoes Rental', 'Socks'], discount: 'referral', referral_code: 'HANIE10',
    }) } as any);
    //     base 144,000 + shoes at half + socks in full
    expect(seen.row.amount).toBe(144_000 + 10_000 + 10_000);
    expect(seen.row.addons).toContain('Rental discount: 50%');
  });

  it('writes the discount and promo trail itself', async () => {
    const seen = trackInsert();
    await POST({ request: makeReq({
      ...validBody, date: '2026-09-01', checkin_type: '10 Punches – Adult',
      addons: ['Socks'], discount: '',
    }) } as any);
    expect(seen.row.addons).toBe('Socks, Promo: National Day Special – +2 bonus punches');
  });

  it('refuses a discount claim smuggled in as an add-on', async () => {
    const res = await POST({ request: makeReq({
      ...validBody, checkin_type: 'Day Pass – Adult',
      addons: ['Socks', 'Discount: 90% discount – because I said so'],
    }) } as any);
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/^Unknown add-on:/);
  });

  it('rejects an unknown check-in type rather than pricing it at zero', async () => {
    const res = await POST({ request: makeReq({
      ...validBody, checkin_type: 'Lifetime Pass', addons: [], discount: '',
    }) } as any);
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: 'Unknown check-in type: Lifetime Pass' });
  });

  it('rejects an unknown discount', async () => {
    const res = await POST({ request: makeReq({
      ...validBody, checkin_type: 'Day Pass – Adult', discount: 'day99',
    }) } as any);
    expect(res.status).toBe(400);
  });

  it('tells an out-of-date page to reload instead of mispricing its payload', async () => {
    const res = await POST({ request: makeReq({
      ...validBody, checkin_type: 'Day Pass – Adult',
      addons: 'Socks, Discount: 30% discount – Day Pass (setting day, less disturbance)',
      amount: 112_000,
    }) } as any);
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/out of date/i);
  });

  it('rejects a code quoted alongside a different discount', async () => {
    const res = await POST({ request: makeReq({
      ...validBody, checkin_type: 'Day Pass – Adult',
      discount: 'day30', referral_code: 'PROMO10',
    }) } as any);
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/only one discount/i);
  });

  it('rejects the referral discount with no code to back it', async () => {
    const res = await POST({ request: makeReq({
      ...validBody, checkin_type: 'Day Pass – Adult', discount: 'referral',
    }) } as any);
    expect(res.status).toBe(400);
  });

  it('honours an explicit override and records what the price list said', async () => {
    const seen = trackInsert();
    await POST({ request: makeReq({
      ...validBody, checkin_type: 'Day Pass – Adult', amount: 100_000, amount_override: true,
    }) } as any);
    expect(seen.row.amount).toBe(100_000);
    expect(seen.row.addons).toContain('Manual amount (price list: 160,000 ₫)');
  });

  it('leaves no override note when the override matches the price list anyway', async () => {
    const seen = trackInsert();
    await POST({ request: makeReq({
      ...validBody, checkin_type: 'Day Pass – Adult', amount: 160_000, amount_override: true,
    }) } as any);
    expect(seen.row.addons).toBe('');
  });

  it('never banks a negative override', async () => {
    const seen = trackInsert();
    await POST({ request: makeReq({
      ...validBody, checkin_type: 'Day Pass – Adult', amount: -500_000, amount_override: true,
    }) } as any);
    expect(seen.row.amount).toBe(0);
  });

  it('ignores an amount sent without the override flag', async () => {
    const seen = trackInsert();
    await POST({ request: makeReq({
      ...validBody, checkin_type: 'Day Pass – Adult', amount: 100_000,
    }) } as any);
    expect(seen.row.amount).toBe(160_000);
    expect(seen.row.addons).toBe('');
  });

  it('reports the charged figure back to the caller', async () => {
    trackInsert();
    const res = await POST({ request: makeReq({
      ...validBody, checkin_type: 'Day Pass – Adult', discount: 'day30',
    }) } as any);
    const json = await res.json();
    expect(json.price.charged).toBe(112_000);
    expect(json.price.overridden).toBe(false);
  });
});
