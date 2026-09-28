import { describe, it, expect } from 'vitest';
import {
  financePeriod, unionMinutes, projectFixedCosts, PART_TIMER_RATES,
  SHINGO_PT_CHECKIN_TYPE, SHINGO_PT_CARD_PRICE,
} from '../lib/fixed-costs';
import { PART_TIMER_NAMES } from '../lib/staff';
import { isKnownCheckinType } from '../lib/pricing';

const SEP = financePeriod('2026-09')!;
const line = (p: ReturnType<typeof projectFixedCosts>, label: string) =>
  p.lines.find(l => l.label === label)!;

describe('financePeriod', () => {
  it('runs from the 29th of the previous month to the 28th', () => {
    expect(SEP).toEqual({ month: '2026-09', start: '2026-08-29', end: '2026-09-28' });
    expect(financePeriod('2026-01')).toMatchObject({ start: '2025-12-29', end: '2026-01-28' });
  });

  it('starts March on the 1st when February has no 29th', () => {
    expect(financePeriod('2026-03')).toMatchObject({ start: '2026-03-01', end: '2026-03-28' });
    expect(financePeriod('2028-03')).toMatchObject({ start: '2028-02-29' });
  });

  it('rejects malformed months', () => {
    expect(financePeriod('2026-13')).toBeNull();
    expect(financePeriod('2026-9')).toBeNull();
    expect(financePeriod('')).toBeNull();
  });
});

describe('unionMinutes', () => {
  const s = (date: string, start_time: string, end_time: string) =>
    ({ staff_name: 'Kim An', date, start_time, end_time });

  it('counts overlapping shifts once', () => {
    expect(unionMinutes([s('2026-09-01', '15:00', '19:00'), s('2026-09-01', '18:00', '22:00')])).toBe(7 * 60);
  });

  it('handles shifts that cross midnight', () => {
    expect(unionMinutes([s('2026-09-01', '22:00', '02:00')])).toBe(4 * 60);
  });
});

describe('projectFixedCosts', () => {
  const base = { period: SEP, shifts: [], checkins: [], expenses: [] };

  it('only pays part-timers who are on the roster', () => {
    for (const name of Object.keys(PART_TIMER_RATES)) {
      expect(PART_TIMER_NAMES as readonly string[]).toContain(name);
    }
  });

  it('keys the Shingo share off a real product name', () => {
    expect(isKnownCheckinType(SHINGO_PT_CHECKIN_TYPE)).toBe(true);
  });

  it('pays part-timers their rostered hours at their own rate', () => {
    const p = projectFixedCosts({
      ...base,
      shifts: [
        { staff_name: 'Le Nghia', date: '2026-09-01', start_time: '09:00', end_time: '13:30' },
        { staff_name: 'Kim An',   date: '2026-09-02', start_time: '10:00', end_time: '12:00' },
        { staff_name: 'Danny',    date: '2026-09-02', start_time: '10:00', end_time: '12:00' },
      ],
    });
    expect(line(p, 'Le Nghia').amount).toBe(180_000);   // 4.5h × 40,000
    expect(line(p, 'Kim An').amount).toBe(70_000);      // 2h × 35,000
    expect(line(p, 'Danny').amount).toBe(70_000);        // 2h × 35,000
  });

  it('adds a 35,000 meal allowance for each day worked over 5 hours', () => {
    const sh = (date: string, start_time: string, end_time: string) =>
      ({ staff_name: 'Bao Anh', date, start_time, end_time });
    const p = projectFixedCosts({
      ...base,
      shifts: [
        sh('2026-09-01', '09:00', '15:00'),   // one 6h shift            → meal
        sh('2026-09-02', '09:00', '12:00'),   // 3h + 3h the same day   → meal
        sh('2026-09-02', '14:00', '17:00'),
        sh('2026-09-03', '10:00', '15:00'),   // exactly 5h             → no meal
        sh('2026-09-04', '09:00', '13:00'),   // 4h + overlapping 12–15 = 6h → meal
        sh('2026-09-04', '12:00', '15:00'),
      ],
    });
    const l = line(p, 'Bao Anh');
    expect(l.meals).toBe(3);
    // 6 + 6 + 5 + 6 = 23h × 35,000 + 3 × 35,000
    expect(l.amount).toBe(23 * 35_000 + 3 * 35_000);
    expect(l.detail).toContain('3 meals × 35,000');
  });

  it('charges 4 setting days for Shingo and the guest setters', () => {
    const p = projectFixedCosts(base);
    expect(line(p, 'Shingo — route setting').amount).toBe(3_200_000);
    expect(line(p, 'Guest setters (2 / day)').amount).toBe(6_000_000);
  });

  it('gives Shingo 45% of the Shingo PT cards sold', () => {
    const p = projectFixedCosts({
      ...base,
      checkins: [
        { amount: 0, checkin_type: SHINGO_PT_CHECKIN_TYPE },
        { amount: 0, checkin_type: SHINGO_PT_CHECKIN_TYPE },
        { amount: 0, checkin_type: '10 PT Punches – Other PT' },
      ],
    });
    expect(line(p, 'Shingo — PT punch card share').amount).toBe(Math.round(2 * SHINGO_PT_CARD_PRICE * 0.45));
  });

  it('takes 45% of 3,000,000 per card, ignoring card-fee surcharges', () => {
    const p = projectFixedCosts({
      ...base,
      checkins: [
        { amount: 3_000_000, checkin_type: SHINGO_PT_CHECKIN_TYPE },
        { amount: 3_090_000, checkin_type: SHINGO_PT_CHECKIN_TYPE },  // 3% card fee
      ],
    });
    expect(line(p, 'Shingo — PT punch card share').amount).toBe(2_700_000);
  });

  it('gives Duyen Ha 5% of revenue minus logged expenses, never below zero', () => {
    const p = projectFixedCosts({
      ...base,
      checkins: [{ amount: 50_000_000 }, { amount: '10000000' }],
      expenses: [{ amount: 20_000_000 }],
    });
    expect(p.profit).toBe(40_000_000);
    expect(line(p, 'Duyen Ha — 5% of profit').amount).toBe(2_000_000);

    const loss = projectFixedCosts({ ...base, checkins: [{ amount: 1_000 }], expenses: [{ amount: 5_000 }] });
    expect(line(loss, 'Duyen Ha — 5% of profit').amount).toBe(0);
  });

  it('totals the month with utilities as a range', () => {
    const p = projectFixedCosts(base);
    // accountant 1M + Shingo setting 3.2M + guests 6M + Duyen 8M + director 7M + utilities 4–4.5M
    expect(p.total_min).toBe(29_200_000);
    expect(p.total_max).toBe(29_700_000);
  });
});
