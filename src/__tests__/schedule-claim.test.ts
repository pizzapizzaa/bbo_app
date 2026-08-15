import { describe, it, expect, vi, beforeEach } from 'vitest';
import { makeBuilder } from './_utils';

// ── Mock src/lib/db before importing the handlers ─────────────────────────────
const mockFromFn = vi.hoisted(() => vi.fn());

vi.mock('../lib/db', () => ({
  db: { from: mockFromFn },
}));

import { signToken } from '../lib/auth';
import { POST, DELETE } from '../pages/api/schedule/[id]/claim';

const SHIFT_ID = 'bbbb0000-0000-0000-0000-000000000001';

const partTimerToken = () => signToken('parttime', 'staff');
const adminToken     = () => signToken('boss',     'admin');

function makeReq(token: string | null, body?: unknown): Request {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (token) headers.Authorization = `Bearer ${token}`;
  return new Request(`http://localhost/api/schedule/${SHIFT_ID}/claim`, {
    method: 'POST',
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

/** An open part-time slot as the update would return it once claimed. */
const claimedRow = {
  id: SHIFT_ID,
  staff_name: 'Kim An',
  date: '2099-06-15',
  start_time: '09:00',
  end_time: '14:00',
  shift_type: 'part_time',
  claimed_by: 'Kim An',
  claimed_by_account: 'parttime',
};

/** Make `db.from('schedule_entries')` resolve to `result` for every chain. */
function stubDb(result: { data: any; error: any }) {
  mockFromFn.mockImplementation(() => makeBuilder(result));
}

beforeEach(() => {
  mockFromFn.mockReset();
  stubDb({ data: [], error: null });
});

// ── Claiming ──────────────────────────────────────────────────────────────────
describe('POST /api/schedule/:id/claim', () => {
  it('rejects an unauthenticated request', async () => {
    const res = await POST({ params: { id: SHIFT_ID }, request: makeReq(null, { part_timer_name: 'Kim An' }) } as any);
    expect(res.status).toBe(401);
  });

  it('rejects a malformed id before touching the DB', async () => {
    const res = await POST({ params: { id: 'not-a-uuid' }, request: makeReq(partTimerToken(), { part_timer_name: 'Kim An' }) } as any);
    expect(res.status).toBe(400);
    // The auth check itself reads `revoked_tokens`; what must not happen is a
    // schedule write on an id we already know is junk.
    expect(mockFromFn).not.toHaveBeenCalledWith('schedule_entries');
  });

  it('requires a name to be picked', async () => {
    const res = await POST({ params: { id: SHIFT_ID }, request: makeReq(partTimerToken(), {}) } as any);
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: 'Please select your name' });
  });

  it('rejects a name that is not on the part-timer roster', async () => {
    const res = await POST({ params: { id: SHIFT_ID }, request: makeReq(partTimerToken(), { part_timer_name: 'Mallory' }) } as any);
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: 'Not a known part-timer' });
    expect(mockFromFn).not.toHaveBeenCalledWith('schedule_entries');
  });

  it('claims an open slot and stamps the name and account on it', async () => {
    const builder = makeBuilder({ data: [claimedRow], error: null });
    mockFromFn.mockImplementation(() => builder);

    const res = await POST({ params: { id: SHIFT_ID }, request: makeReq(partTimerToken(), { part_timer_name: 'Kim An' }) } as any);

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ entry: claimedRow });
    expect(builder.update).toHaveBeenCalledWith(
      expect.objectContaining({ staff_name: 'Kim An', claimed_by: 'Kim An', claimed_by_account: 'parttime' }),
    );
    // The update is conditional on the slot still being open — that is what makes
    // two simultaneous claims safe.
    expect(builder.eq).toHaveBeenCalledWith('staff_name', '');
    expect(builder.eq).toHaveBeenCalledWith('shift_type', 'part_time');
  });

  it('returns 409 when the slot was taken a moment earlier (0 rows updated)', async () => {
    stubDb({ data: [], error: null });
    const res = await POST({ params: { id: SHIFT_ID }, request: makeReq(partTimerToken(), { part_timer_name: 'Kim An' }) } as any);
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ error: expect.stringMatching(/no longer open/i) });
  });

  it('surfaces a DB failure as a 500', async () => {
    stubDb({ data: null, error: { message: 'connection timeout' } });
    const res = await POST({ params: { id: SHIFT_ID }, request: makeReq(partTimerToken(), { part_timer_name: 'Kim An' }) } as any);
    expect(res.status).toBe(500);
  });
});

// ── Releasing ─────────────────────────────────────────────────────────────────
describe('DELETE /api/schedule/:id/claim', () => {
  /** Make the initial read return `row`, and the follow-up update succeed. */
  function stubRead(row: any) {
    mockFromFn.mockImplementation(() => {
      const b = makeBuilder({ data: row, error: null });
      b.maybeSingle = vi.fn().mockResolvedValue({ data: row, error: null });
      b.single      = vi.fn().mockResolvedValue({ data: { ...row, staff_name: '' }, error: null });
      return b;
    });
  }

  const futureClaim = {
    id: SHIFT_ID, date: '2099-06-15', shift_type: 'part_time',
    staff_name: 'Kim An', claimed_by_account: 'parttime',
  };

  it('rejects an unauthenticated request', async () => {
    const res = await DELETE({ params: { id: SHIFT_ID }, request: makeReq(null) } as any);
    expect(res.status).toBe(401);
  });

  it('404s on a shift that does not exist', async () => {
    stubRead(null);
    const res = await DELETE({ params: { id: SHIFT_ID }, request: makeReq(partTimerToken()) } as any);
    expect(res.status).toBe(404);
  });

  it('refuses to release a normal assigned shift', async () => {
    stubRead({ ...futureClaim, shift_type: 'assigned' });
    const res = await DELETE({ params: { id: SHIFT_ID }, request: makeReq(partTimerToken()) } as any);
    expect(res.status).toBe(403);
  });

  it('409s on a slot that is already open', async () => {
    stubRead({ ...futureClaim, staff_name: '' });
    const res = await DELETE({ params: { id: SHIFT_ID }, request: makeReq(partTimerToken()) } as any);
    expect(res.status).toBe(409);
  });

  it('refuses to release a claim made from a different account', async () => {
    stubRead({ ...futureClaim, claimed_by_account: 'someone-else' });
    const res = await DELETE({ params: { id: SHIFT_ID }, request: makeReq(partTimerToken()) } as any);
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ error: expect.stringMatching(/different account/i) });
  });

  it('refuses to release a shift whose date has passed', async () => {
    stubRead({ ...futureClaim, date: '2020-01-01' });
    const res = await DELETE({ params: { id: SHIFT_ID }, request: makeReq(partTimerToken()) } as any);
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ error: expect.stringMatching(/already passed/i) });
  });

  it('lets an admin release a past shift the shared account could not', async () => {
    stubRead({ ...futureClaim, date: '2020-01-01' });
    const res = await DELETE({ params: { id: SHIFT_ID }, request: makeReq(adminToken()) } as any);
    expect(res.status).toBe(200);
  });

  it('releases an upcoming shift back to the open pool', async () => {
    stubRead(futureClaim);
    const res = await DELETE({ params: { id: SHIFT_ID }, request: makeReq(partTimerToken()) } as any);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ entry: { staff_name: '' } });
  });
});
