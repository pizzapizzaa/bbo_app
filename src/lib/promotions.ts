/**
 * Time-boxed, gym-wide promotions applied automatically at check-in.
 *
 * Unlike `referral_codes` — which the customer has to quote and which staff
 * have to pick deliberately — a promotion asks nothing of either side: if the
 * check-in date falls inside the window, the price and the punch grant already
 * reflect it. The check-in form (price preview) and POST /api/checkins (punch
 * grant) both read this module, so there is exactly one place to edit when the
 * next promo comes around.
 *
 * Two rules worth stating, because they differ:
 *
 *   • `base_discount_pct` applies only when staff leave the discount radios on
 *     "No discount". The gym's rule is one discount per check-in, and a
 *     hand-picked discount is the more specific signal, so it wins outright.
 *   • `bonus_punches` applies whenever the card is bought inside the window.
 *     Those punches are what the card *contains*, not a cut off its price, so
 *     no discount choice can displace them.
 */

export interface Promotion {
  id:    string;
  /** Shown to staff on the check-in form and written into the check-in row. */
  label: string;
  /** Inclusive YYYY-MM-DD window, compared against the check-in date. */
  starts_on: string;
  ends_on:   string;
  /** % off the base price, keyed by check-in type. Absent = full price. */
  base_discount_pct: Record<string, number>;
  /** Punches on top of the card's face value, keyed by check-in type. */
  bonus_punches: Record<string, number>;
}

/**
 * Keys must match the `<option value>` strings in src/pages/pos/checkin.astro
 * exactly — note the en dash (–), not a hyphen. promotions.test.ts asserts
 * this, so a renamed product fails the suite instead of silently un-applying
 * the promo at the counter.
 */
export const PROMOTIONS: Promotion[] = [
  {
    id:        'national-day-2026',
    label:     'National Day Special',
    starts_on: '2026-08-30',
    ends_on:   '2026-09-03',
    base_discount_pct: {
      'Day Pass – Adult':       10,
      'Day Pass – Student':     10,
      'Day Pass – Kid':         10,
      'Membership – 1 Month':    5,
      'Membership – 3 Months':   5,
      'Membership – 6 Months':   5,
      'Membership – 12 Months':  5,
    },
    bonus_punches: {
      '10 Punches – Adult':   2,   // 10 ➜ 12
      '10 Punches – Student': 2,
      '10 Punches – Kid':     2,
      '20 Punches – Adult':   5,   // 20 ➜ 25
    },
  },
];

/**
 * The promotion covering `date` (YYYY-MM-DD), or null.
 *
 * ISO dates sort lexicographically, so plain string comparison is enough and
 * keeps the server's timezone out of what is a gym-local calendar question.
 * Callers pass the check-in date from the form rather than "today", so a
 * backdated entry is priced as of the day it happened.
 */
export function activePromotion(date: string, promotions: Promotion[] = PROMOTIONS): Promotion | null {
  if (!date) return null;
  return promotions.find(p => date >= p.starts_on && date <= p.ends_on) ?? null;
}

/** % off the base price of `checkinType` under `promo`; 0 when not covered. */
export function promoDiscountPct(promo: Promotion | null, checkinType: string): number {
  if (!promo || !checkinType) return 0;
  return promo.base_discount_pct[checkinType] ?? 0;
}

/** Extra punches `checkinType` grants under `promo`; 0 when not covered. */
export function promoBonusPunches(promo: Promotion | null, checkinType: string): number {
  if (!promo || !checkinType) return 0;
  return promo.bonus_punches[checkinType] ?? 0;
}
