-- ══════════════════════════════════════════════════════════════════════════════
-- BBO Gym POS — Database Schema
-- Run this once in the Supabase SQL Editor (Dashboard → SQL Editor → New Query)
-- ══════════════════════════════════════════════════════════════════════════════

-- ── Customers ───────────────────────────────────────────────────────────────
-- Holds the gym member database imported from CSV.
-- Columns mirror the standard BBO customer spreadsheet.
CREATE TABLE IF NOT EXISTS customers (
  id                    UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  full_name             TEXT        NOT NULL DEFAULT '',
  dob                   TEXT        NOT NULL DEFAULT '',   -- stored as text (various formats in CSV)
  email                 TEXT        NOT NULL DEFAULT '',
  telephone             TEXT        NOT NULL DEFAULT '',
  emergency_contact     TEXT        NOT NULL DEFAULT '',
  note                  TEXT        NOT NULL DEFAULT '',
  waiver_form           TEXT        NOT NULL DEFAULT '',
  is_punch_card_holder  BOOLEAN     NOT NULL DEFAULT false,
  punches_remaining     INTEGER     NOT NULL DEFAULT 0,
  membership_type       TEXT        NOT NULL DEFAULT '',   -- '' | '1 Month' | '3 Months' | '6 Months' | '12 Months'
  membership_start_date DATE,
  membership_end_date   DATE,
  pt_punches_remaining  INTEGER     NOT NULL DEFAULT 0,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_customers_full_name ON customers (full_name);
CREATE INDEX IF NOT EXISTS idx_customers_email     ON customers (email);

-- ── Staff Schedule ───────────────────────────────────────────────────────────
-- One row per shift assigned to a staff member.
CREATE TABLE IF NOT EXISTS schedule_entries (
  id          UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  staff_name  TEXT        NOT NULL,
  date        DATE        NOT NULL,
  start_time  TEXT        NOT NULL,  -- stored as HH:MM
  end_time    TEXT        NOT NULL,  -- stored as HH:MM
  notes       TEXT        NOT NULL DEFAULT '',
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_schedule_date       ON schedule_entries (date);
CREATE INDEX IF NOT EXISTS idx_schedule_staff_date ON schedule_entries (staff_name, date);

-- ── Daily Check-ins ──────────────────────────────────────────────────────────
-- One row per customer visit.
CREATE TABLE IF NOT EXISTS checkins (
  id                     UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_name          TEXT        NOT NULL,
  date                   DATE        NOT NULL,
  time                   TEXT        NOT NULL,  -- stored as HH:MM:SS
  checked_in_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  payment_method         TEXT        NOT NULL,  -- Cash | Card | Digital Wallet | Complimentary | Punch Card
  amount                 NUMERIC(12,0) NOT NULL DEFAULT 0,  -- VND, no decimals
  notes                  TEXT        NOT NULL DEFAULT '',
  punch_card_holder_id   UUID        REFERENCES customers(id) ON DELETE SET NULL,
  punch_card_holder_name TEXT        NOT NULL DEFAULT '',
  pt_punch_holder_id     UUID        REFERENCES customers(id) ON DELETE SET NULL,
  pt_punch_holder_name   TEXT        NOT NULL DEFAULT ''
);

CREATE INDEX IF NOT EXISTS idx_checkins_date ON checkins (date);

-- ── Expenses ────────────────────────────────────────────────────────────────────────────
-- One row per logged expense. Amounts are stored as positive integers (VND).
CREATE TABLE IF NOT EXISTS expenses (
  id          UUID            PRIMARY KEY DEFAULT gen_random_uuid(),
  date        DATE            NOT NULL,
  type        TEXT            NOT NULL,  -- Construction Setup | Construction Material | Holds | Marketing | Rent | Utility | Manpower Cost | Misc
  description TEXT            NOT NULL DEFAULT '',
  location    TEXT            NOT NULL DEFAULT '',
  amount      NUMERIC(15,0)   NOT NULL DEFAULT 0,  -- VND, stored positive, displayed as negative
  comment     TEXT            NOT NULL DEFAULT '',
  created_at  TIMESTAMPTZ     NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_expenses_date ON expenses (date);
CREATE INDEX IF NOT EXISTS idx_expenses_type ON expenses (type);

-- ══════════════════════════════════════════════════════════════════════════════
-- Row Level Security (RLS)
-- The service key (used only server-side in API routes) bypasses RLS.
-- Enabling RLS and denying the anon key means the database cannot be accessed
-- directly from the browser even if the anon key is discovered.
-- ══════════════════════════════════════════════════════════════════════════════
-- ── Events / Classes Schedule ─────────────────────────────────────────────
-- Public-facing schedule for classes and events.
-- event_type: 'beginner101' | 'pt_classes' | 'jp_classes' | 'other'
CREATE TABLE IF NOT EXISTS event_entries (
  id          UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  event_type  TEXT        NOT NULL,
  title       TEXT        NOT NULL DEFAULT '',
  date        DATE        NOT NULL,
  start_time  TEXT        NOT NULL,  -- stored as HH:MM
  end_time    TEXT        NOT NULL,  -- stored as HH:MM
  description TEXT        NOT NULL DEFAULT '',
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_event_entries_date      ON event_entries (date);
CREATE INDEX IF NOT EXISTS idx_event_entries_type_date ON event_entries (event_type, date);

-- ── Migration: PT Punch support ─────────────────────────────────────────────
-- Run these ALTER statements in Supabase SQL Editor if the tables already exist.
ALTER TABLE customers ADD COLUMN IF NOT EXISTS pt_punches_remaining INTEGER NOT NULL DEFAULT 0;
ALTER TABLE checkins  ADD COLUMN IF NOT EXISTS pt_punch_holder_id   UUID REFERENCES customers(id) ON DELETE SET NULL;
ALTER TABLE checkins  ADD COLUMN IF NOT EXISTS pt_punch_holder_name TEXT NOT NULL DEFAULT '';

ALTER TABLE customers        ENABLE ROW LEVEL SECURITY;
ALTER TABLE schedule_entries ENABLE ROW LEVEL SECURITY;
ALTER TABLE checkins         ENABLE ROW LEVEL SECURITY;
ALTER TABLE event_entries    ENABLE ROW LEVEL SECURITY;

-- Allow public (anon key) SELECT on event_entries so the public schedule page
-- can read events directly. Writes still require the service key (admin only).
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public'
      AND tablename  = 'event_entries'
      AND policyname = 'public can view events'
  ) THEN
    CREATE POLICY "public can view events"
      ON event_entries FOR SELECT USING (true);
  END IF;
END $$;

-- Deny all access via the anon/public key (service key bypasses RLS entirely)
-- No policies = no access for anon key. This is the correct secure default.

-- ══════════════════════════════════════════════════════════════════════════════
-- Punch Card Migration
-- Run these ALTER TABLE statements when upgrading an existing database.
-- They are safe to run even if the columns already exist (IF NOT EXISTS).
-- ══════════════════════════════════════════════════════════════════════════════
ALTER TABLE customers
  ADD COLUMN IF NOT EXISTS is_punch_card_holder BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS punches_remaining    INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS membership_type       TEXT    NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS membership_start_date DATE,
  ADD COLUMN IF NOT EXISTS membership_end_date   DATE;

-- ── Check-in Type & Add-ons Migration ────────────────────────────────────────
-- Already applied 2026-03-18. Kept for reference.
ALTER TABLE checkins
  ADD COLUMN IF NOT EXISTS checkin_type TEXT NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS addons       TEXT NOT NULL DEFAULT '';
