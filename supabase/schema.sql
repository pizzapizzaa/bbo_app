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
  punch_card_holder_name TEXT        NOT NULL DEFAULT ''
);

CREATE INDEX IF NOT EXISTS idx_checkins_date ON checkins (date);

-- ══════════════════════════════════════════════════════════════════════════════
-- Row Level Security (RLS)
-- The service key (used only server-side in API routes) bypasses RLS.
-- Enabling RLS and denying the anon key means the database cannot be accessed
-- directly from the browser even if the anon key is discovered.
-- ══════════════════════════════════════════════════════════════════════════════
ALTER TABLE customers        ENABLE ROW LEVEL SECURITY;
ALTER TABLE schedule_entries ENABLE ROW LEVEL SECURITY;
ALTER TABLE checkins         ENABLE ROW LEVEL SECURITY;

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

ALTER TABLE checkins
  ADD COLUMN IF NOT EXISTS punch_card_holder_id   UUID REFERENCES customers(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS punch_card_holder_name TEXT NOT NULL DEFAULT '';
