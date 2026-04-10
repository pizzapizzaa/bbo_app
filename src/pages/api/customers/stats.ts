export const prerender = false;

import type { APIRoute } from 'astro';
import { db } from '../../../lib/db';
import { ok, serverError } from '../../../lib/auth';
import { fetchAllPages } from '../../../lib/paginate';

/**
 * GET /api/customers/stats
 *
 * Query params (all optional – compute only what is requested):
 *   stats_from, stats_to   YYYY-MM-DD  → new_customers count + returned_pct
 *   hm_from,    hm_to      YYYY-MM-DD  → heatmap daily check-in counts
 */
export const GET: APIRoute = async ({ url }) => {
  const statsFrom = url.searchParams.get('stats_from');
  const statsTo   = url.searchParams.get('stats_to');
  const hmFrom    = url.searchParams.get('hm_from');
  const hmTo      = url.searchParams.get('hm_to');

  const result: Record<string, unknown> = {};

  try {
    // ── New customers & returned % ───────────────────────────────────────────
    if (statsFrom && statsTo) {
      // Count customers created in the date range (UTC-based)
      const { count: newCount, error: newErr } = await db
        .from('customers')
        .select('id', { count: 'exact', head: true })
        .gte('created_at', statsFrom + 'T00:00:00.000Z')
        .lte('created_at', statsTo   + 'T23:59:59.999Z');
      if (newErr) return serverError(newErr.message);
      result.new_customers = newCount ?? 0;

      // Unique visitors in the period
      const { data: periodRows, error: periodErr } = await fetchAllPages((f, t) =>
        db.from('checkins')
          .select('customer_name')
          .gte('date', statsFrom)
          .lte('date', statsTo)
          .range(f, t)
      );
      if (periodErr) return serverError(periodErr.message);

      const periodNames = [
        ...new Set(
          (periodRows ?? [])
            .map((r: any) => String(r.customer_name))
            .filter((n) => n !== 'Other')
        )
      ];
      result.total_period_visitors = periodNames.length;

      if (periodNames.length > 0) {
        // Which of those names also have a prior check-in?
        const { data: priorRows, error: priorErr } = await fetchAllPages((f, t) =>
          db.from('checkins')
            .select('customer_name')
            .lt('date', statsFrom)
            .in('customer_name', periodNames)
            .range(f, t)
        );
        if (!priorErr && priorRows) {
          const priorSet = new Set(priorRows.map((r: any) => String(r.customer_name)));
          result.returned_count = priorSet.size;
          result.returned_pct   = Math.round((priorSet.size / periodNames.length) * 1000) / 10;
        } else {
          result.returned_count = 0;
          result.returned_pct   = 0;
        }
      } else {
        result.returned_count = 0;
        result.returned_pct   = null; // no visitors → N/A
      }
    }

    // ── Heatmap: daily check-in counts ──────────────────────────────────────
    if (hmFrom && hmTo) {
      const { data: hmRows, error: hmErr } = await fetchAllPages((f, t) =>
        db.from('checkins')
          .select('date, customer_name')
          .gte('date', hmFrom)
          .lte('date', hmTo)
          .range(f, t)
      );
      if (hmErr) return serverError(hmErr.message);

      const counts: Record<string, number> = {};
      (hmRows ?? []).forEach((r: any) => {
        if (String(r.customer_name) === 'Other') return;
        const d = String(r.date);
        counts[d] = (counts[d] ?? 0) + 1;
      });
      result.heatmap = Object.entries(counts)
        .map(([date, count]) => ({ date, count }))
        .sort((a, b) => a.date.localeCompare(b.date));
    }

    return ok(result);
  } catch (e: any) {
    return serverError(e?.message ?? String(e));
  }
};
