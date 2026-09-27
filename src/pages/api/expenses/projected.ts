export const prerender = false;

import type { APIRoute } from 'astro';
import { db } from '../../../lib/db';
import { adminOnly, ok, serverError } from '../../../lib/auth';
import { fetchAllPages } from '../../../lib/paginate';
import { financePeriod, projectFixedCosts } from '../../../lib/fixed-costs';

/**
 * GET /api/expenses/projected?month=YYYY-MM
 * Projected fixed costs for one finance month (29th of the previous month →
 * 28th of `month`). See lib/fixed-costs.ts for the rules.
 */
export const GET: APIRoute = async ({ request, url }) => {
  const denied = await adminOnly(request);
  if (denied) return denied;

  const period = financePeriod(url.searchParams.get('month') ?? '');
  if (!period) {
    return new Response(JSON.stringify({ error: 'Invalid month (expected YYYY-MM)' }), { status: 400 });
  }

  const [shiftRes, checkinRes, expenseRes] = await Promise.all([
    fetchAllPages((from, to) => db.from('schedule_entries')
      .select('staff_name, date, start_time, end_time')
      .gte('date', period.start).lte('date', period.end).range(from, to)),
    fetchAllPages((from, to) => db.from('checkins')
      .select('amount, checkin_type')
      .gte('date', period.start).lte('date', period.end).range(from, to)),
    fetchAllPages((from, to) => db.from('expenses')
      .select('amount')
      .gte('date', period.start).lte('date', period.end).range(from, to)),
  ]);

  if (shiftRes.error)   return serverError(shiftRes.error.message);
  if (checkinRes.error) return serverError(checkinRes.error.message);
  if (expenseRes.error) return serverError(expenseRes.error.message);

  return ok(projectFixedCosts({
    period,
    shifts:   shiftRes.data   ?? [],
    checkins: checkinRes.data ?? [],
    expenses: expenseRes.data ?? [],
  }));
};
