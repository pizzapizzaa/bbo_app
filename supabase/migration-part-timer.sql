-- ══════════════════════════════════════════════════════════════════════════════
-- Part-timer accounts — row ownership for check-ins and schedule entries
-- ══════════════════════════════════════════════════════════════════════════════
--
-- Run this once in the Supabase SQL editor (Project → SQL Editor → New query).
-- Safe to re-run: every statement is guarded.
--
-- WHY
-- ---
-- Part-timers may add check-ins and shifts, and may fix mistakes — but must not
-- rewrite a week already counted. `created_by` records the username that
-- inserted the row, which is one of the two ways the API grants an edit:
--
--   1. the row is yours — `created_by` matches the caller, any date; or
--   2. it is a check-in from today — whoever logged it. Whoever is on the desk
--      fixes the day's mistakes, because the colleague who typed the wrong name
--      has usually gone home. See `sameDayDateColumn` in src/lib/ownership.ts.
--
-- Rule 2 covers check-ins only. A shift is not a till entry, so who may claim or
-- drop one is decided by /api/schedule/:id/claim instead.
--
-- BEFORE YOU RUN IT
-- -----------------
-- The app works without this migration: part-timers can still add check-ins and
-- shifts (the insert silently drops the column when it is absent), and rule 2
-- needs no column, so today's check-ins stay editable at the desk. What they
-- cannot do until you run it is touch their *own* older entries — ownership
-- cannot be proven, so for past days those stay admin-only.
--
-- AFTER YOU RUN IT
-- ----------------
-- Rows that already existed keep created_by = NULL. They are unowned, so once
-- their date has passed they are admin-only. Only rows added from here on are
-- attributable to a part-timer.

ALTER TABLE checkins
  ADD COLUMN IF NOT EXISTS created_by TEXT;

ALTER TABLE schedule_entries
  ADD COLUMN IF NOT EXISTS created_by TEXT;

COMMENT ON COLUMN checkins.created_by IS
  'Username that logged this check-in. NULL = pre-migration row; modifiable by a part-timer only while it is still today''s.';

COMMENT ON COLUMN schedule_entries.created_by IS
  'Username that added this shift. NULL = pre-migration row (admin-only to modify).';

-- Ownership lookups run on every part-timer edit/delete, always by primary key
-- plus this column, so a plain index on it keeps that check cheap as the
-- check-in table grows.
CREATE INDEX IF NOT EXISTS idx_checkins_created_by         ON checkins(created_by);
CREATE INDEX IF NOT EXISTS idx_schedule_entries_created_by ON schedule_entries(created_by);

-- ── Note on the part-timer account itself ────────────────────────────────────
-- The part-timer login is NOT a staff_users row. It is configured with the
-- PARTTIMER_USERNAME / PARTTIMER_PASSWORD environment variables instead.
--
-- That is deliberate: /api/auth/token only falls back to the env-var admin when
-- staff_users holds no active rows, so seeding a part-timer here would flip the
-- table to non-empty and lock the env-var admin out of the system.
