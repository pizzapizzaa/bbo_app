import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { makeBuilder } from './_utils';

const mockFromFn = vi.hoisted(() => vi.fn());

vi.mock('../lib/db', () => ({
  db: { from: mockFromFn },
}));

import {
  parseGymDateTime,
  validateWallReset,
  getWallAvailability,
  formatGymTime,
} from '../lib/wall-config';
import { POST } from '../pages/api/walls/resets/index';
import { PATCH, DELETE } from '../pages/api/walls/resets/[id]';
import { signToken } from '../lib/auth';

const ADMIN_AUTH = { Authorization: `Bearer ${signToken('test-admin', 'admin')}` };
const STAFF_AUTH = { Authorization: `Bearer ${signToken('part-timer', 'staff')}` };
const RESET_ID   = 'eeee0000-0000-0000-0000-000000000005';

const VALID_BODY = {
  wall:      'W3',
  closes_at: '2026-10-04T19:00',
  opens_at:  '2026-10-06T10:30',
  counts:    { V0: 1, V1: 1, V2: 2, V3: 2, V4: 2, V5: 1, V6: 1, V7: 1, V8: 0 },
  notes:     'Comp week',
};

function req(method: string, body: unknown, auth = ADMIN_AUTH): Request {
  return new Request('http://localhost/api/walls/resets', {
    method,
    headers: { 'Content-Type': 'application/json', ...auth },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

function resetRow(over: Record<string, unknown> = {}) {
  return {
    id: RESET_ID, wall: 'W3',
    closes_at: '2026-09-28T12:00:00.000Z', opens_at: '2026-09-30T03:30:00.000Z',
    v0: 1, v1: 1, v2: 2, v3: 2, v4: 2, v5: 1, v6: 1, v7: 1, v8: 0,
    notes: '', created_by: null, created_at: '', updated_at: '',
    ...over,
  };
}

beforeEach(() => {
  mockFromFn.mockReset();
  mockFromFn.mockImplementation(() => makeBuilder({ data: null, error: null }));
});

afterEach(() => {
  vi.useRealTimers();
});

// ── Gym-time parsing ──────────────────────────────────────────────────────────
describe('parseGymDateTime', () => {
  it('reads the input as Vietnam time, not the server zone', () => {
    expect(parseGymDateTime('2026-10-04T19:00')).toBe('2026-10-04T12:00:00.000Z');
  });

  it('rolls into the previous UTC day for early-morning gym times', () => {
    expect(parseGymDateTime('2026-10-06T05:00')).toBe('2026-10-05T22:00:00.000Z');
  });

  it.each([
    '', '2026-10-04', '2026-10-04 19:00', '2026-02-30T10:00',
    '2026-10-04T24:00', '2026-10-04T10:60', '2026-10-04T19:00+07:00', 42, null,
  ])('rejects %p', value => {
    expect(parseGymDateTime(value)).toBeNull();
  });
});

describe('formatGymTime', () => {
  it('formats in gym time', () => {
    expect(formatGymTime('2026-10-06T03:30:00.000Z')).toBe('Tue 6 Oct, 10:30');
  });
});

// ── Validation ────────────────────────────────────────────────────────────────
describe('validateWallReset', () => {
  it('accepts the usual Sunday-close, Tuesday-open reset', () => {
    const r = validateWallReset(VALID_BODY);
    expect('value' in r && r.value).toMatchObject({
      wall: 'W3',
      closes_at: '2026-10-04T12:00:00.000Z',
      opens_at:  '2026-10-06T03:30:00.000Z',
      notes: 'Comp week',
    });
  });

  it('normalises the wall code', () => {
    const r = validateWallReset({ ...VALID_BODY, wall: ' w3 ' });
    expect('value' in r && r.value.wall).toBe('W3');
  });

  it('allows a wall that reopens the moment it closes', () => {
    const r = validateWallReset({ ...VALID_BODY, opens_at: VALID_BODY.closes_at });
    expect('value' in r).toBe(true);
  });

  it.each([
    [{ wall: 'W7' },                                 /Wall must be/],
    [{ closes_at: 'soon' },                          /Close time/],
    [{ opens_at: '2026-10-04T18:59' },               /reopen after it closes/],
    [{ counts: { V3: -1 } },                         /V3 must be/],
    [{ counts: { V3: 1.5 } },                        /V3 must be/],
    [{ counts: { V3: 51 } },                         /V3 must be/],
    [{ counts: {} },                                 /how many routes/],
    [{ notes: 'x'.repeat(1001) },                    /too long/],
  ])('rejects %o', (patch, msg) => {
    const r = validateWallReset({ ...VALID_BODY, ...patch });
    expect('error' in r && r.error).toMatch(msg);
  });
});

// ── Availability ──────────────────────────────────────────────────────────────
describe('getWallAvailability', () => {
  function mockAvailability(reset: any, sends: Array<{ grade: string }>) {
    const sendsBuilder = makeBuilder({ data: sends, error: null });
    mockFromFn.mockImplementation((table: string) => {
      if (table === 'wall_resets') return makeBuilder({ data: reset, error: null });
      if (table === 'leaderboard_sends') return sendsBuilder;
      return makeBuilder();
    });
    return sendsBuilder;
  }

  it('counts only sends since the wall closed for the current set', async () => {
    vi.useFakeTimers({ now: new Date('2026-10-03T05:00:00Z') });
    const sends = mockAvailability(resetRow(), [{ grade: 'V3' }, { grade: 'V3' }, { grade: 'V5' }]);

    const a = await getWallAvailability('cust-1', 'W3');

    expect(sends.gte).toHaveBeenCalledWith('logged_at', '2026-09-28T12:00:00.000Z');
    expect(a?.resetting).toBe(false);
    expect(a?.grades.V3).toEqual({ max: 2, sent: 2, remaining: 0 });
    expect(a?.grades.V5).toEqual({ max: 1, sent: 1, remaining: 0 });
    expect(a?.grades.V2).toEqual({ max: 2, sent: 0, remaining: 2 });
    expect(a?.grades.V8).toEqual({ max: 0, sent: 0, remaining: 0 });
  });

  it('reports the wall as being reset until it reopens', async () => {
    vi.useFakeTimers({ now: new Date('2026-09-29T05:00:00Z') });
    mockAvailability(resetRow(), []);

    const a = await getWallAvailability('cust-1', 'W3');

    expect(a?.resetting).toBe(true);
    expect(a?.opensLabel).toBe('Wed 30 Sep, 10:30');
  });

  it('returns null when the wall has no reset on record', async () => {
    mockAvailability(null, []);
    expect(await getWallAvailability('cust-1', 'W3')).toBeNull();
  });
});

// ── POST /api/walls/resets ────────────────────────────────────────────────────
describe('POST /api/walls/resets', () => {
  it('stores the reset in UTC with one column per grade and who entered it', async () => {
    let inserted: any = null;
    mockFromFn.mockImplementation(() => {
      const b = makeBuilder();
      b.insert = vi.fn().mockImplementation((payload: any) => {
        inserted = payload;
        return makeBuilder({ data: { id: RESET_ID, ...payload }, error: null });
      });
      return b;
    });

    const res = await POST({ request: req('POST', VALID_BODY) } as any);

    expect(res.status).toBe(201);
    expect(inserted).toMatchObject({
      wall: 'W3',
      closes_at: '2026-10-04T12:00:00.000Z',
      opens_at:  '2026-10-06T03:30:00.000Z',
      v0: 1, v2: 2, v8: 0,
      notes: 'Comp week',
      created_by: 'test-admin',
    });
  });

  it('refuses part-timers', async () => {
    const res = await POST({ request: req('POST', VALID_BODY, STAFF_AUTH) } as any);
    expect(res.status).toBe(403);
    expect(mockFromFn).not.toHaveBeenCalled();
  });

  it('rejects invalid input before touching the database', async () => {
    const res = await POST({ request: req('POST', { ...VALID_BODY, wall: 'W9' }) } as any);
    expect(res.status).toBe(400);
    expect(mockFromFn).not.toHaveBeenCalled();
  });

  it('explains a duplicate close time', async () => {
    mockFromFn.mockImplementation(() => {
      const b = makeBuilder();
      b.insert = vi.fn().mockReturnValue(makeBuilder({ data: null, error: { code: '23505', message: 'dup' } }));
      return b;
    });
    const res = await POST({ request: req('POST', VALID_BODY) } as any);
    expect(res.status).toBe(409);
    expect((await res.json()).error).toMatch(/already has a reset/);
  });
});

// ── PATCH / DELETE /api/walls/resets/:id ──────────────────────────────────────
describe('PATCH /api/walls/resets/:id', () => {
  it('404s when the reset does not exist', async () => {
    const res = await PATCH({ params: { id: RESET_ID }, request: req('PATCH', VALID_BODY) } as any);
    expect(res.status).toBe(404);
  });

  it('rejects a malformed id', async () => {
    const res = await PATCH({ params: { id: 'nope' }, request: req('PATCH', VALID_BODY) } as any);
    expect(res.status).toBe(400);
  });

  it('refuses part-timers', async () => {
    const res = await PATCH({ params: { id: RESET_ID }, request: req('PATCH', VALID_BODY, STAFF_AUTH) } as any);
    expect(res.status).toBe(403);
  });
});

describe('DELETE /api/walls/resets/:id', () => {
  it('deletes for admins', async () => {
    const b = makeBuilder();
    mockFromFn.mockReturnValue(b);
    const res = await DELETE({ params: { id: RESET_ID }, request: req('DELETE', undefined) } as any);
    expect(res.status).toBe(200);
    expect(b.delete).toHaveBeenCalled();
    expect(b.eq).toHaveBeenCalledWith('id', RESET_ID);
  });

  it('refuses part-timers', async () => {
    const res = await DELETE({ params: { id: RESET_ID }, request: req('DELETE', undefined, STAFF_AUTH) } as any);
    expect(res.status).toBe(403);
  });
});
