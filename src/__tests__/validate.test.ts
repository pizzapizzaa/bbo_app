import { describe, it, expect } from 'vitest';
import {
  isValidUUID,
  isValidDate,
  isValidTime,
  isValidAmount,
  escapeLike,
  MAX_NAME,
  MAX_TEXT,
  MAX_AMOUNT,
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
});

// ── Constants ─────────────────────────────────────────────────────────────────
describe('validation constants', () => {
  it('MAX_NAME is 300', () => expect(MAX_NAME).toBe(300));
  it('MAX_TEXT is 1000', () => expect(MAX_TEXT).toBe(1000));
  it('MAX_AMOUNT is 100 billion VND', () => expect(MAX_AMOUNT).toBe(100_000_000_000));
});
