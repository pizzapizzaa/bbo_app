export const prerender = false;

import type { APIRoute } from 'astro';
import { randomUUID } from 'crypto';
import { db } from '../../../lib/db';
import { escapeLike, namesMatch, MAX_NAME } from '../../../lib/validate';
import { getWallAvailability } from '../../../lib/wall-config';
import { isKnownStaff } from '../../../lib/staff';
import {
  SIG_VERSION,
  hashSignatureImage,
  signSubmission,
  validateSignatureImage,
} from '../../../lib/leaderboard-sig';

const VALID_WALLS  = ['W1', 'W2', 'W3', 'W4', 'W5', 'W6'] as const;
const VALID_GRADES = ['V0', 'V1', 'V2', 'V3', 'V4', 'V5', 'V6', 'V7', 'V8'] as const;
const GRADE_POINTS: Record<string, number> = {
  V0: 10, V1: 15, V2: 20, V3: 25, V4: 40,
  V5: 60, V6: 80, V7: 100, V8: 130,
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
    db.from('leaderboard_sends').select('customer_id, points, submission_id'),
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

  // Aggregate points by customer_id.
  // `signed` counts sends linked to a staff-signed submission; sends logged
  // before staff sign-off existed have no submission_id and stay unsigned.
  const totals: Record<
    string,
    { nickname: string; total: number; sends: number; signed: number }
  > = {};
  for (const row of sendsResult.data ?? []) {
    const nick = nicknameMap[row.customer_id];
    if (!nick) continue; // no nickname registered — skip
    if (!totals[row.customer_id]) {
      totals[row.customer_id] = { nickname: nick, total: 0, sends: 0, signed: 0 };
    }
    totals[row.customer_id].total += row.points;
    totals[row.customer_id].sends += 1;
    if (row.submission_id) totals[row.customer_id].signed += 1;
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
        .select('id, full_name')
        .ilike('full_name', escapeLike(safe))
        .limit(1)
        .single();
      if (cust && namesMatch(cust.full_name, safe)) {
        existingNickname = nicknameMap[cust.id] ?? null;
      }
    }
  }

  return json({ leaderboard, existingNickname });
};

// ── POST /api/public/leaderboard ────────────────────────────────────────────
// Body: { customer_name, nickname, wall, grades: { V0: 2, V3: 1, … },
//         staff_name, signature_image }
// Every submission must be signed off by a staff member on the kiosk.
export const POST: APIRoute = async ({ request }) => {
  let body: {
    customer_name?: unknown;
    nickname?: unknown;
    wall?: unknown;
    grades?: unknown;
    staff_name?: unknown;
    signature_image?: unknown;
  };
  try { body = await request.json(); }
  catch { return json({ error: 'Invalid JSON' }, 400); }

  const customerName = String(body.customer_name ?? '').trim();
  const nickname     = String(body.nickname     ?? '').trim();
  const wall         = String(body.wall         ?? '').trim().toUpperCase();
  const staffName    = String(body.staff_name   ?? '').trim();
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

  // ── Staff sign-off ────────────────────────────────────────────────────────
  if (!staffName)
    return json({ error: 'A staff member must sign off on this submission.' }, 400);
  if (!isKnownStaff(staffName))
    return json({ error: 'Please select a staff member from the list.' }, 400);

  const signatureImage = validateSignatureImage(body.signature_image);
  if (!signatureImage)
    return json({ error: 'A staff signature is required.' }, 400);

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

  // Exact (case-insensitive) match required — otherwise a pattern match could
  // log sends onto a different climber's account.
  if (!customer || !namesMatch(customer.full_name, safe)) {
    return json({ error: 'Customer not found. Please check your name.' }, 404);
  }

  const customerId = customer.id as string;

  // ── Wall route-limit validation ───────────────────────────────────────────
  // Compute how many of each grade this customer has already sent on this wall
  // in the current reset period, then reject if the submission would exceed the
  // configured per-grade route count.
  const availability = await getWallAvailability(customerId, wall);
  if (!availability) {
    return json({ error: 'Wall configuration not found. Please contact staff.' }, 404);
  }

  // Count submitted grades
  const submittedCounts: Record<string, number> = {};
  for (const row of rows) {
    submittedCounts[row.grade] = (submittedCounts[row.grade] ?? 0) + 1;
  }

  for (const [grade, count] of Object.entries(submittedCounts)) {
    const avail = availability.grades[grade];
    if (!avail || count > avail.remaining) {
      const rem = avail?.remaining ?? 0;
      const max = avail?.max ?? 0;
      const sent = avail?.sent ?? 0;
      return json({
        error: rem === 0
          ? `${grade} on ${wall}: you've already sent all ${max} routes this period.`
          : `${grade} on ${wall}: only ${rem} route${rem !== 1 ? 's' : ''} remaining this period (${sent}/${max} already sent).`,
      }, 400);
    }
  }

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

  // ── Seal and record the signed submission ─────────────────────────────────
  // The signature covers the facts below, so none of them can be altered later
  // without the audit endpoint noticing.
  const submissionId = randomUUID();
  const signedAt     = new Date().toISOString();
  const imageSha256  = hashSignatureImage(signatureImage);

  const signature = signSubmission({
    submissionId,
    customerId,
    wall,
    grades:     submittedCounts,
    sendsCount: rows.length,
    points:     pointsEarned,
    staffName,
    signedAt,
    imageSha256,
  });

  const { error: submissionError } = await db.from('leaderboard_submissions').insert({
    id:            submissionId,
    customer_id:   customerId,
    wall,
    grades:        submittedCounts,
    sends_count:   rows.length,
    points:        pointsEarned,
    staff_name:    staffName,
    signed_at:     signedAt,
    image_sha256:  imageSha256,
    signature,
    sig_version:   SIG_VERSION,
  });
  if (submissionError) return json({ error: submissionError.message }, 500);

  // Image lives in its own table so the leaderboard query never drags it along.
  const { error: imageError } = await db.from('leaderboard_signature_images').insert({
    submission_id: submissionId,
    image:         signatureImage,
  });
  if (imageError) {
    await db.from('leaderboard_submissions').delete().eq('id', submissionId);
    return json({ error: imageError.message }, 500);
  }

  // ── Insert sends ──────────────────────────────────────────────────────────
  const insertRows = rows.map(r => ({ ...r, customer_id: customerId, submission_id: submissionId }));
  const { error: insertError } = await db.from('leaderboard_sends').insert(insertRows);
  if (insertError) {
    // Roll back by hand — PostgREST gives us no transaction. Deleting the
    // submission cascades to the image, so no orphan signature is left behind.
    await db.from('leaderboard_submissions').delete().eq('id', submissionId);
    return json({ error: insertError.message }, 500);
  }

  return json({
    success:       true,
    points_earned: pointsEarned,
    sends_count:   rows.length,
    signed_by:     staffName,
    submission_id: submissionId,
  });
};
