import { describe, it, expect } from 'vitest';
import {
  isValidUUID,
  isValidDate,
  isValidTime,
  isValidAmount,
  escapeLike,
  namesMatch,
  normalizeReferralCode,
  isValidReferralCode,
  isValidReferralPct,
  isValidRentalPct,
  referralCodesMatch,
  normalizeCodeLabel,
  MAX_NAME,
  MAX_TEXT,
  MAX_AMOUNT,
  MAX_CODE_LABEL,
} from '../lib/validate';

// ── isValidUUID ───────────────────────────────────────────────────────────────
describe('isValidUUID', () => {
  it('accepts a standard v4 UUID', () =>
    expect(isValidUUID('123e4567-e89b-12d3-a456-426614174000')).toBe(true));

  it('accepts uppercase UUID', () =>
    expect(isValidUUID('123E4567-E89B-12D3-A456-426614174000')).toBe(true));

  it('rejects empty string', () =>
    expect(isValidUUID('')).toBe(false));

  it('rejects UUID missing a segment', () =>
    expect(isValidUUID('123e4567-e89b-12d3-a456')).toBe(false));

  it('rejects UUID with a short segment', () =>
    expect(isValidUUID('123e4567-e89b-12d3-a456-42661417400')).toBe(false));

  it('rejects UUID with an invalid character', () =>
    expect(isValidUUID('123e4567-e89b-12d3-a456-42661417400g')).toBe(false));

  it('rejects plain string', () =>
    expect(isValidUUID('not-a-uuid')).toBe(false));
});

// ── isValidDate ───────────────────────────────────────────────────────────────
describe('isValidDate', () => {
  it('accepts YYYY-MM-DD format', () =>
    expect(isValidDate('2026-06-15')).toBe(true));

  it('accepts first day of year', () =>
    expect(isValidDate('2026-01-01')).toBe(true));

  it('accepts leap-year February 29', () =>
    expect(isValidDate('2024-02-29')).toBe(true));

  it('rejects non-leap-year February 29', () =>
    expect(isValidDate('2025-02-29')).toBe(false));

  it('rejects DD/MM/YYYY format', () =>
    expect(isValidDate('15/06/2026')).toBe(false));

  it('rejects month 13', () =>
    expect(isValidDate('2026-13-01')).toBe(false));

  it('rejects day 0', () =>
    expect(isValidDate('2026-06-00')).toBe(false));

  it('rejects date with time component', () =>
    expect(isValidDate('2026-06-15T10:00')).toBe(false));

  it('rejects empty string', () =>
    expect(isValidDate('')).toBe(false));
});

// ── isValidTime ───────────────────────────────────────────────────────────────
describe('isValidTime', () => {
  it('accepts HH:MM format', () =>
    expect(isValidTime('10:30')).toBe(true));

  it('accepts midnight 00:00', () =>
    expect(isValidTime('00:00')).toBe(true));

  it('accepts end of day 23:59', () =>
    expect(isValidTime('23:59')).toBe(true));

  it('rejects single-digit hour H:MM', () =>
    expect(isValidTime('9:30')).toBe(false));

  it('rejects HH:MM:SS format', () =>
    expect(isValidTime('10:30:00')).toBe(false));

  it('rejects empty string', () =>
    expect(isValidTime('')).toBe(false));

  it('rejects non-numeric characters', () =>
    expect(isValidTime('ab:cd')).toBe(false));
});

// ── isValidAmount ─────────────────────────────────────────────────────────────
describe('isValidAmount', () => {
  it('accepts zero', () =>
    expect(isValidAmount(0)).toBe(true));

  it('accepts a typical VND amount', () =>
    expect(isValidAmount(50_000)).toBe(true));

  it('accepts MAX_AMOUNT exactly', () =>
    expect(isValidAmount(MAX_AMOUNT)).toBe(true));

  it('rejects negative amounts', () =>
    expect(isValidAmount(-1)).toBe(false));

  it('rejects amount exceeding MAX_AMOUNT', () =>
    expect(isValidAmount(MAX_AMOUNT + 1)).toBe(false));

  it('rejects NaN', () =>
    expect(isValidAmount(NaN)).toBe(false));

  it('rejects Infinity', () =>
    expect(isValidAmount(Infinity)).toBe(false));

  it('rejects negative Infinity', () =>
    expect(isValidAmount(-Infinity)).toBe(false));
});

// ── escapeLike ────────────────────────────────────────────────────────────────
describe('escapeLike', () => {
  it('escapes % wildcard', () =>
    expect(escapeLike('100%')).toBe('100\\%'));

  it('escapes _ wildcard', () =>
    expect(escapeLike('foo_bar')).toBe('foo\\_bar'));

  it('escapes both wildcards in the same string', () =>
    expect(escapeLike('50% off_sale')).toBe('50\\% off\\_sale'));

  it('leaves a plain name unchanged', () =>
    expect(escapeLike('Alice Nguyen')).toBe('Alice Nguyen'));

  it('handles multiple % characters', () =>
    expect(escapeLike('%%')).toBe('\\%\\%'));

  it('returns empty string unchanged', () =>
    expect(escapeLike('')).toBe(''));

  // PostgREST substitutes * for % in like/ilike patterns, so a bare asterisk
  // is a wildcard just like a percent sign.
  it('escapes the PostgREST * wildcard alias', () =>
    expect(escapeLike('*')).toBe('\\*'));

  it('escapes * embedded in a name', () =>
    expect(escapeLike('Bob*son')).toBe('Bob\\*son'));

  // The backslash must be escaped first, or "\%" would come out as "\\%":
  // a literal backslash followed by a still-live wildcard.
  it('escapes a lone backslash', () =>
    expect(escapeLike('a\\b')).toBe('a\\\\b'));

  it('does not leave a live wildcard when input mixes a backslash and a %', () =>
    expect(escapeLike('\\%')).toBe('\\\\\\%'));

  it('escapes every wildcard class in one string', () =>
    expect(escapeLike('a%b_c*d\\e')).toBe('a\\%b\\_c\\*d\\\\e'));
});

// ── namesMatch ────────────────────────────────────────────────────────────────
describe('namesMatch', () => {
  it('matches identical names', () =>
    expect(namesMatch('Alice Nguyen', 'Alice Nguyen')).toBe(true));

  it('ignores case', () =>
    expect(namesMatch('ALICE NGUYEN', 'alice nguyen')).toBe(true));

  it('ignores surrounding whitespace', () =>
    expect(namesMatch('  Alice Nguyen  ', 'Alice Nguyen')).toBe(true));

  it('rejects a different name', () =>
    expect(namesMatch('Alice Nguyen', 'Bob Tran')).toBe(false));

  // The point of the helper: a wildcard that matched a row must not be
  // accepted as that row's name.
  it('rejects a wildcard pattern against the name it matched', () =>
    expect(namesMatch('Alice Nguyen', '*')).toBe(false));

  it('rejects a prefix of the stored name', () =>
    expect(namesMatch('Alice Nguyen', 'Alice')).toBe(false));

  it('rejects null or undefined on either side', () => {
    expect(namesMatch(null, 'Alice')).toBe(false);
    expect(namesMatch('Alice', undefined)).toBe(false);
    expect(namesMatch(null, null)).toBe(false);
  });

  it('rejects a non-string value', () =>
    expect(namesMatch(123 as any, '123')).toBe(false));
});

// ── Referral codes ────────────────────────────────────────────────────────────
describe('normalizeReferralCode', () => {
  it('trims and uppercases', () =>
    expect(normalizeReferralCode('  baotran-4f2k ')).toBe('BAOTRAN-4F2K'));

  it('returns empty string for empty input', () =>
    expect(normalizeReferralCode('')).toBe(''));

  it('treats null/undefined as empty', () =>
    expect(normalizeReferralCode(undefined as any)).toBe(''));
});

describe('isValidReferralCode', () => {
  it('accepts letters, digits and dashes', () =>
    expect(isValidReferralCode('BAOTRAN-4F2K')).toBe(true));

  it('accepts the 3-character minimum', () =>
    expect(isValidReferralCode('BBO')).toBe(true));

  it('accepts the 20-character maximum', () =>
    expect(isValidReferralCode('A'.repeat(20))).toBe(true));

  it('rejects 2 characters', () =>
    expect(isValidReferralCode('AB')).toBe(false));

  it('rejects 21 characters', () =>
    expect(isValidReferralCode('A'.repeat(21))).toBe(false));

  it('rejects lowercase (callers must normalize first)', () =>
    expect(isValidReferralCode('baotran')).toBe(false));

  it('rejects a leading dash', () =>
    expect(isValidReferralCode('-ABC')).toBe(false));

  it('rejects spaces', () =>
    expect(isValidReferralCode('BAO TRAN')).toBe(false));

  it('rejects SQL wildcard characters', () =>
    expect(isValidReferralCode('BAO%_')).toBe(false));

  it('rejects an empty string', () =>
    expect(isValidReferralCode('')).toBe(false));
});

describe('referralCodesMatch', () => {
  it('matches identical codes', () =>
    expect(referralCodesMatch('BAOTRAN-4F2K', 'BAOTRAN-4F2K')).toBe(true));

  it('ignores case and surrounding whitespace', () =>
    expect(referralCodesMatch('  baotran-4f2k ', 'BAOTRAN-4F2K')).toBe(true));

  it('rejects a different code', () =>
    expect(referralCodesMatch('BAOTRAN-4F2K', 'ALICE-9XYZ')).toBe(false));

  // The point of the helper: a wildcard that matched a row must not be
  // accepted as that row's code.
  it('rejects a wildcard pattern against the code it matched', () =>
    expect(referralCodesMatch('BAOTRAN-4F2K', '*')).toBe(false));

  it('rejects a prefix of the stored code', () =>
    expect(referralCodesMatch('BAOTRAN-4F2K', 'BAOTRAN')).toBe(false));

  it('rejects a code against a customer with none stored', () =>
    expect(referralCodesMatch('', 'BAOTRAN-4F2K')).toBe(false));

  it('rejects null or undefined on either side', () => {
    expect(referralCodesMatch(null, 'BBO')).toBe(false);
    expect(referralCodesMatch('BBO', undefined)).toBe(false);
  });
});

describe('isValidRentalPct', () => {
  it('accepts 0 — rentals charged in full', () => expect(isValidRentalPct(0)).toBe(true));
  it('accepts 50', ()   => expect(isValidRentalPct(50)).toBe(true));
  it('accepts 100', ()  => expect(isValidRentalPct(100)).toBe(true));
  it('rejects 101', ()  => expect(isValidRentalPct(101)).toBe(false));
  it('rejects negatives', () => expect(isValidRentalPct(-1)).toBe(false));
  it('rejects fractions', () => expect(isValidRentalPct(12.5)).toBe(false));
  it('rejects NaN', ()       => expect(isValidRentalPct(NaN)).toBe(false));
});

describe('normalizeCodeLabel', () => {
  it('trims surrounding whitespace', () =>
    expect(normalizeCodeLabel('  Summer 2026  ')).toBe('Summer 2026'));

  it('collapses runs of whitespace', () =>
    expect(normalizeCodeLabel('Summer\n\t  2026')).toBe('Summer 2026'));

  it('truncates to MAX_CODE_LABEL', () =>
    expect(normalizeCodeLabel('x'.repeat(MAX_CODE_LABEL + 40))).toHaveLength(MAX_CODE_LABEL));

  it('returns empty string for empty input', () =>
    expect(normalizeCodeLabel('')).toBe(''));

  it('returns empty string for undefined', () =>
    expect(normalizeCodeLabel(undefined as any)).toBe(''));
});

describe('isValidReferralPct', () => {
  it('accepts 1', ()   => expect(isValidReferralPct(1)).toBe(true));
  it('accepts 100', () => expect(isValidReferralPct(100)).toBe(true));
  it('rejects 0', ()   => expect(isValidReferralPct(0)).toBe(false));
  it('rejects 101', () => expect(isValidReferralPct(101)).toBe(false));
  it('rejects negatives', ()   => expect(isValidReferralPct(-10)).toBe(false));
  it('rejects fractions', ()   => expect(isValidReferralPct(12.5)).toBe(false));
  it('rejects NaN', ()         => expect(isValidReferralPct(NaN)).toBe(false));
});

// ── Constants ─────────────────────────────────────────────────────────────────
describe('validation constants', () => {
  it('MAX_NAME is 300', () => expect(MAX_NAME).toBe(300));
  it('MAX_TEXT is 1000', () => expect(MAX_TEXT).toBe(1000));
  it('MAX_AMOUNT is 100 billion VND', () => expect(MAX_AMOUNT).toBe(100_000_000_000));
});
