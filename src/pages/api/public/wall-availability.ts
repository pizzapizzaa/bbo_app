export const prerender = false;

import type { APIRoute } from 'astro';
import { db } from '../../../lib/db';
import { escapeLike, namesMatch, MAX_NAME } from '../../../lib/validate';
import { getWallAvailability } from '../../../lib/wall-config';

const VALID_WALLS = ['W1', 'W2', 'W3', 'W4', 'W5', 'W6'] as const;

const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });

/**
 * GET /api/public/wall-availability?customer_name=<name>&wall=<wall>
 *
 * Returns per-grade availability for the customer on the given wall
 * in the current reset period.  Used by the leaderboard Log My Send
 * modal to cap/disable grade counters.
 */
export const GET: APIRoute = async ({ url }) => {
  const customerName = (url.searchParams.get('customer_name') ?? '').trim();
  const wall = (url.searchParams.get('wall') ?? '').trim().toUpperCase();

  if (!customerName || customerName.length > MAX_NAME)
    return json({ error: 'Invalid customer name.' }, 400);
  if (!VALID_WALLS.includes(wall as typeof VALID_WALLS[number]))
    return json({ error: 'Invalid wall.' }, 400);

  const safe = customerName.replace(/[^\x20-\x7E]/g, '');
  if (!safe) return json({ error: 'Invalid customer name.' }, 400);

  // Find customer
  const { data: customer } = await db
    .from('customers')
    .select('id, full_name')
    .ilike('full_name', escapeLike(safe))
    .limit(1)
    .single();

  if (!customer || !namesMatch((customer as any).full_name, safe)) {
    return json({ error: 'Customer not found.' }, 404);
  }

  const availability = await getWallAvailability((customer as any).id as string, wall);
  if (!availability) return json({ error: 'Wall configuration not found.' }, 404);

  return json(availability);
};
