/**
 * Canonical staff roster.
 *
 * Used to populate the staff sign-off dropdown on the public leaderboard and to
 * validate the submitted name server-side, so typos and junk never reach the
 * audit trail.
 *
 * `src/pages/schedule.astro` keeps its own copy of this list — its script is
 * `is:inline` and cannot import — so add new staff in both places for now.
 */
export const STAFF_NAMES = [
  'Huyen',
  'Duyen Ha',
  'Bao Anh',
  'Danny',
  'Minh Chau',
  'Le Nghia',
  'Kim An',
  'Bich Van',
  'Thuy Vy',
  'Hong Hanh',
] as const;

/** True if `name` is on the roster (exact match after trimming). */
export function isKnownStaff(name: string): boolean {
  return (STAFF_NAMES as readonly string[]).includes(name.trim());
}

/**
 * Part-timer roster.
 *
 * All part-timers share a single login (a `staff_users` row with role `'staff'`).
 * Because the account can't identify the person, whoever claims an open shift
 * picks their own name from this list; the server validates the pick against it
 * so payroll totals can never be split across a typo'd variant of a name.
 *
 * Every name here is also in STAFF_NAMES, on purpose: part-timers work the desk
 * and sign off leaderboard submissions like anyone else, and the admin assigns
 * them shifts directly as well as posting open slots. The two lists stay
 * separate because only this one may claim an open part-time shift, and only
 * this one is totalled in the part-timer hours panel.
 *
 * Mirrored in `src/pages/schedule.astro` (see note above).
 */
export const PART_TIMER_NAMES = [
  'Bao Anh',
  'Danny',
  'Minh Chau',
  'Le Nghia',
  'Kim An',
  'Bich Van',
  'Thuy Vy',
  'Hong Hanh',
] as const;

/** True if `name` is on the part-timer roster (exact match after trimming). */
export function isKnownPartTimer(name: string): boolean {
  return (PART_TIMER_NAMES as readonly string[]).includes(name.trim());
}

/**
 * Shift kinds stored in `schedule_entries.shift_type`.
 *
 * `assigned`  — the admin named the person up front (the original behaviour).
 * `part_time` — the admin posted a slot that needs filling. It starts with an
 *               empty `staff_name`; claiming writes the part-timer's name there,
 *               which is what makes every existing hours calculation — weekly
 *               totals, the part-timer panel, Monthly Hours — work unchanged.
 */
export const SHIFT_TYPES = ['assigned', 'part_time'] as const;
export type ShiftType = (typeof SHIFT_TYPES)[number];

/** Narrow an untrusted value to a ShiftType, defaulting to `'assigned'`. */
export function toShiftType(value: unknown): ShiftType {
  return value === 'part_time' ? 'part_time' : 'assigned';
}
