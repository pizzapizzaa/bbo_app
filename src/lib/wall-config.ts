/**
 * Shared helpers for wall reset-period calculation and per-grade availability.
 * Used by both /api/public/wall-availability (GET) and /api/public/leaderboard (POST).
 */

import { db } from './db';

export interface GradeAvailability {
  max:       number;  // routes of this grade on this wall this period
  sent:      number;  // how many the customer already logged
  remaining: number;  // max − sent (floored at 0)
}

export interface WallAvailability {
  wall:         string;
  periodStart:  string;  // ISO date string YYYY-MM-DD
  periodEnd:    string;  // ISO date string YYYY-MM-DD (last day, inclusive)
  grades:       Record<string, GradeAvailability>;
}

const GRADES = ['V0','V1','V2','V3','V4','V5','V6','V7','V8'] as const;

/**
 * Compute which period (by start timestamp in ms) a given `nowMs` falls into,
 * given that `next_reset` is one known boundary and each period is `periodWeeks` weeks.
 *
 * Formula:  periodStart = nextResetMs + floor((nowMs − nextResetMs) / periodMs) * periodMs
 *
 * Works even if nowMs < nextResetMs (result is the period that precedes next_reset).
 */
export function computePeriodStart(nextResetMs: number, periodWeeks: number): number {
  const periodMs = periodWeeks * 7 * 24 * 60 * 60 * 1000;
  const n = Math.floor((Date.now() - nextResetMs) / periodMs);
  return nextResetMs + n * periodMs;
}

/**
 * Fetch wall config + existing sends and return full availability for
 * `customerId` on `wall` in the current reset period.
 * Returns null if the wall config row is missing.
 */
export async function getWallAvailability(
  customerId: string,
  wall:       string,
): Promise<WallAvailability | null> {
  const { data: config, error } = await db
    .from('wall_configs')
    .select('*')
    .eq('wall', wall)
    .single();

  if (error || !config) return null;

  const periodWeeks  = Number(config.period_weeks);
  const nextResetMs  = new Date(config.next_reset as string).getTime();
  const periodMs     = periodWeeks * 7 * 24 * 60 * 60 * 1000;
  const periodStartMs = computePeriodStart(nextResetMs, periodWeeks);
  const periodStartISO = new Date(periodStartMs).toISOString();

  // Period end = day before the following reset (display only)
  const periodEndMs  = periodStartMs + periodMs - 24 * 60 * 60 * 1000;

  // Sends this customer logged on this wall in this period
  const { data: sends } = await db
    .from('leaderboard_sends')
    .select('grade')
    .eq('customer_id', customerId)
    .eq('wall', wall)
    .gte('logged_at', periodStartISO);

  const sentCounts: Record<string, number> = {};
  for (const row of sends ?? []) {
    const g = (row as any).grade as string;
    sentCounts[g] = (sentCounts[g] ?? 0) + 1;
  }

  const grades: Record<string, GradeAvailability> = {};
  for (const grade of GRADES) {
    const max  = Number((config as any)[grade.toLowerCase()] ?? 0);
    const sent = sentCounts[grade] ?? 0;
    grades[grade] = { max, sent, remaining: Math.max(0, max - sent) };
  }

  return {
    wall,
    periodStart: periodStartISO.slice(0, 10),
    periodEnd:   new Date(periodEndMs).toISOString().slice(0, 10),
    grades,
  };
}
