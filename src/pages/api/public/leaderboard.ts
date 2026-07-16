export const prerender = false;

import type { APIRoute } from 'astro';
import { db } from '../../../lib/db';
import { escapeLike, MAX_NAME } from '../../../lib/validate';

const VALID_WALLS  = ['W1', 'W2', 'W3', 'W4', 'W5', 'W6'] as const;
const VALID_GRADES = ['V0', 'V1', 'V2', 'V3', 'V4', 'V5', 'V6', 'V7', 'V8'] as const;
const GRADE_POINTS: Record<string, number> = {
  V0: 10, V1: 15, V2: 20, V3: 25, V4: 40,
  V5: 15, V6: 15, V7: 15, V8: 15,
};
const MAX_NICKNAME         = 30;
const MAX_SENDS_PER_SUBMIT = 50;

const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });

// ── GET /api/public/leaderboard ─────────────────────────────────────────────
// Returns ranked leaderboard.
// Optional ?lookup=<customer_name> appends that customer's existing nickname.
export const GET: APIRoute = async ({ url }) => {
  const lookupName = (url.searchParams.get('lookup') ?? '').trim();

  // Fetch all sends and all nicknames in parallel
  const [sendsResult, nicknamesResult] = await Promise.all([
    db.from('leaderboard_sends').select('customer_id, points'),
    db.from('leaderboard_nicknames').select('customer_id, nickname'),
  ]);

  if (sendsResult.error || nicknamesResult.error) {
    const msg = sendsResult.error?.message ?? nicknamesResult.error?.message;
    return json({ error: msg }, 500);
  }

  // Build nickname lookup map
  const nicknameMap: Record<string, string> = {};
  for (const n of nicknamesResult.data ?? []) {
    nicknameMap[n.customer_id] = n.nickname;
  }

  // Aggregate points by customer_id
  const totals: Record<string, { nickname: string; total: number; sends: number }> = {};
  for (const row of sendsResult.data ?? []) {
    const nick = nicknameMap[row.customer_id];
    if (!nick) continue; // no nickname registered — skip
    if (!totals[row.customer_id]) {
      totals[row.customer_id] = { nickname: nick, total: 0, sends: 0 };
    }
    totals[row.customer_id].total += row.points;
    totals[row.customer_id].sends += 1;
  }

  const leaderboard = Object.values(totals)
    .sort((a, b) => b.total - a.total || a.nickname.localeCompare(b.nickname))
    .slice(0, 100)
    .map((entry, i) => ({ rank: i + 1, ...entry }));

  // Optional: resolve the requesting customer's existing nickname
  let existingNickname: string | null = null;
  if (lookupName.length >= 2 && lookupName.length <= MAX_NAME) {
    const safe = lookupName.replace(/[^\x20-\x7E]/g, '');
    if (safe) {
      const { data: cust } = await db
        .from('customers')
        .select('id')
        .ilike('full_name', escapeLike(safe))
        .limit(1)
        .single();
      if (cust) {
        existingNickname = nicknameMap[cust.id] ?? null;
      }
    }
  }

  return json({ leaderboard, existingNickname });
};

// ── POST /api/public/leaderboard ────────────────────────────────────────────
// Body: { customer_name, nickname, wall, grades: { V0: 2, V3: 1, … } }
export const POST: APIRoute = async ({ request }) => {
  let body: {
    customer_name?: unknown;
    nickname?: unknown;
    wall?: unknown;
    grades?: unknown;
  };
  try { body = await request.json(); }
  catch { return json({ error: 'Invalid JSON' }, 400); }

  const customerName = String(body.customer_name ?? '').trim();
  const nickname     = String(body.nickname     ?? '').trim();
  const wall         = String(body.wall         ?? '').trim().toUpperCase();
  const gradesRaw    = body.grades;

  // ── Input validation ──────────────────────────────────────────────────────
  if (!customerName) return json({ error: 'Customer name is required.' }, 400);
  if (customerName.length > MAX_NAME) return json({ error: 'Name too long.' }, 400);
  if (!nickname)     return json({ error: 'A public nickname is required.' }, 400);
  if (nickname.length > MAX_NICKNAME)
    return json({ error: `Nickname must be ${MAX_NICKNAME} characters or fewer.` }, 400);
  if (!/^[\x20-\x7E]+$/.test(nickname))
    return json({ error: 'Nickname must contain printable characters only.' }, 400);
  if (!/^\w/.test(nickname) || /^\s*$/.test(nickname))
    return json({ error: 'Nickname must start with a letter or number.' }, 400);
  if (!VALID_WALLS.includes(wall as typeof VALID_WALLS[number]))
    return json({ error: `Wall must be one of: ${VALID_WALLS.join(', ')}.` }, 400);
  if (typeof gradesRaw !== 'object' || gradesRaw === null || Array.isArray(gradesRaw))
    return json({ error: 'grades must be an object mapping grade → count.' }, 400);

  // Build the list of individual sends to insert
  const rows: Array<{ customer_id: string; wall: string; grade: string; points: number }> = [];
  let pointsEarned = 0;

  for (const [grade, rawCount] of Object.entries(gradesRaw as Record<string, unknown>)) {
    if (!VALID_GRADES.includes(grade as typeof VALID_GRADES[number])) continue;
    const count = Math.floor(Number(rawCount));
    if (!Number.isFinite(count) || count <= 0) continue;
    if (rows.length + count > MAX_SENDS_PER_SUBMIT)
      return json({ error: `Max ${MAX_SENDS_PER_SUBMIT} sends per submission.` }, 400);
    const pts = GRADE_POINTS[grade];
    for (let i = 0; i < count; i++) {
      rows.push({ customer_id: '', wall, grade, points: pts }); // customer_id filled below
    }
    pointsEarned += pts * count;
  }

  if (rows.length === 0) return json({ error: 'No valid sends to log.' }, 400);

  // ── Look up customer ──────────────────────────────────────────────────────
  const safe = customerName.replace(/[^\x20-\x7E]/g, '');
  if (!safe) return json({ error: 'Customer name must contain printable characters.' }, 400);
  const { data: customer } = await db
    .from('customers')
    .select('id, full_name')
    .ilike('full_name', escapeLike(safe))
    .limit(1)
    .single();

  if (!customer) return json({ error: 'Customer not found. Please check your name.' }, 404);

  const customerId = customer.id as string;

  // ── Nickname uniqueness check ─────────────────────────────────────────────
  // Reject if another customer already holds this nickname (case-insensitive).
  const { data: taken } = await db
    .from('leaderboard_nicknames')
    .select('customer_id')
    .ilike('nickname', escapeLike(nickname))
    .limit(1)
    .single();

  if (taken && (taken as any).customer_id !== customerId) {
    return json({ error: 'That nickname is already taken by another climber. Choose a different one.' }, 409);
  }

  // ── Upsert nickname ───────────────────────────────────────────────────────
  const { error: nickError } = await db
    .from('leaderboard_nicknames')
    .upsert(
      { customer_id: customerId, nickname, updated_at: new Date().toISOString() },
      { onConflict: 'customer_id' },
    );

  if (nickError) return json({ error: nickError.message }, 500);

  // ── Insert sends ──────────────────────────────────────────────────────────
  const insertRows = rows.map(r => ({ ...r, customer_id: customerId }));
  const { error: insertError } = await db.from('leaderboard_sends').insert(insertRows);
  if (insertError) return json({ error: insertError.message }, 500);

  return json({ success: true, points_earned: pointsEarned, sends_count: rows.length });
};
