export const prerender = false;

import type { APIRoute } from 'astro';
import { db } from '../../../lib/db';
import { escapeLike } from '../../../lib/validate';

/** GET /api/public/customers?q=<search_term>
 *  Returns up to 10 customer full_names matching the query.
 *  Requires at least 2 characters to avoid bulk-listing all customers.
 */
export const GET: APIRoute = async ({ url }) => {
  const q = (url.searchParams.get('q') ?? '').trim();

  if (q.length < 2) {
    return new Response(JSON.stringify({ names: [] }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  // Only allow ASCII search terms to match the English-only name policy
  const safe = q.replace(/[^\x20-\x7E]/g, '');
  if (!safe) {
    return new Response(JSON.stringify({ names: [] }), { status: 200 });
  }

  // Only the surrounding %…% are wildcards; everything the caller typed is
  // escaped so it cannot widen the search (see escapeLike).
  const { data, error } = await db
    .from('customers')
    .select('full_name')
    .ilike('full_name', `%${escapeLike(safe)}%`)
    .order('full_name')
    .limit(10);

  if (error) {
    return new Response(JSON.stringify({ names: [] }), { status: 200 });
  }

  const names = (data ?? []).map((r: any) => r.full_name as string).filter(Boolean);

  return new Response(JSON.stringify({ names }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
};
