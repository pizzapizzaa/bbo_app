export const prerender = false;

import type { APIRoute } from 'astro';
import { randomUUID } from 'crypto';
import { db } from '../../../lib/db';
import { escapeLike, namesMatch, MAX_NAME } from '../../../lib/validate';
import { getWallAvailability } from '../../../lib/wall-config';
import { isKnownStaff } from '../../../lib/staff';
import { fetchAllPages } from '../../../lib/paginate';
import { nicknameError } from '../../../lib/nickname';
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
const MAX_SENDS_PER_SUBMIT = 50;
const NICKNAME_TAKEN = 'That nickname is already taken by another climber. Choose a different one.';

const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });

/** The customer with exactly this name (case-insensitive), or null. */
async function findCustomer(name: string): Promise<{ id: string; full_name: string } | null> {
  if (!name || name.length > MAX_NAME) return null;
  const safe = name.replace(/[^\x20-\x7E]/g, '');
  if (!safe) return null;
  const { data } = await db
    .from('customers')
    .select('id, full_name')
    .ilike('full_name', escapeLike(safe))
    .limit(1)
    .single();
  // Exact (case-insensitive) match required — otherwise a pattern match could
  // act on a different climber's account.
  return data && namesMatch(data.full_name, safe) ? data : null;
}

/** True when another customer already holds this nickname (case-insensitive). */
async function nicknameTakenByOther(nickname: string, customerId: string | null): Promise<boolean> {
  const { data: taken } = await db
    .from('leaderboard_nicknames')
    .select('customer_id')
    .ilike('nickname', escapeLike(nickname))
    .limit(1)
    .single();
  return !!taken && (taken as any).customer_id !== customerId;
}

// ── GET /api/public/leaderboard ─────────────────────────────────────────────
// Returns the ranked leaderboard.
//
// With ?lookup=<customer_name>[&nickname=<nickname>] it instead checks step 1
// of the Log My Send flow, before staff are asked to sign:
//   { customerFound, existingNickname, nicknameError }
// nicknameError is null when the nickname is valid and free for this customer.
export const GET: APIRoute = async ({ url }) => {
  if (url.searchParams.has('lookup')) {
    const customer = await findCustomer((url.searchParams.get('lookup') ?? '').trim());

    let existingNickname: string | null = null;
    if (customer) {
      const { data } = await db
        .from('leaderboard_nicknames')
        .select('nickname')
        .eq('customer_id', customer.id)
        .maybeSingle();
      existingNickname = (data as any)?.nickname ?? null;
    }

    let nickError: string | null = null;
    if (url.searchParams.has('nickname')) {
      const nickname = (url.searchParams.get('nickname') ?? '').trim();
      nickError = nicknameError(nickname);
      if (!nickError && await nicknameTakenByOther(nickname, customer?.id ?? null)) {
        nickError = NICKNAME_TAKEN;
      }
    }

    return json({ customerFound: !!customer, existingNickname, nicknameError: nickError });
  }

  // Page through both tables: a single select stops at Supabase's 1000-row cap,
  // which would silently drop sends from the totals once the season passes it.
  const [sendsResult, nicknamesResult] = await Promise.all([
    fetchAllPages((from, to) =>
      db.from('leaderboard_sends').select('customer_id, points, submission_id').order('id').range(from, to)),
    fetchAllPages((from, to) =>
      db.from('leaderboard_nicknames').select('customer_id, nickname').order('customer_id').range(from, to)),
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

  // Equal points share a rank (1, 2, 2, 4); names only order the display.
  const sorted = Object.values(totals)
    .sort((a, b) => b.total - a.total || a.nickname.localeCompare(b.nickname))
    .slice(0, 100);
  let rank = 0;
  const leaderboard = sorted.map((entry, i) => {
    if (i === 0 || entry.total !== sorted[i - 1].total) rank = i + 1;
    return { rank, ...entry };
  });

  return json({ leaderboard });
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
  const invalidNickname = nicknameError(nickname);
  if (invalidNickname) return json({ error: invalidNickname }, 400);
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
  const customer = await findCustomer(customerName);
  if (!customer) {
    return json({ error: 'Customer not found. Please check your name.' }, 404);
  }

  const customerId = customer.id;

  // ── Wall route-limit validation ───────────────────────────────────────────
  // Compute how many of each grade this customer has already sent on this
  // wall's current set, then reject if the submission would exceed the
  // per-grade route count recorded for that set.
  const availability = await getWallAvailability(customerId, wall);
  if (!availability) {
    return json({ error: 'Wall configuration not found. Please contact staff.' }, 404);
  }
  if (availability.resetting) {
    return json({ error: `${wall} is being reset — logging opens ${availability.opensLabel}.` }, 409);
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
  // Step 1 already checked this, but the nickname can be claimed in between.
  if (await nicknameTakenByOther(nickname, customerId)) {
    return json({ error: NICKNAME_TAKEN }, 409);
  }

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

  // ── Upsert nickname ───────────────────────────────────────────────────────
  // Last, so a submission that fails earlier leaves the climber's nickname as
  // it was. If this step fails, the submission is undone too: without a
  // nickname a first-time climber's sends would never show on the board.
  const { error: nickError } = await db
    .from('leaderboard_nicknames')
    .upsert(
      { customer_id: customerId, nickname, updated_at: new Date().toISOString() },
      { onConflict: 'customer_id' },
    );
  if (nickError) {
    // Cascades to the sends and the signature image.
    await db.from('leaderboard_submissions').delete().eq('id', submissionId);
    // 23505: someone claimed the nickname after the check above.
    if (nickError.code === '23505') return json({ error: NICKNAME_TAKEN }, 409);
    return json({ error: nickError.message }, 500);
  }

  return json({
    success:       true,
    points_earned: pointsEarned,
    sends_count:   rows.length,
    signed_by:     staffName,
    submission_id: submissionId,
  });
};
