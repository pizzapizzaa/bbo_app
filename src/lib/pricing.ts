/**
 * The price list, and the one function that turns a check-in into an amount.
 *
 * This module is the till. POST /api/checkins calls `computeCheckinAmount` and
 * stores what it returns, so the number banked against a visit is derived from
 * the products, the discount and the date — never from whatever the browser put
 * in the amount box. The check-in form renders its dropdown, its add-on
 * checkboxes and its live price preview from the tables below (serialised into
 * the page as JSON), so what staff see quoted and what the server bills come
 * from the same figures by construction.
 *
 * Everything is whole VND. Percentages are applied as `n * (100 - pct) / 100`
 * rather than `n * (1 - pct/100)`, keeping the arithmetic on integers until the
 * final divide so a 30% cut can never land a dong away from itself.
 */

import { activePromotion, promoDiscountPct, promoBonusPunches, type Promotion } from './promotions';

// ── Products ─────────────────────────────────────────────────────────────────

export interface CheckinTypeDef {
  /** Stored verbatim on the check-in row, and the key promotions.ts matches on. */
  value: string;
  price: number;
  /** `<optgroup>` heading on the check-in form. */
  group: string;
}

/**
 * Note the en dash (–) in every name, not a hyphen. promotions.ts keys off these
 * exact strings and pricing.test.ts asserts the two stay in step, so a renamed
 * product fails the suite instead of silently un-applying a promo at the counter.
 */
export const CHECKIN_TYPES: CheckinTypeDef[] = [
  { value: 'Day Pass – Adult',          price:   160_000, group: 'Day Pass'   },
  { value: 'Day Pass – Student',        price:   120_000, group: 'Day Pass'   },
  { value: 'Day Pass – Kid',            price:   100_000, group: 'Day Pass'   },
  { value: '10 Punches – Adult',        price: 1_400_000, group: '10 Punches' },
  { value: '10 Punches – Student',      price: 1_000_000, group: '10 Punches' },
  { value: '10 Punches – Kid',          price:   800_000, group: '10 Punches' },
  { value: '20 Punches – Adult',        price: 2_500_000, group: '20 Punches' },
  // PT punch cards are settled with the trainer, so the till records no amount.
  { value: '10 PT Punches – Shingo PT', price:         0, group: 'PT Punches' },
  { value: '10 PT Punches – Other PT',  price:         0, group: 'PT Punches' },
  { value: 'Membership – 1 Month',      price: 1_250_000, group: 'Membership' },
  { value: 'Membership – 3 Months',     price: 3_050_000, group: 'Membership' },
  { value: 'Membership – 6 Months',     price: 5_650_000, group: 'Membership' },
  { value: 'Membership – 12 Months',    price: 9_850_000, group: 'Membership' },
];

export interface AddonDef {
  name: string;
  price: number;
  /**
   * Gear hired for the session. Only rentals can be discounted by a referral
   * code's `rental_discount_pct`; retail stock (drinks, chalk, socks) is sold at
   * full price under every percentage discount there is.
   */
  rental: boolean;
  /** Column heading on the check-in form. Groups render in first-seen order. */
  group: AddonGroup;
  /**
   * Tiered products are one choice on the form, not several checkboxes: the
   * whole set shares a stepper and only the selected tier is ever submitted.
   * Members of a tier must be listed together, cheapest first.
   */
  tier?: { of: string; label: string };
}

export type AddonGroup = 'Climbing' | 'Food & Drinks';

/**
 * Chalk bags are hired per group rather than per bag, so the three rates are
 * three products sharing one stepper on the form. Naming the tier in the
 * product keeps the stored row self-explaining — a check-in that reads
 * "Chalk Bag Rental (3+ people)" says why it was billed 25,000 ₫.
 */
export const ADDONS: AddonDef[] = [
  { name: 'Shoes Rental',                  price: 20_000, rental: true,  group: 'Climbing' },
  { name: 'Chalk Bag Rental (1 person)',   price: 15_000, rental: true,  group: 'Climbing', tier: { of: 'Chalk Bag Rental', label: '1 person'  } },
  { name: 'Chalk Bag Rental (2 people)',   price: 20_000, rental: true,  group: 'Climbing', tier: { of: 'Chalk Bag Rental', label: '2 people'  } },
  { name: 'Chalk Bag Rental (3+ people)',  price: 25_000, rental: true,  group: 'Climbing', tier: { of: 'Chalk Bag Rental', label: '3+ people' } },
  { name: 'Chalk Block',                   price: 65_000, rental: false, group: 'Climbing' },
  { name: 'Socks',                         price: 10_000, rental: false, group: 'Climbing' },
  { name: 'Vitani Dasani',                 price:  8_000, rental: false, group: 'Food & Drinks' },
  { name: 'Ionlife',                       price: 10_000, rental: false, group: 'Food & Drinks' },
  { name: 'Pocari',                        price: 18_000, rental: false, group: 'Food & Drinks' },
  { name: 'Apple',                         price: 33_000, rental: false, group: 'Food & Drinks' },
];

const CHECKIN_TYPE_BY_VALUE = new Map(CHECKIN_TYPES.map((t) => [t.value, t]));
const ADDON_BY_NAME         = new Map(ADDONS.map((a) => [a.name, a]));

/** Base price of a product; 0 for anything not on the price list. */
export function checkinTypePrice(value: string): number {
  return CHECKIN_TYPE_BY_VALUE.get(value)?.price ?? 0;
}
export function isKnownCheckinType(value: string): boolean {
  return CHECKIN_TYPE_BY_VALUE.has(value);
}
export function isKnownAddon(name: string): boolean {
  return ADDON_BY_NAME.has(name);
}

// ── Hand-picked discounts ────────────────────────────────────────────────────

export interface DiscountDef {
  id: string;
  /** % off the base price. 0 for a flat-amount discount. */
  pct: number;
  /** Flat VND off the whole bill, add-ons included. 0 for a percentage one. */
  flat: number;
  /** Written into the check-in's add-on trail, so the amount stays explainable. */
  label: string;
  /** The grey hint beside the radio on the check-in form. */
  hint: string;
  /** The radio's own text. */
  title: string;
}

/**
 * The radios under "Discount" on the check-in form. `referral` is deliberately
 * absent: its percentage is not fixed here but carried by the code the customer
 * quotes, so it is handled separately in `computeCheckinAmount`.
 */
export const MANUAL_DISCOUNTS: DiscountDef[] = [
  { id: 'day30',      pct: 30, flat:      0, title: '30% discount',      hint: 'Day Pass – setting day (less disturbance)', label: '30% discount – Day Pass (setting day, less disturbance)' },
  { id: 'day40',      pct: 40, flat:      0, title: '40% discount',      hint: 'Day Pass – setting day (more disturbance)', label: '40% discount – Day Pass (setting day, more disturbance)' },
  { id: 'lasthour50', pct: 50, flat:      0, title: '50% discount',      hint: 'Day Pass (late entry)',                     label: '50% discount – Day Pass (late entry)' },
  { id: 'birthday',   pct:  0, flat: 20_000, title: 'Birthday discount', hint: 'Free shoes or 20,000 ₫ off',               label: 'Birthday discount' },
];

const DISCOUNT_BY_ID = new Map(MANUAL_DISCOUNTS.map((d) => [d.id, d]));

/** '' (none), 'referral', or one of the fixed discounts above. */
export function isKnownDiscount(id: string): boolean {
  return id === '' || id === 'referral' || DISCOUNT_BY_ID.has(id);
}

// ── The calculation ──────────────────────────────────────────────────────────

export interface ReferralTerms {
  discount_pct: number;
  rental_discount_pct: number;
}

export interface PriceInput {
  /** Check-in date (YYYY-MM-DD) — decides which promotion, if any, is running. */
  date: string;
  checkin_type?: string;
  /** Add-on names; anything not in ADDONS contributes nothing. */
  addons?: string[];
  /** '' | 'referral' | a MANUAL_DISCOUNTS id. */
  discount?: string;
  /** The verified code's terms when `discount` is 'referral'; null otherwise. */
  referral?: ReferralTerms | null;
}

export interface PriceBreakdown {
  /** What to charge, in whole VND. Never negative. */
  amount: number;
  base: number;
  retail_addons: number;
  rental_addons: number;
  /** The discount actually applied — '' when the bill is at full price. */
  discount: string;
  /** % taken off the base price, whichever rule supplied it. */
  base_discount_pct: number;
  /** % taken off the rental add-ons; only a referral code ever sets this. */
  rental_discount_pct: number;
  /** Flat VND taken off the whole bill (the birthday discount). */
  flat_discount: number;
  promo: Promotion | null;
  /** The promo's % for this product — reported even when a discount displaced it. */
  promo_pct: number;
  /** Punches this product grants beyond its face value under the promo. */
  promo_bonus_punches: number;
  /** True when a hand-picked discount displaced a promo that was running. */
  promo_overridden: boolean;
}

/** `n` reduced by `pct`, kept on integers until the final divide. */
function lessPct(n: number, pct: number): number {
  if (!pct) return n;
  return Math.round((n * (100 - pct)) / 100);
}

/**
 * Price one check-in.
 *
 * The order of precedence is the gym's rule, one discount per visit:
 *
 *   • A hand-picked discount wins outright. It is the more specific signal, so
 *     it *replaces* any promotion running that day rather than stacking on it —
 *     which is why `promo_overridden` comes back, for the form to warn on.
 *   • A referral / promo code is a hand-picked discount whose percentage comes
 *     from the code. Alone among them it can also cut the rental add-ons.
 *   • With nothing picked, a promotion covering `date` applies itself.
 *
 * Retail add-ons are never cut by a percentage. The birthday discount is the one
 * exception to that: it comes off the bill as a whole, add-ons and all.
 */
export function computeCheckinAmount(input: PriceInput): PriceBreakdown {
  const base = input.checkin_type ? checkinTypePrice(input.checkin_type) : 0;

  let retail = 0;
  let rental = 0;
  for (const name of input.addons ?? []) {
    const addon = ADDON_BY_NAME.get(name);
    if (!addon) continue;
    if (addon.rental) rental += addon.price;
    else retail += addon.price;
  }

  const promo      = activePromotion(input.date);
  const promoPct   = promoDiscountPct(promo, input.checkin_type ?? '');
  const bonus      = promoBonusPunches(promo, input.checkin_type ?? '');
  const discountId = input.discount ?? '';
  const manual     = DISCOUNT_BY_ID.get(discountId);

  let basePct   = 0;
  let rentalPct = 0;
  let flat      = 0;

  if (discountId === 'referral') {
    // An unverified code discounts nothing — the caller resolves the code and
    // passes its terms, so a missing `referral` means it never checked out.
    basePct   = input.referral?.discount_pct ?? 0;
    rentalPct = input.referral?.rental_discount_pct ?? 0;
  } else if (manual) {
    basePct = manual.pct;
    flat    = manual.flat;
  } else {
    basePct = promoPct;
  }

  const subtotal = lessPct(base, basePct) + retail + lessPct(rental, rentalPct);

  return {
    amount: Math.max(0, subtotal - flat),
    base,
    retail_addons: retail,
    rental_addons: rental,
    discount: discountId,
    base_discount_pct: basePct,
    rental_discount_pct: rentalPct,
    flat_discount: flat,
    promo,
    promo_pct: promoPct,
    promo_bonus_punches: bonus,
    promo_overridden: !!promoPct && discountId !== '',
  };
}

/**
 * The human-readable trail stored in `checkins.addons`: what was bought on top
 * of the base product, and every rule that moved the price. Built here rather
 * than in the browser so a stored row always explains its own amount.
 */
export function describeCheckinExtras(addons: string[], price: PriceBreakdown): string {
  const parts = addons.filter(isKnownAddon);

  const manual = DISCOUNT_BY_ID.get(price.discount);
  if (manual) parts.push(`Discount: ${manual.label}`);

  if (price.discount === 'referral' && price.rental_discount_pct && price.rental_addons) {
    // The referral columns on the row carry only the base-price %, so the cut on
    // gear rental would otherwise leave no trace.
    parts.push(`Rental discount: ${price.rental_discount_pct}%`);
  }

  if (price.promo) {
    const notes: string[] = [];
    // A displaced promo did not touch this price, so it is not claimed here.
    if (price.promo_pct && !price.promo_overridden) notes.push(`${price.promo_pct}% off`);
    if (price.promo_bonus_punches) notes.push(`+${price.promo_bonus_punches} bonus punches`);
    if (notes.length) parts.push(`Promo: ${price.promo.label} – ${notes.join(', ')}`);
  }

  return parts.join(', ');
}
