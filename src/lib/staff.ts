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
  'Thanh Tu',
  'Bao Anh',
  'Danny',
  'Minh Chau',
] as const;

/** True if `name` is on the roster (exact match after trimming). */
export function isKnownStaff(name: string): boolean {
  return (STAFF_NAMES as readonly string[]).includes(name.trim());
}
