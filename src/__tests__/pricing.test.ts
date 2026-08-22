import { describe, it, expect } from 'vitest';
import {
  CHECKIN_TYPES, ADDONS, MANUAL_DISCOUNTS,
  checkinTypePrice, isKnownCheckinType, isKnownAddon, isKnownDiscount,
  computeCheckinAmount, describeCheckinExtras,
} from '../lib/pricing';

/** A day outside every promotion window, so the base rules show through. */
const ORDINARY = '2026-06-15';
/** Inside the National Day window (2026-08-30 → 2026-09-03). */
const PROMO_DAY = '2026-09-01';

describe('the price list', () => {
  it('prices every product it lists, and nothing it does not', () => {
    expect(checkinTypePrice('Day Pass – Adult')).toBe(160_000);
    expect(checkinTypePrice('Membership – 12 Months')).toBe(9_850_000);
    expect(checkinTypePrice('Not A Product')).toBe(0);
  });

  it('names PT punch cards but charges nothing — they settle with the trainer', () => {
    expect(isKnownCheckinType('10 PT Punches – Shingo PT')).toBe(true);
    expect(checkinTypePrice('10 PT Punches – Shingo PT')).toBe(0);
  });

  it('recognises its own products, add-ons and discounts', () => {
    expect(isKnownCheckinType('Day Pass – Kid')).toBe(true);
    expect(isKnownCheckinType('Day Pass - Kid')).toBe(false);  // hyphen, not en dash
    expect(isKnownAddon('Shoes Rental')).toBe(true);
    expect(isKnownAddon('Free Beer')).toBe(false);
    expect(isKnownDiscount('')).toBe(true);
    expect(isKnownDiscount('referral')).toBe(true);
    expect(isKnownDiscount('day30')).toBe(true);
    expect(isKnownDiscount('day90')).toBe(false);
  });

  it('splits add-ons into gear rental and retail stock', () => {
    const rentals = ADDONS.filter(a => a.rental).map(a => a.name);
    expect(rentals).toEqual(['Liquid Chalk Rental', 'Shoes Rental', 'Chalk Bag Rental']);
  });

  it('holds whole-VND prices throughout — no fractional dong', () => {
    for (const t of CHECKIN_TYPES) expect(Number.isInteger(t.price)).toBe(true);
    for (const a of ADDONS)        expect(Number.isInteger(a.price)).toBe(true);
  });
});

describe('computeCheckinAmount — no discount', () => {
  it('charges the list price for a plain day pass', () => {
    const p = computeCheckinAmount({ date: ORDINARY, checkin_type: 'Day Pass – Adult' });
    expect(p.amount).toBe(160_000);
    expect(p.base_discount_pct).toBe(0);
  });

  it('adds add-ons at full price', () => {
    const p = computeCheckinAmount({
      date: ORDINARY,
      checkin_type: 'Day Pass – Adult',
      addons: ['Shoes Rental', 'Pocari'],
    });
    expect(p.amount).toBe(160_000 + 20_000 + 18_000);
    expect(p.rental_addons).toBe(20_000);
    expect(p.retail_addons).toBe(18_000);
  });

  it('costs nothing when nothing was bought — a punch-card visit', () => {
    expect(computeCheckinAmount({ date: ORDINARY }).amount).toBe(0);
  });

  it('ignores an add-on that is not on the price list rather than guessing', () => {
    const p = computeCheckinAmount({
      date: ORDINARY, checkin_type: 'Day Pass – Adult', addons: ['Free Beer'],
    });
    expect(p.amount).toBe(160_000);
  });

  it('prices an unknown product at zero rather than inventing a figure', () => {
    expect(computeCheckinAmount({ date: ORDINARY, checkin_type: 'Season Ticket' }).amount).toBe(0);
  });
});

describe('computeCheckinAmount — hand-picked discounts', () => {
  it.each([
    ['day30',      30, 112_000],
    ['day40',      40,  96_000],
    ['lasthour50', 50,  80_000],
  ])('%s takes %i%% off the base price', (discount, pct, expected) => {
    const p = computeCheckinAmount({ date: ORDINARY, checkin_type: 'Day Pass – Adult', discount });
    expect(p.amount).toBe(expected);
    expect(p.base_discount_pct).toBe(pct);
  });

  it('leaves add-ons at full price under a percentage discount', () => {
    const p = computeCheckinAmount({
      date: ORDINARY, checkin_type: 'Day Pass – Adult', discount: 'day30',
      addons: ['Shoes Rental', 'Socks'],
    });
    expect(p.amount).toBe(112_000 + 20_000 + 10_000);
  });

  it('takes the birthday discount off the whole bill, add-ons included', () => {
    const p = computeCheckinAmount({
      date: ORDINARY, checkin_type: 'Day Pass – Adult', discount: 'birthday',
      addons: ['Shoes Rental'],
    });
    expect(p.amount).toBe(160_000 + 20_000 - 20_000);
    expect(p.flat_discount).toBe(20_000);
  });

  it('never lets the birthday discount push a small bill below zero', () => {
    const p = computeCheckinAmount({ date: ORDINARY, addons: ['Socks'], discount: 'birthday' });
    expect(p.amount).toBe(0);
  });
});

describe('computeCheckinAmount — referral and promo codes', () => {
  const CODE = { discount_pct: 10, rental_discount_pct: 50 };

  it('takes the code’s percentage off the base price', () => {
    const p = computeCheckinAmount({
      date: ORDINARY, checkin_type: 'Day Pass – Adult', discount: 'referral', referral: CODE,
    });
    expect(p.amount).toBe(144_000);
  });

  it('cuts gear rental by the code’s rental percentage but never retail stock', () => {
    const p = computeCheckinAmount({
      date: ORDINARY, checkin_type: 'Day Pass – Adult', discount: 'referral', referral: CODE,
      addons: ['Shoes Rental', 'Chalk Bag Rental', 'Pocari'],
    });
    //     base 144,000 + rental (20,000 + 15,000) halved + Pocari at full price
    expect(p.amount).toBe(144_000 + 17_500 + 18_000);
    expect(p.rental_discount_pct).toBe(50);
  });

  it('leaves rentals at full price for a code that gives no rental cut', () => {
    const p = computeCheckinAmount({
      date: ORDINARY, checkin_type: 'Day Pass – Adult', discount: 'referral',
      referral: { discount_pct: 10, rental_discount_pct: 0 },
      addons: ['Shoes Rental'],
    });
    expect(p.amount).toBe(144_000 + 20_000);
  });

  it('discounts nothing when the code never resolved — an unverified code is not a discount', () => {
    const p = computeCheckinAmount({
      date: ORDINARY, checkin_type: 'Day Pass – Adult', discount: 'referral', referral: null,
    });
    expect(p.amount).toBe(160_000);
  });
});

describe('computeCheckinAmount — automatic promotions', () => {
  it('applies the National Day cut on its own when no discount is picked', () => {
    const p = computeCheckinAmount({ date: PROMO_DAY, checkin_type: 'Day Pass – Adult' });
    expect(p.amount).toBe(144_000);         // 10% off
    expect(p.promo?.id).toBe('national-day-2026');
    expect(p.promo_overridden).toBe(false);
  });

  it('cuts memberships by their own 5%, not the day-pass 10%', () => {
    const p = computeCheckinAmount({ date: PROMO_DAY, checkin_type: 'Membership – 1 Month' });
    expect(p.amount).toBe(1_187_500);
  });

  it('charges the list price outside the window', () => {
    expect(
      computeCheckinAmount({ date: '2026-08-29', checkin_type: 'Day Pass – Adult' }).amount,
    ).toBe(160_000);
  });

  it('lets a hand-picked discount replace the promo rather than stack on it', () => {
    const p = computeCheckinAmount({
      date: PROMO_DAY, checkin_type: 'Day Pass – Adult', discount: 'day30',
    });
    expect(p.amount).toBe(112_000);         // 30%, not 30% + 10%
    expect(p.base_discount_pct).toBe(30);
    expect(p.promo_pct).toBe(10);
    expect(p.promo_overridden).toBe(true);
  });

  it('reports a promo the picked discount displaced, even when that costs more', () => {
    // A 5% membership promo beats no discount but loses to a 30% radio — and a
    // code worth less than the promo is exactly the case staff need warning about.
    const p = computeCheckinAmount({
      date: PROMO_DAY, checkin_type: 'Membership – 1 Month', discount: 'referral',
      referral: { discount_pct: 1, rental_discount_pct: 0 },
    });
    expect(p.amount).toBeGreaterThan(1_187_500);
    expect(p.promo_overridden).toBe(true);
  });

  it('leaves punch cards at list price and reports their bonus punches instead', () => {
    const p = computeCheckinAmount({ date: PROMO_DAY, checkin_type: '10 Punches – Adult' });
    expect(p.amount).toBe(1_400_000);
    expect(p.promo_bonus_punches).toBe(2);
  });

  it('still reports bonus punches when a discount displaced the price cut', () => {
    // Bonus punches are what the card contains, not a cut off its price, so no
    // discount choice can displace them.
    const p = computeCheckinAmount({
      date: PROMO_DAY, checkin_type: '20 Punches – Adult', discount: 'day30',
    });
    expect(p.promo_bonus_punches).toBe(5);
  });
});

describe('computeCheckinAmount — arithmetic', () => {
  it('returns whole dong for every product under every fixed discount', () => {
    for (const t of CHECKIN_TYPES) {
      for (const d of ['', ...MANUAL_DISCOUNTS.map(m => m.id)]) {
        const p = computeCheckinAmount({ date: ORDINARY, checkin_type: t.value, discount: d });
        expect(Number.isInteger(p.amount)).toBe(true);
      }
    }
  });

  it('never returns a negative amount', () => {
    const p = computeCheckinAmount({
      date: ORDINARY, checkin_type: 'Day Pass – Adult', discount: 'referral',
      referral: { discount_pct: 100, rental_discount_pct: 100 },
      addons: ['Shoes Rental'],
    });
    expect(p.amount).toBe(0);
  });
});

describe('describeCheckinExtras', () => {
  it('lists the add-ons bought', () => {
    const p = computeCheckinAmount({
      date: ORDINARY, checkin_type: 'Day Pass – Adult', addons: ['Shoes Rental', 'Pocari'],
    });
    expect(describeCheckinExtras(['Shoes Rental', 'Pocari'], p)).toBe('Shoes Rental, Pocari');
  });

  it('names the discount that moved the price', () => {
    const p = computeCheckinAmount({ date: ORDINARY, checkin_type: 'Day Pass – Adult', discount: 'day40' });
    expect(describeCheckinExtras([], p)).toContain('Discount: 40% discount');
  });

  it('records a rental cut, which no column on the row carries', () => {
    const p = computeCheckinAmount({
      date: ORDINARY, checkin_type: 'Day Pass – Adult', discount: 'referral',
      referral: { discount_pct: 10, rental_discount_pct: 50 }, addons: ['Shoes Rental'],
    });
    expect(describeCheckinExtras(['Shoes Rental'], p)).toContain('Rental discount: 50%');
  });

  it('does not mention a rental cut when nothing was rented', () => {
    const p = computeCheckinAmount({
      date: ORDINARY, checkin_type: 'Day Pass – Adult', discount: 'referral',
      referral: { discount_pct: 10, rental_discount_pct: 50 },
    });
    expect(describeCheckinExtras([], p)).not.toContain('Rental discount');
  });

  it('records a promo that applied', () => {
    const p = computeCheckinAmount({ date: PROMO_DAY, checkin_type: 'Day Pass – Adult' });
    expect(describeCheckinExtras([], p)).toBe('Promo: National Day Special – 10% off');
  });

  it('claims no price cut for a promo a discount displaced, but keeps the punches', () => {
    const p = computeCheckinAmount({
      date: PROMO_DAY, checkin_type: '10 Punches – Adult', discount: 'day30',
    });
    const trail = describeCheckinExtras([], p);
    expect(trail).toContain('+2 bonus punches');
    expect(trail).not.toContain('% off');
  });

  it('drops anything not on the price list rather than repeating it back', () => {
    const p = computeCheckinAmount({ date: ORDINARY, checkin_type: 'Day Pass – Adult' });
    expect(describeCheckinExtras(['Free Beer'], p)).toBe('');
  });
});
