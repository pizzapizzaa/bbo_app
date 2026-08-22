import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import {
  PROMOTIONS, activePromotion, promoDiscountPct, promoBonusPunches,
  type Promotion,
} from '../lib/promotions';

const NATIONAL_DAY = PROMOTIONS.find(p => p.id === 'national-day-2026')!;

describe('activePromotion — window boundaries', () => {
  it('finds the National Day promo on its first day', () => {
    expect(activePromotion('2026-08-30')?.id).toBe('national-day-2026');
  });

  it('finds it on its last day — the window is inclusive at both ends', () => {
    expect(activePromotion('2026-09-03')?.id).toBe('national-day-2026');
  });

  it('finds it mid-window', () => {
    expect(activePromotion('2026-09-01')?.id).toBe('national-day-2026');
  });

  it('returns null the day before it opens', () => {
    expect(activePromotion('2026-08-29')).toBeNull();
  });

  it('returns null the day after it closes', () => {
    expect(activePromotion('2026-09-04')).toBeNull();
  });

  it('returns null for an empty date rather than throwing', () => {
    expect(activePromotion('')).toBeNull();
  });

  it('compares dates as strings, so a single-digit month still sorts correctly', () => {
    // '2026-09-04' > '2026-09-03' lexicographically; guard against a naive
    // comparison that would break across the Aug→Sep month boundary.
    expect(activePromotion('2026-08-31')?.id).toBe('national-day-2026');
    expect(activePromotion('2026-10-01')).toBeNull();
  });

  it('picks the first matching promotion when windows are supplied explicitly', () => {
    const promos: Promotion[] = [
      { id: 'a', label: 'A', starts_on: '2026-01-01', ends_on: '2026-01-31',
        base_discount_pct: {}, bonus_punches: {} },
      { id: 'b', label: 'B', starts_on: '2026-01-15', ends_on: '2026-02-15',
        base_discount_pct: {}, bonus_punches: {} },
    ];
    expect(activePromotion('2026-01-20', promos)?.id).toBe('a');
    expect(activePromotion('2026-02-01', promos)?.id).toBe('b');
  });
});

describe('promoDiscountPct — National Day base price cuts', () => {
  it.each([
    ['Day Pass – Adult',   10],
    ['Day Pass – Student', 10],
    ['Day Pass – Kid',     10],
  ])('takes 10%% off %s', (type, pct) => {
    expect(promoDiscountPct(NATIONAL_DAY, type)).toBe(pct);
  });

  it.each([
    'Membership – 1 Month',
    'Membership – 3 Months',
    'Membership – 6 Months',
    'Membership – 12 Months',
  ])('takes 5%% off %s', (type) => {
    expect(promoDiscountPct(NATIONAL_DAY, type)).toBe(5);
  });

  it('leaves punch cards at full price — their promo is bonus punches', () => {
    expect(promoDiscountPct(NATIONAL_DAY, '10 Punches – Adult')).toBe(0);
    expect(promoDiscountPct(NATIONAL_DAY, '20 Punches – Adult')).toBe(0);
  });

  it('leaves PT punches untouched — not part of the offer', () => {
    expect(promoDiscountPct(NATIONAL_DAY, '10 PT Punches – Shingo PT')).toBe(0);
    expect(promoBonusPunches(NATIONAL_DAY, '10 PT Punches – Other PT')).toBe(0);
  });

  it('returns 0 for a null promo or an empty type', () => {
    expect(promoDiscountPct(null, 'Day Pass – Adult')).toBe(0);
    expect(promoDiscountPct(NATIONAL_DAY, '')).toBe(0);
  });
});

describe('promoBonusPunches — National Day card top-ups', () => {
  it.each([
    '10 Punches – Adult',
    '10 Punches – Student',
    '10 Punches – Kid',
  ])('adds 2 punches to %s, making it a 12-punch card', (type) => {
    expect(promoBonusPunches(NATIONAL_DAY, type)).toBe(2);
  });

  it('adds 5 punches to 20 Punches – Adult, making it a 25-punch card', () => {
    expect(promoBonusPunches(NATIONAL_DAY, '20 Punches – Adult')).toBe(5);
  });

  it('returns 0 for day passes and memberships', () => {
    expect(promoBonusPunches(NATIONAL_DAY, 'Day Pass – Adult')).toBe(0);
    expect(promoBonusPunches(NATIONAL_DAY, 'Membership – 12 Months')).toBe(0);
  });

  it('returns 0 for a null promo or an empty type', () => {
    expect(promoBonusPunches(null, '10 Punches – Adult')).toBe(0);
    expect(promoBonusPunches(NATIONAL_DAY, '')).toBe(0);
  });
});

describe('promotion keys stay in step with the check-in form', () => {
  // The keys are matched by exact string against the form's <option value>,
  // en dash and all. A renamed product would otherwise un-apply the promo
  // silently at the counter, so fail the suite instead.
  const form = readFileSync(
    new URL('../pages/pos/checkin.astro', import.meta.url), 'utf8',
  );
  const optionValues = new Set(
    [...form.matchAll(/<option value="([^"]+)" data-price/g)].map(m => m[1]),
  );

  it('finds the form options to compare against', () => {
    expect(optionValues.size).toBeGreaterThan(10);
  });

  for (const promo of PROMOTIONS) {
    const keys = [
      ...Object.keys(promo.base_discount_pct),
      ...Object.keys(promo.bonus_punches),
    ];
    it.each(keys)(`${promo.id}: "%s" is a real check-in type`, (key) => {
      expect(optionValues.has(key)).toBe(true);
    });
  }
});
