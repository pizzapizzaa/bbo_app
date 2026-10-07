export const prerender = false;

import type { APIRoute } from 'astro';
import { db } from '../../lib/db';
import { isValidUUID } from '../../lib/validate';
import { isValidBetaVideoUrl } from '../../lib/beta-videos';

function unavailable(status: number): Response {
  return new Response('This beta video is no longer available.', {
    status,
    headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' },
  });
}

/** GET /beta/:id — public QR destination; redirects to the currently saved video. */
export const GET: APIRoute = async ({ params }) => {
  const { id } = params;
  if (!id || !isValidUUID(id)) return unavailable(404);

  try {
    const { data, error } = await db.from('beta_videos')
      .select('video_url')
      .eq('id', id)
      .eq('is_active', true)
      .maybeSingle();
    if (error) return unavailable(503);
    if (!data || !isValidBetaVideoUrl(data.video_url)) return unavailable(404);

    return new Response(null, {
      status: 302,
      headers: { Location: data.video_url, 'Cache-Control': 'no-store' },
    });
  } catch {
    return unavailable(503);
  }
};
