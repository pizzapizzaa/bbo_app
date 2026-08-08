export const prerender = false;

import type { APIRoute } from 'astro';
import { db } from '../../../lib/db';
import { requireAdmin, ok, serverError, unauthorized } from '../../../lib/auth';
import { hashSignatureImage, verifySubmission } from '../../../lib/leaderboard-sig';

/**
 * GET /api/leaderboard/audit — admin only
 *
 * Re-derives the HMAC seal for every stored submission and reports anything
 * that no longer matches. This is what makes the signature worth storing: a
 * seal nobody ever re-checks proves nothing.
 *
 * Four independent checks per submission:
 *   signature      the seal matches the stored facts
 *   image          the stored PNG still hashes to the sealed digest
 *   sends_count    the linked send rows still number what was signed
 *   points         the linked send rows still total what was signed
 *
 * Optional ?verbose=1 lists every submission, not just the problems.
 */
export const GET: APIRoute = async ({ request, url }) => {
  if (!await requireAdmin(request)) return unauthorized();

  const verbose = url.searchParams.get('verbose') === '1';

  try {
    const [subsRes, imagesRes, sendsRes] = await Promise.all([
      db.from('leaderboard_submissions').select('*').order('signed_at', { ascending: false }),
      db.from('leaderboard_signature_images').select('submission_id, image'),
      db.from('leaderboard_sends').select('submission_id, points'),
    ]);

    if (subsRes.error)   return serverError(subsRes.error.message);
    if (imagesRes.error) return serverError(imagesRes.error.message);
    if (sendsRes.error)  return serverError(sendsRes.error.message);

    const imageBySubmission = new Map<string, string>();
    for (const row of imagesRes.data ?? []) {
      imageBySubmission.set(row.submission_id, row.image);
    }

    // Tally the send rows actually linked to each submission.
    const sendTally = new Map<string, { count: number; points: number }>();
    let unsignedSends = 0;
    for (const row of sendsRes.data ?? []) {
      if (!row.submission_id) { unsignedSends++; continue; }
      const t = sendTally.get(row.submission_id) ?? { count: 0, points: 0 };
      t.count  += 1;
      t.points += Number(row.points) || 0;
      sendTally.set(row.submission_id, t);
    }

    const results = (subsRes.data ?? []).map((s: any) => {
      const problems: string[] = [];

      const sealOk = verifySubmission(
        {
          submissionId: s.id,
          customerId:   s.customer_id,
          wall:         s.wall,
          grades:       s.grades ?? {},
          sendsCount:   Number(s.sends_count),
          points:       Number(s.points),
          staffName:    s.staff_name,
          signedAt:     s.signed_at,
          imageSha256:  s.image_sha256,
        },
        s.signature,
      );
      if (!sealOk) problems.push('signature does not match the stored facts');

      const image = imageBySubmission.get(s.id);
      if (image === undefined) problems.push('signature image is missing');
      else if (hashSignatureImage(image) !== s.image_sha256) {
        problems.push('signature image has been replaced');
      }

      const tally = sendTally.get(s.id) ?? { count: 0, points: 0 };
      if (tally.count !== Number(s.sends_count)) {
        problems.push(`sends_count is ${s.sends_count} but ${tally.count} send rows are linked`);
      }
      if (tally.points !== Number(s.points)) {
        problems.push(`points is ${s.points} but linked send rows total ${tally.points}`);
      }

      return {
        id:          s.id,
        signed_at:   s.signed_at,
        staff_name:  s.staff_name,
        wall:        s.wall,
        sends_count: s.sends_count,
        points:      s.points,
        ok:          problems.length === 0,
        problems,
      };
    });

    const failed = results.filter((r) => !r.ok);

    return ok({
      total:          results.length,
      ok:             results.length - failed.length,
      failed:         failed.length,
      unsigned_sends: unsignedSends, // legacy rows logged before sign-off existed
      submissions:    verbose ? results : failed,
    });
  } catch (e: any) {
    return serverError(e?.message ?? String(e));
  }
};
