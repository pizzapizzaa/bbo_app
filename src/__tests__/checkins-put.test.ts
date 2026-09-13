import { describe, it, expect, vi, beforeEach } from 'vitest';
import { makeBuilder } from './_utils';

// ── Mock src/lib/db before importing the handler ──────────────────────────────
const mockFromFn = vi.hoisted(() => vi.fn());

vi.mock('../lib/db', () => ({
  db: { from: mockFromFn },
}));

import { PUT, DELETE } from '../pages/api/checkins/[id]';
import { signToken } from '../lib/auth';
import { gymToday } from '../lib/validate';

const ID = 'aaaa0000-0000-0000-0000-000000000001';

const adminToken = () => signToken('boss',      'admin');
const staffToken = () => signToken('parttimer', 'staff');

function makeReq(body: unknown, token: string, method = 'PUT'): Request {
  return new Request(`http://localhost/api/checkins/${ID}`, {
    method,
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: method === 'DELETE' ? undefined : JSON.stringify(body),
  });
}

const call = (handler: any, request: Request, id: string = ID) =>
  handler({ request, params: { id }, url: new URL(request.url) } as any);

/** A plain day-pass edit: nothing here quotes a price, the server decides it. */
const validBody = {
  customer_name:  'Alice Nguyen',
  date:           gymToday(),
  time:           '10:30',
  payment_method: 'Cash',
  checkin_type:   'Day Pass – Adult',
  addons:         [] as string[],
  discount:       '',
};

/**
 * Wire up the tables this route touches. `existing` is the row as it stands;
 * `updated` is what the UPDATE returns. Every other table answers empty.
 */
function mockTables(opts: {
  existing?: Record<string, unknown> | null;
  existingError?: { code?: string; message?: string } | null;
  customers?: Record<string, unknown> | null;
  updateError?: { message: string } | null;
} = {}) {
  const {
    existing = { customer_name: 'Alice Nguyen', date: gymToday(), checkin_type: 'Day Pass – Adult',
                 punch_card_holder_id: null, pt_punch_holder_id: null },
    existingError = null,
    customers = null,
    updateError = null,
  } = opts;

  const checkins  = makeBuilder({ data: existing, error: existingError });
  const updated   = makeBuilder({ data: { id: ID, ...existing }, error: updateError });
  const customersB = makeBuilder({ data: customers, error: null });

  // The route reads the row, then updates it — the same table, two shapes.
  let sawSelect = false;
  const checkinsB: any = new Proxy(checkins, {
    get(target, prop) {
      if (prop === 'select' && sawSelect) return updated.select;
      if (prop === 'update') { sawSelect = true; return updated.update; }
      return (target as any)[prop];
    },
  });

  mockFromFn.mockImplementation((table: string) =>
    table === 'checkins' ? checkinsB : customersB
  );
  return { checkins, updated, customersB };
}

beforeEach(() => {
  mockFromFn.mockReset();
  mockFromFn.mockImplementation(() => makeBuilder({ data: null, error: null }));
});

// ── Who may edit ──────────────────────────────────────────────────────────────
describe('PUT /api/checkins/:id — access', () => {
  it('rejects an unsigned request with 401', async () => {
    const req = new Request(`http://localhost/api/checkins/${ID}`, {
      method: 'PUT', body: JSON.stringify(validBody),
    });
    expect((await call(PUT, req)).status).toBe(401);
  });

  it('returns 400 for a malformed id', async () => {
    const res = await call(PUT, makeReq(validBody, adminToken()), 'not-a-uuid');
    expect(res.status).toBe(400);
  });

  it("lets a part-timer edit today's check-in logged by someone else", async () => {
    mockTables({ existing: { customer_name: 'Alice Nguyen', date: gymToday(),
                             checkin_type: 'Day Pass – Adult', created_by: 'someone-else',
                             punch_card_holder_id: null, pt_punch_holder_id: null } });
    const res = await call(PUT, makeReq(validBody, staffToken()));
    expect(res.status).toBe(200);
  });

  it("refuses a part-timer an older check-in they did not log", async () => {
    mockFromFn.mockImplementation(() =>
      makeBuilder({ data: { created_by: 'someone-else', date: '2026-01-01' }, error: null })
    );
    const res = await call(PUT, makeReq({ ...validBody, date: '2026-01-01' }, staffToken()));
    expect(res.status).toBe(403);
    expect((await res.json()).error).toMatch(/today's check-ins, or ones you logged/);
  });

  it('lets an admin edit any check-in', async () => {
    mockTables({ existing: { customer_name: 'Alice Nguyen', date: '2026-01-01',
                             checkin_type: 'Day Pass – Adult', created_by: 'someone-else',
                             punch_card_holder_id: null, pt_punch_holder_id: null } });
    const res = await call(PUT, makeReq({ ...validBody, date: '2026-01-01' }, adminToken()));
    expect(res.status).toBe(200);
  });

  it('returns 404 when the row is gone', async () => {
    mockFromFn.mockImplementation(() => makeBuilder({ data: null, error: null }));
    const res = await call(PUT, makeReq(validBody, adminToken()));
    expect(res.status).toBe(404);
  });

  it("reads PostgREST's no-rows error as a 404, not a fault", async () => {
    mockFromFn.mockImplementation(() => makeBuilder({
      data: null,
      error: { code: 'PGRST116', message: 'JSON object requested, multiple (or no) rows returned' },
    }));
    const res = await call(PUT, makeReq(validBody, adminToken()));
    expect(res.status).toBe(404);
    expect((await res.json()).error).toMatch(/no longer exists/);
  });

  it('still reports a real database fault as a 500', async () => {
    mockFromFn.mockImplementation(() =>
      makeBuilder({ data: null, error: { code: '08006', message: 'connection failure' } })
    );
    const res = await call(PUT, makeReq(validBody, adminToken()));
    expect(res.status).toBe(500);
  });
});

// ── Input validation ──────────────────────────────────────────────────────────
describe('PUT /api/checkins/:id — input validation', () => {
  const bad = async (body: unknown) => {
    mockTables();
    const res = await call(PUT, makeReq(body, adminToken()));
    return { status: res.status, error: (await res.json()).error };
  };

  it('rejects malformed JSON', async () => {
    mockTables();
    const req = new Request(`http://localhost/api/checkins/${ID}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${adminToken()}` },
      body: '{ not json',
    });
    const res = await call(PUT, req);
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe('Invalid JSON');
  });

  it('rejects a missing payment method', async () => {
    expect((await bad({ ...validBody, payment_method: '' })).status).toBe(400);
  });

  it('rejects an impossible date', async () => {
    expect((await bad({ ...validBody, date: '2026-02-30' })).error).toMatch(/Invalid date/);
  });

  it('rejects a bad time', async () => {
    expect((await bad({ ...validBody, time: '25h' })).error).toMatch(/Invalid time/);
  });

  it('rejects an unknown add-on', async () => {
    expect((await bad({ ...validBody, addons: ['Caviar'] })).error).toMatch(/Unknown add-on: Caviar/);
  });

  it('rejects an unknown check-in type', async () => {
    expect((await bad({ ...validBody, checkin_type: 'Free Pass' })).error).toMatch(/Unknown check-in type/);
  });

  it('rejects an unknown discount', async () => {
    expect((await bad({ ...validBody, discount: 'mates-rates' })).error).toMatch(/Unknown discount/);
  });

  it('refuses a joined add-on string from a stale page', async () => {
    expect((await bad({ ...validBody, addons: 'Shoes Rental, Socks' })).error).toMatch(/page is out of date/);
  });

  it('refuses a referral code alongside another discount', async () => {
    expect((await bad({ ...validBody, discount: 'day30', referral_code: 'FRIEND10' })).error)
      .toMatch(/cannot be combined/);
  });

  it('refuses the referral discount with no code', async () => {
    expect((await bad({ ...validBody, discount: 'referral' })).error)
      .toMatch(/Enter a referral or promo code/);
  });
});

// ── Sales that credited an account ────────────────────────────────────────────
describe('PUT /api/checkins/:id — balance-granting sales', () => {
  const punchSale = {
    customer_name: 'Alice Nguyen', date: gymToday(), checkin_type: '10 Punches – Adult',
    punch_card_holder_id: null, pt_punch_holder_id: null,
  };

  it('refuses to change the product on a punch-card sale', async () => {
    mockTables({ existing: punchSale });
    const res = await call(PUT, makeReq({ ...validBody, checkin_type: 'Day Pass – Adult' }, adminToken()));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/punches or a membership/);
  });

  it('refuses to move a punch-card sale to another customer', async () => {
    mockTables({ existing: punchSale });
    const res = await call(PUT, makeReq(
      { ...validBody, checkin_type: '10 Punches – Adult', customer_name: 'Bao Tran' }, adminToken()));
    expect(res.status).toBe(400);
  });

  it('refuses to redate a punch-card sale', async () => {
    mockTables({ existing: punchSale });
    const res = await call(PUT, makeReq(
      { ...validBody, checkin_type: '10 Punches – Adult', date: '2026-08-31' }, adminToken()));
    expect(res.status).toBe(400);
  });

  it('refuses to turn a day pass into a membership sale', async () => {
    mockTables();
    const res = await call(PUT, makeReq(
      { ...validBody, checkin_type: 'Membership – 3 Months' }, adminToken()));
    expect(res.status).toBe(400);
  });

  it('still allows the payment method and notes on a punch-card sale', async () => {
    mockTables({ existing: punchSale });
    const res = await call(PUT, makeReq({
      ...validBody, checkin_type: '10 Punches – Adult',
      payment_method: 'Local Card', notes: 'paid by card after all',
    }, adminToken()));
    expect(res.status).toBe(200);
  });
});

// ── Re-pricing ────────────────────────────────────────────────────────────────
describe('PUT /api/checkins/:id — re-prices from the price list', () => {
  it('bills the list price, ignoring an amount the caller invents', async () => {
    const { updated } = mockTables();
    await call(PUT, makeReq({ ...validBody, amount: 1 }, adminToken()));

    expect(updated.update).toHaveBeenCalledWith(
      expect.objectContaining({ amount: 160_000 })  // Day Pass – Adult
    );
  });

  it('adds the add-ons to the bill and records them in the trail', async () => {
    const { updated } = mockTables();
    await call(PUT, makeReq({ ...validBody, addons: ['Shoes Rental', 'Socks'] }, adminToken()));

    const row = updated.update.mock.calls[0][0];
    expect(row.amount).toBe(160_000 + 20_000 + 10_000);
    expect(row.addons).toContain('Shoes Rental');
    expect(row.addons).toContain('Socks');
  });

  it('honours an explicit amount override and says so in the trail', async () => {
    const { updated } = mockTables();
    await call(PUT, makeReq(
      { ...validBody, amount: 50_000, amount_override: true }, adminToken()));

    const row = updated.update.mock.calls[0][0];
    expect(row.amount).toBe(50_000);
    expect(row.addons).toMatch(/Manual amount/);
  });

  it('leaves created_by alone, so the row keeps naming who logged it', async () => {
    const { updated } = mockTables();
    await call(PUT, makeReq(validBody, adminToken()));
    expect(updated.update.mock.calls[0][0]).not.toHaveProperty('created_by');
  });

  it('clears the referral columns when no code is quoted', async () => {
    const { updated } = mockTables();
    await call(PUT, makeReq(validBody, adminToken()));

    expect(updated.update).toHaveBeenCalledWith(expect.objectContaining({
      referral_code: '', referred_by_id: null, referred_by_name: '', referral_discount_pct: 0,
    }));
  });
});

// ── Punch reconciliation ──────────────────────────────────────────────────────
describe('PUT /api/checkins/:id — punch reconciliation', () => {
  const HOLDER_A = 'bbbb0000-0000-0000-0000-00000000000a';
  const HOLDER_B = 'bbbb0000-0000-0000-0000-00000000000b';

  /** Records every customers-table update so punch movements can be asserted. */
  function trackCustomers(existing: Record<string, unknown>) {
    const updates: Record<string, unknown>[] = [];
    const updated = makeBuilder({ data: { id: ID }, error: null });
    let sawSelect = false;
    const checkinsB: any = new Proxy(makeBuilder({ data: existing, error: null }), {
      get(target, prop) {
        if (prop === 'update') { sawSelect = true; return updated.update; }
        if (prop === 'select' && sawSelect) return updated.select;
        return (target as any)[prop];
      },
    });

    mockFromFn.mockImplementation((table: string) => {
      if (table === 'checkins') return checkinsB;
      const b = makeBuilder({ data: { punches_remaining: 5, pt_punches_remaining: 5 }, error: null });
      b.update = vi.fn((payload: Record<string, unknown>) => { updates.push(payload); return b; });
      return b;
    });
    return updates;
  }

  it('charges the new holder and refunds the old when it changes', async () => {
    const updates = trackCustomers({
      customer_name: 'Alice Nguyen', date: gymToday(), checkin_type: 'Day Pass – Adult',
      punch_card_holder_id: HOLDER_A, pt_punch_holder_id: null,
    });

    await call(PUT, makeReq({
      ...validBody, payment_method: 'Punch Card', punch_card_holder_id: HOLDER_B,
    }, adminToken()));

    // A refunded to 6, B charged down to 4.
    expect(updates).toEqual(expect.arrayContaining([
      { punches_remaining: 6 },
      { punches_remaining: 4 },
    ]));
  });

  it('does not charge a second punch when the holder is unchanged', async () => {
    const updates = trackCustomers({
      customer_name: 'Alice Nguyen', date: gymToday(), checkin_type: 'Day Pass – Adult',
      punch_card_holder_id: HOLDER_A, pt_punch_holder_id: null,
    });

    await call(PUT, makeReq({
      ...validBody, payment_method: 'Punch Card', punch_card_holder_id: HOLDER_A,
      notes: 'fixed a typo',
    }, adminToken()));

    expect(updates).toEqual([]);
  });

  it('refunds the punch when the visit stops being paid by card', async () => {
    const updates = trackCustomers({
      customer_name: 'Alice Nguyen', date: gymToday(), checkin_type: 'Day Pass – Adult',
      punch_card_holder_id: HOLDER_A, pt_punch_holder_id: null,
    });

    await call(PUT, makeReq({ ...validBody, payment_method: 'Cash' }, adminToken()));

    expect(updates).toEqual([{ punches_remaining: 6 }]);
  });

  it('reconciles PT punches on their own column', async () => {
    const updates = trackCustomers({
      customer_name: 'Alice Nguyen', date: gymToday(), checkin_type: 'Day Pass – Adult',
      punch_card_holder_id: null, pt_punch_holder_id: HOLDER_A,
    });

    await call(PUT, makeReq({
      ...validBody, payment_method: 'PT Punch', pt_punch_holder_id: HOLDER_B,
    }, adminToken()));

    expect(updates).toEqual(expect.arrayContaining([
      { pt_punches_remaining: 6 },
      { pt_punches_remaining: 4 },
    ]));
  });
});

// ── DELETE keeps working under the widened rule ───────────────────────────────
describe('DELETE /api/checkins/:id', () => {
  it("lets a part-timer delete today's check-in logged by someone else", async () => {
    mockFromFn.mockImplementation(() =>
      makeBuilder({ data: { created_by: 'someone-else', date: gymToday(),
                            punch_card_holder_id: null, pt_punch_holder_id: null }, error: null })
    );
    const res = await call(DELETE, makeReq(null, staffToken(), 'DELETE'));
    expect(res.status).toBe(200);
  });

  it("refuses a part-timer an older check-in they did not log", async () => {
    mockFromFn.mockImplementation(() =>
      makeBuilder({ data: { created_by: 'someone-else', date: '2026-01-01' }, error: null })
    );
    const res = await call(DELETE, makeReq(null, staffToken(), 'DELETE'));
    expect(res.status).toBe(403);
  });
});
