import { describe, it, expect, vi, beforeEach } from 'vitest';
import { makeBuilder } from './_utils';

const mockFromFn = vi.hoisted(() => vi.fn());

vi.mock('../lib/db', () => ({
  db: { from: mockFromFn },
}));

import { GET, POST } from '../pages/api/public/leaderboard';
import { nicknameError } from '../lib/nickname';
import { STAFF_NAMES } from '../lib/staff';

const ALICE = { id: 'aaaa0000-0000-0000-0000-000000000001', full_name: 'Alice Nguyen' };
const BOB   = 'bbbb0000-0000-0000-0000-000000000002';

function get(query = '') {
  return GET({ url: new URL(`http://localhost/api/public/leaderboard${query}`) } as any);
}

beforeEach(() => {
  mockFromFn.mockReset();
  mockFromFn.mockImplementation(() => makeBuilder({ data: null, error: null }));
});

// ── Ranking ───────────────────────────────────────────────────────────────────
describe('GET /api/public/leaderboard — ranking', () => {
  it('pages past the 1000-row cap so every send is counted', async () => {
    const page1 = Array.from({ length: 1000 }, () => ({ customer_id: ALICE.id, points: 10, submission_id: 's' }));
    const page2 = Array.from({ length: 5 },    () => ({ customer_id: ALICE.id, points: 10, submission_id: null }));

    mockFromFn.mockImplementation((table: string) => {
      if (table === 'leaderboard_sends') {
        const b = makeBuilder();
        b.range = vi.fn((from: number) => makeBuilder({ data: from === 0 ? page1 : page2, error: null }));
        return b;
      }
      if (table === 'leaderboard_nicknames') {
        return makeBuilder({ data: [{ customer_id: ALICE.id, nickname: 'CrimpQueen' }], error: null });
      }
      return makeBuilder();
    });

    const body = await (await get()).json();

    expect(body.leaderboard).toEqual([
      { rank: 1, nickname: 'CrimpQueen', total: 10050, sends: 1005, signed: 1000 },
    ]);
  });

  it('gives equal points the same rank', async () => {
    const ids = ['c1', 'c2', 'c3', 'c4'];
    const points = [50, 40, 40, 10];
    mockFromFn.mockImplementation((table: string) => {
      if (table === 'leaderboard_sends') {
        return makeBuilder({ data: ids.map((id, i) => ({ customer_id: id, points: points[i], submission_id: 's' })), error: null });
      }
      return makeBuilder({ data: ids.map((id, i) => ({ customer_id: id, nickname: `N${i}` })), error: null });
    });

    const body = await (await get()).json();

    expect(body.leaderboard.map((e: any) => e.rank)).toEqual([1, 2, 2, 4]);
  });

  it('reports a database failure', async () => {
    mockFromFn.mockImplementation(() => makeBuilder({ data: null, error: { message: 'boom' } }));
    const res = await get();
    expect(res.status).toBe(500);
  });
});

// ── Step-1 lookup ─────────────────────────────────────────────────────────────
describe('GET /api/public/leaderboard?lookup=…', () => {
  /** customers → `customer`; nicknames: by customer_id → `own`, by ilike → `holder`. */
  function mockLookup(opts: { customer?: any; own?: string | null; holder?: string | null }) {
    mockFromFn.mockImplementation((table: string) => {
      if (table === 'customers') return makeBuilder({ data: opts.customer ?? null, error: null });
      if (table === 'leaderboard_nicknames') {
        const b = makeBuilder();
        b.maybeSingle = vi.fn().mockResolvedValue({
          data: opts.own ? { nickname: opts.own } : null, error: null,
        });
        b.single = vi.fn().mockResolvedValue({
          data: opts.holder ? { customer_id: opts.holder } : null, error: null,
        });
        return b;
      }
      return makeBuilder();
    });
  }

  it('finds the customer and their current nickname', async () => {
    mockLookup({ customer: ALICE, own: 'CrimpQueen' });
    const body = await (await get('?lookup=alice%20nguyen')).json();
    expect(body).toEqual({ customerFound: true, existingNickname: 'CrimpQueen', nicknameError: null });
    expect(body.leaderboard).toBeUndefined();
  });

  it('does not accept a partial name match', async () => {
    mockLookup({ customer: ALICE });
    const body = await (await get('?lookup=Alice&nickname=Rocky')).json();
    expect(body.customerFound).toBe(false);
  });

  it('flags a nickname held by another climber', async () => {
    mockLookup({ customer: ALICE, holder: BOB });
    const body = await (await get('?lookup=Alice%20Nguyen&nickname=rockslayer')).json();
    expect(body.nicknameError).toMatch(/already taken/);
  });

  it('lets a climber keep their own nickname', async () => {
    mockLookup({ customer: ALICE, holder: ALICE.id });
    const body = await (await get('?lookup=Alice%20Nguyen&nickname=CrimpQueen')).json();
    expect(body.nicknameError).toBeNull();
  });

  it('applies the same nickname rules as submitting', async () => {
    mockLookup({ customer: ALICE });
    const body = await (await get('?lookup=Alice%20Nguyen&nickname=' + encodeURIComponent('_ok') )).json();
    expect(body.nicknameError).toBeNull();
    const bad = await (await get('?lookup=Alice%20Nguyen&nickname=' + encodeURIComponent('!nope'))).json();
    expect(bad.nicknameError).toMatch(/start with a letter or number/);
  });
});

// ── POST ordering ─────────────────────────────────────────────────────────────
describe('POST /api/public/leaderboard — nickname is saved last', () => {
  const PNG_1PX =
    'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

  function submit() {
    return POST({
      request: new Request('http://localhost/api/public/leaderboard', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          customer_name: ALICE.full_name, nickname: 'CrimpQueen', wall: 'W3',
          grades: { V3: 1 }, staff_name: STAFF_NAMES[0], signature_image: PNG_1PX,
        }),
      }),
    } as any);
  }

  /** Every step succeeds except the ones named in `fail`; records the call order. */
  function mockSubmit(fail: { sends?: boolean; nickname?: any }) {
    const calls: string[] = [];
    const reset = {
      id: 'r1', wall: 'W3', closes_at: '2020-01-01T00:00:00.000Z', opens_at: '2020-01-01T00:00:00.000Z',
      v0: 0, v1: 0, v2: 0, v3: 2, v4: 0, v5: 0, v6: 0, v7: 0, v8: 0,
    };
    mockFromFn.mockImplementation((table: string) => {
      const b = makeBuilder({
        data: table === 'customers' ? ALICE : table === 'wall_resets' ? reset : table === 'leaderboard_sends' ? [] : null,
        error: null,
      });
      b.insert = vi.fn(() => {
        calls.push(`insert:${table}`);
        const err = table === 'leaderboard_sends' && fail.sends ? { message: 'sends failed' } : null;
        return makeBuilder({ data: null, error: err });
      });
      b.upsert = vi.fn(() => {
        calls.push(`upsert:${table}`);
        return makeBuilder({ data: null, error: fail.nickname ?? null });
      });
      b.delete = vi.fn(() => { calls.push(`delete:${table}`); return makeBuilder(); });
      return b;
    });
    return calls;
  }

  it('saves the nickname only after the sends are in', async () => {
    const calls = mockSubmit({});
    const res = await submit();
    expect(res.status).toBe(200);
    expect(calls.indexOf('upsert:leaderboard_nicknames'))
      .toBeGreaterThan(calls.indexOf('insert:leaderboard_sends'));
  });

  it('leaves the nickname alone when the sends fail', async () => {
    const calls = mockSubmit({ sends: true });
    const res = await submit();
    expect(res.status).toBe(500);
    expect(calls).not.toContain('upsert:leaderboard_nicknames');
  });

  it('undoes the submission when the nickname was claimed in between', async () => {
    const calls = mockSubmit({ nickname: { code: '23505', message: 'duplicate key' } });
    const res = await submit();
    expect(res.status).toBe(409);
    expect((await res.json()).error).toMatch(/already taken/);
    expect(calls).toContain('delete:leaderboard_submissions');
  });
});

describe('nicknameError', () => {
  it.each([
    ['RockSlayer', null],
    ['  padded  ', null],
    ['', /required/],
    ['x'.repeat(31), /30 characters/],
    ['Đức', /printable/],
    ['-dash', /start with a letter or number/],
  ])('%p', (nick, expected) => {
    const err = nicknameError(nick);
    if (expected === null) expect(err).toBeNull();
    else expect(err).toMatch(expected);
  });
});
