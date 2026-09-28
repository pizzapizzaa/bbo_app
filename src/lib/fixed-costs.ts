/**
 * Projected fixed costs for one finance month.
 *
 * A finance month closes on the 28th: "September" runs Aug 29 → Sep 28, the
 * same window the Expenses page stats and the Schedule page part-timer panel
 * use. Every figure here is whole VND.
 *
 * The projection is kept apart from the logged `expenses` table on purpose —
 * it is what the month is expected to cost, not what has been paid, so it is
 * never added to the Balance figures. The one place the two meet is Duyen Ha's
 * profit share, which is 5% of (revenue − logged expenses) for the month.
 */

/** Hourly rate per part-timer. Names must match PART_TIMER_NAMES exactly. */
export const PART_TIMER_RATES: Record<string, number> = {
  'Bao Anh':   35_000,
  'Danny':     35_000,
  'Minh Chau': 35_000,
  'Kim An':    35_000,
  'Bich Van':  35_000,   // Van Nguyen
  'Le Nghia':  40_000,
  'Thuy Vy':   40_000,
};

/**
 * A part-timer on the floor for more than 5 hours in a day — one shift or
 * several, overlaps counted once — gets a meal allowance for that day.
 */
export const MEAL_ALLOWANCE   = 35_000;
export const MEAL_MIN_MINUTES = 5 * 60;

export const ACCOUNTANT_MONTHLY = 1_000_000;

export const SHINGO_PT_CHECKIN_TYPE = '10 PT Punches – Shingo PT';
/**
 * What one Shingo PT punch card sells for. Counted per card sold rather than
 * summed from `amount`, which also carries card surcharges (3,090,000 with the
 * 3% card fee) that are not Shingo's to share. 0 = not set; the page flags it.
 */
export const SHINGO_PT_CARD_PRICE = 3_000_000;
export const SHINGO_PT_SHARE_PCT = 45;

export const SETTING_DAYS_PER_MONTH  = 4;
export const SHINGO_SETTING_DAY_FEE  = 800_000;
/** Budget for both guest setters together, per setting day. */
export const GUEST_SETTERS_PER_DAY   = 1_500_000;

export const FULL_TIME_BASE: Record<string, number> = { 'Duyen Ha': 8_000_000 };
export const FULL_TIME_PROFIT_PCT = 5;

export const DIRECTOR_MONTHLY = 7_000_000;
export const UTILITY_MIN = 4_000_000;
export const UTILITY_MAX = 4_500_000;

// ── Finance month ────────────────────────────────────────────────────────────

export interface FinancePeriod { month: string; start: string; end: string }

const pad = (n: number) => String(n).padStart(2, '0');
const iso = (d: Date) => `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;

/** `'2026-09'` → Aug 29 → Sep 28. Returns null for a malformed key. */
export function financePeriod(month: string): FinancePeriod | null {
  const m = /^(\d{4})-(\d{2})$/.exec(month);
  if (!m) return null;
  const y = +m[1], mo = +m[2] - 1;
  if (mo < 0 || mo > 11) return null;
  // The day after the previous month's 28th — Mar 1 in a non-leap March.
  const start = new Date(Date.UTC(y, mo - 1, 29));
  const end   = new Date(Date.UTC(y, mo, 28));
  return { month, start: iso(start), end: iso(end) };
}

// ── Hours ────────────────────────────────────────────────────────────────────

export interface Shift { staff_name: string; date: string; start_time: string; end_time: string }

function toMin(t: string): number {
  const [h, m] = String(t || '').split(':').map(Number);
  return (h || 0) * 60 + (m || 0);
}

function dayNum(date: string): number {
  const [y, m, d] = date.split('-').map(Number);
  return Date.UTC(y, m - 1, d) / 86_400_000;
}

/**
 * Minutes on the floor across one person's shifts, counting overlaps once —
 * the same rule as `unionMinutes` on the Schedule page, so payroll matches the
 * hours staff see there. An end at or before the start crosses midnight.
 */
export function unionMinutes(shifts: Shift[]): number {
  const iv = shifts.map(s => {
    const start = dayNum(s.date) * 1440 + toMin(s.start_time);
    let len = toMin(s.end_time) - toMin(s.start_time);
    if (len <= 0) len += 1440;
    return { start, end: start + len };
  }).sort((a, b) => a.start - b.start);

  let total = 0, curStart = -1, curEnd = -1;
  for (const s of iv) {
    if (curEnd < 0)            { curStart = s.start; curEnd = s.end; }
    else if (s.start > curEnd) { total += curEnd - curStart; curStart = s.start; curEnd = s.end; }
    else if (s.end > curEnd)   { curEnd = s.end; }
  }
  if (curEnd >= 0) total += curEnd - curStart;
  return total;
}

/**
 * Days on which one person's shifts add up to more than MEAL_MIN_MINUTES.
 * A day is the date a shift is booked on, so an overnight shift counts toward
 * the day it started.
 */
export function mealDays(shifts: Shift[]): number {
  const byDate = new Map<string, Shift[]>();
  for (const s of shifts) byDate.set(s.date, [...(byDate.get(s.date) ?? []), s]);
  let days = 0;
  for (const day of byDate.values()) if (unionMinutes(day) > MEAL_MIN_MINUTES) days++;
  return days;
}

// ── Projection ───────────────────────────────────────────────────────────────

export interface CostLine {
  group: string;
  label: string;
  /** How the figure was reached, e.g. "42h 30m × 35,000". */
  detail: string;
  amount: number;
  /** Set only for a cost quoted as a range; `amount` is then the low end. */
  amount_max?: number;
  /** Whose pay this is, when one person is paid on several lines; the page
   *  closes each such run with a per-person total. */
  person?: string;
  /** Minutes worked, on hourly-paid lines only. */
  minutes?: number;
  /** Meal-allowance days, on hourly-paid lines only. */
  meals?: number;
}

export interface ProjectionInput {
  period: FinancePeriod;
  /** Shifts dated inside the period. */
  shifts: Shift[];
  /** Check-ins dated inside the period. */
  checkins: { amount: number | string | null; checkin_type?: string | null }[];
  /** Logged expenses dated inside the period. */
  expenses: { amount: number | string | null }[];
}

export interface Projection {
  period: FinancePeriod;
  lines: CostLine[];
  total_min: number;
  total_max: number;
  revenue: number;
  logged_expenses: number;
  profit: number;
  shingo_card_price_set: boolean;
}

const fmt = (n: number) => n.toLocaleString('en-US');

function fmtHours(min: number): string {
  const h = Math.floor(min / 60), m = min % 60;
  return `${h}h${m ? ` ${m}m` : ''}`;
}

export function projectFixedCosts(input: ProjectionInput): Projection {
  const { period, shifts, checkins, expenses } = input;
  const lines: CostLine[] = [];

  // Part-timers: hours actually rostered this finance month × their rate.
  for (const [name, rate] of Object.entries(PART_TIMER_RATES)) {
    const own   = shifts.filter(s => s.staff_name === name);
    const min   = unionMinutes(own);
    const meals = mealDays(own);
    lines.push({
      group: 'Part-timers',
      label: name,
      detail: `${fmtHours(min)} × ${fmt(rate)}/h` +
        (meals ? ` + ${meals} meal${meals === 1 ? '' : 's'} × ${fmt(MEAL_ALLOWANCE)}` : ''),
      // Rate is per hour; bill the minutes, rounded to the dong.
      amount: Math.round(min * rate / 60) + meals * MEAL_ALLOWANCE,
      minutes: min,
      meals,
    });
  }

  lines.push({ group: 'Staff', label: 'Part-time accountant', detail: 'Monthly', amount: ACCOUNTANT_MONTHLY });

  const shingoCards = checkins.filter(c => c.checkin_type === SHINGO_PT_CHECKIN_TYPE).length;
  lines.push({
    group: 'Staff',
    label: 'Shingo — PT punch card share',
    person: 'Shingo',
    detail: SHINGO_PT_CARD_PRICE > 0
      ? `${shingoCards} card${shingoCards === 1 ? '' : 's'} × ${fmt(SHINGO_PT_CARD_PRICE)} × ${SHINGO_PT_SHARE_PCT}%`
      : `${shingoCards} card${shingoCards === 1 ? '' : 's'} sold — card price not set`,
    amount: Math.round(shingoCards * SHINGO_PT_CARD_PRICE * SHINGO_PT_SHARE_PCT / 100),
  });
  lines.push({
    group: 'Staff',
    label: 'Shingo — route setting',
    person: 'Shingo',
    detail: `${SETTING_DAYS_PER_MONTH} days × ${fmt(SHINGO_SETTING_DAY_FEE)}`,
    amount: SETTING_DAYS_PER_MONTH * SHINGO_SETTING_DAY_FEE,
  });
  lines.push({
    group: 'Staff',
    label: 'Guest setters (2 / day)',
    detail: `${SETTING_DAYS_PER_MONTH} days × ${fmt(GUEST_SETTERS_PER_DAY)}`,
    amount: SETTING_DAYS_PER_MONTH * GUEST_SETTERS_PER_DAY,
  });

  const revenue = checkins.reduce((a, c) => a + (Number(c.amount) || 0), 0);
  const logged  = expenses.reduce((a, e) => a + (Number(e.amount) || 0), 0);
  const profit  = revenue - logged;
  for (const [name, base] of Object.entries(FULL_TIME_BASE)) {
    lines.push({ group: 'Staff', label: `${name} — base salary`, person: name, detail: 'Monthly', amount: base });
    lines.push({
      group: 'Staff',
      label: `${name} — ${FULL_TIME_PROFIT_PCT}% of profit`,
      person: name,
      detail: profit > 0
        ? `${FULL_TIME_PROFIT_PCT}% × ${fmt(profit)} (revenue − logged expenses)`
        : 'No profit this month',
      amount: profit > 0 ? Math.round(profit * FULL_TIME_PROFIT_PCT / 100) : 0,
    });
  }

  lines.push({ group: 'Fixed', label: 'Director', detail: 'Monthly', amount: DIRECTOR_MONTHLY });
  lines.push({
    group: 'Fixed', label: 'Utilities', detail: 'Estimate',
    amount: UTILITY_MIN, amount_max: UTILITY_MAX,
  });

  const total_min = lines.reduce((a, l) => a + l.amount, 0);
  const total_max = lines.reduce((a, l) => a + (l.amount_max ?? l.amount), 0);

  return {
    period, lines, total_min, total_max,
    revenue, logged_expenses: logged, profit,
    shingo_card_price_set: SHINGO_PT_CARD_PRICE > 0,
  };
}
