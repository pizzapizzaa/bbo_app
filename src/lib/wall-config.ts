/**
 * Shared helpers for wall resets and per-grade availability.
 * Used by /api/public/wall-availability (GET), /api/public/leaderboard (POST)
 * and the staff wall-reset endpoints under /api/walls/resets.
 *
 * A wall's current set is its latest row in `wall_resets` whose `closes_at` has
 * passed. Sends count against that set from `closes_at` on, so a reset that is
 * late or skipped never lets climbers re-log the routes already on the wall.
 * Between `closes_at` and `opens_at` the wall is being reset and nothing can be
 * logged on it.
 */

import { db } from './db';
import { isValidDate, MAX_TEXT } from './validate';

export const WALLS  = ['W1', 'W2', 'W3', 'W4', 'W5', 'W6'] as const;
export const GRADES = ['V0', 'V1', 'V2', 'V3', 'V4', 'V5', 'V6', 'V7', 'V8'] as const;

export type Wall  = typeof WALLS[number];
export type Grade = typeof GRADES[number];

export function isWall(s: string): s is Wall {
  return (WALLS as readonly string[]).includes(s);
}

/** Most routes of one grade a single set may hold — a typo guard, not a rule. */
export const MAX_ROUTES_PER_GRADE = 50;

/** The gym runs on Vietnam time, which has no daylight saving. */
const GYM_OFFSET = '+07:00';
const GYM_TZ     = 'Asia/Ho_Chi_Minh';

export interface GradeAvailability {
  max:       number;  // routes of this grade in the current set
  sent:      number;  // how many the customer already logged on this set
  remaining: number;  // max − sent (floored at 0)
}

export interface WallAvailability {
  wall:        string;
  periodStart: string;   // ISO timestamp the current set's wall closed for setting
  opensAt:     string;   // ISO timestamp the current set opened (or opens) for logging
  resetting:   boolean;  // true while the wall is closed for setting
  opensLabel:  string;   // opensAt in gym time, e.g. "Tue 7 Oct, 10:30"
  grades:      Record<string, GradeAvailability>;
}

export interface WallResetRow {
  id:         string;
  wall:       string;
  closes_at:  string;
  opens_at:   string;
  v0: number; v1: number; v2: number; v3: number; v4: number;
  v5: number; v6: number; v7: number; v8: number;
  notes:      string;
  created_by: string | null;
  created_at: string;
  updated_at: string;
}

/**
 * Parse a gym-local "YYYY-MM-DDTHH:MM" (what a datetime-local input sends) into
 * an ISO timestamp. The offset is fixed here rather than taken from the browser
 * so a reset entered from a phone set to another time zone still lands on the
 * right hour at the gym.
 */
export function parseGymDateTime(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const m = /^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2})$/.exec(value.trim());
  if (!m) return null;
  const [, date, hh, mm] = m;
  if (!isValidDate(date) || Number(hh) > 23 || Number(mm) > 59) return null;
  return new Date(`${date}T${hh}:${mm}:00${GYM_OFFSET}`).toISOString();
}

/** "Tue 7 Oct, 10:30" in gym time. */
export function formatGymTime(iso: string): string {
  const parts = Object.fromEntries(
    // en-US: newer ICU abbreviates September as "Sept" in en-GB.
    new Intl.DateTimeFormat('en-US', {
      timeZone: GYM_TZ, weekday: 'short', day: 'numeric', month: 'short',
      hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
    }).formatToParts(new Date(iso)).map(p => [p.type, p.value]),
  );
  return `${parts.weekday} ${parts.day} ${parts.month}, ${parts.hour}:${parts.minute}`;
}

export interface WallResetInput {
  wall:      Wall;
  closes_at: string;
  opens_at:  string;
  counts:    Record<Grade, number>;
  notes:     string;
}

/** Validate a reset submitted from the Schedule page. */
export function validateWallReset(
  body: Record<string, unknown>,
): { value: WallResetInput } | { error: string } {
  const wall = String(body.wall ?? '').trim().toUpperCase();
  if (!isWall(wall)) return { error: `Wall must be one of: ${WALLS.join(', ')}.` };

  const closesAt = parseGymDateTime(body.closes_at);
  if (!closesAt) return { error: 'Close time must be a valid date and time.' };
  const opensAt = parseGymDateTime(body.opens_at);
  if (!opensAt) return { error: 'Reopen time must be a valid date and time.' };
  if (opensAt < closesAt) return { error: 'The wall must reopen after it closes.' };

  const rawCounts = (typeof body.counts === 'object' && body.counts !== null && !Array.isArray(body.counts))
    ? body.counts as Record<string, unknown>
    : {};
  const counts = {} as Record<Grade, number>;
  let total = 0;
  for (const grade of GRADES) {
    const n = Number(rawCounts[grade] ?? 0);
    if (!Number.isInteger(n) || n < 0 || n > MAX_ROUTES_PER_GRADE) {
      return { error: `${grade} must be a whole number from 0 to ${MAX_ROUTES_PER_GRADE}.` };
    }
    counts[grade] = n;
    total += n;
  }
  if (total === 0) return { error: 'Enter how many routes of each grade the new set has.' };

  const notes = String(body.notes ?? '').trim();
  if (notes.length > MAX_TEXT) return { error: 'Notes are too long.' };

  return { value: { wall, closes_at: closesAt, opens_at: opensAt, counts, notes } };
}

/** The database row for a validated reset (minus id and audit columns). */
export function wallResetRow(input: WallResetInput) {
  const row: Record<string, unknown> = {
    wall:      input.wall,
    closes_at: input.closes_at,
    opens_at:  input.opens_at,
    notes:     input.notes,
  };
  for (const grade of GRADES) row[grade.toLowerCase()] = input.counts[grade];
  return row;
}

/** The set a wall is on right now, or null if it has never been reset. */
export async function getCurrentReset(wall: string): Promise<WallResetRow | null> {
  const { data, error } = await db
    .from('wall_resets')
    .select('*')
    .eq('wall', wall)
    .lte('closes_at', new Date().toISOString())
    .order('closes_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error || !data) return null;
  return data as WallResetRow;
}

/**
 * Availability for `customerId` on `wall`'s current set.
 * Returns null if the wall has no reset on record yet.
 */
export async function getWallAvailability(
  customerId: string,
  wall:       string,
): Promise<WallAvailability | null> {
  const reset = await getCurrentReset(wall);
  if (!reset) return null;

  // Sends this customer logged on this wall since it was last closed for setting
  const { data: sends } = await db
    .from('leaderboard_sends')
    .select('grade')
    .eq('customer_id', customerId)
    .eq('wall', wall)
    .gte('logged_at', reset.closes_at);

  const sentCounts: Record<string, number> = {};
  for (const row of sends ?? []) {
    const g = (row as any).grade as string;
    sentCounts[g] = (sentCounts[g] ?? 0) + 1;
  }

  const grades: Record<string, GradeAvailability> = {};
  for (const grade of GRADES) {
    const max  = Number((reset as any)[grade.toLowerCase()] ?? 0);
    const sent = sentCounts[grade] ?? 0;
    grades[grade] = { max, sent, remaining: Math.max(0, max - sent) };
  }

  return {
    wall,
    periodStart: reset.closes_at,
    opensAt:     reset.opens_at,
    resetting:   new Date(reset.opens_at).getTime() > Date.now(),
    opensLabel:  formatGymTime(reset.opens_at),
    grades,
  };
}
