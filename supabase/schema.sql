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
  referral_code         TEXT        NOT NULL DEFAULT '',   -- '' = no affiliated code; stored uppercase
  referral_discount_pct INTEGER     NOT NULL DEFAULT 0,    -- 1..100, discount given to whoever uses the code
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
  pt_punch_holder_name   TEXT        NOT NULL DEFAULT '',
  referral_code          TEXT        NOT NULL DEFAULT '',   -- code redeemed on this visit (uppercase)
  referred_by_id         UUID        REFERENCES customers(id) ON DELETE SET NULL,
  referred_by_name       TEXT        NOT NULL DEFAULT '',
  referral_discount_pct  INTEGER     NOT NULL DEFAULT 0     -- % applied at redemption time
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

-- ── Route Setting Schedule ───────────────────────────────────────────────────
-- One row per routesetting session (typically every other Monday).
CREATE TABLE IF NOT EXISTS routesetting_entries (
  id         UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  date       DATE        NOT NULL,
  walls      TEXT        NOT NULL DEFAULT '[]',    -- JSON array of wall codes e.g. ["W1","W3"]
  setters    TEXT        NOT NULL DEFAULT '[]',    -- JSON array of {name, routes} objects
  styles     TEXT        NOT NULL DEFAULT '[]',    -- JSON array of style strings
  notes      TEXT        NOT NULL DEFAULT '',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_routesetting_date ON routesetting_entries (date);
ALTER TABLE routesetting_entries ENABLE ROW LEVEL SECURITY;

-- ── Migration: PT Punch support ─────────────────────────────────────────────
-- Run these ALTER statements in Supabase SQL Editor if the tables already exist.
ALTER TABLE customers ADD COLUMN IF NOT EXISTS pt_punches_remaining INTEGER NOT NULL DEFAULT 0;
ALTER TABLE checkins  ADD COLUMN IF NOT EXISTS pt_punch_holder_id   UUID REFERENCES customers(id) ON DELETE SET NULL;
ALTER TABLE checkins  ADD COLUMN IF NOT EXISTS pt_punch_holder_name TEXT NOT NULL DEFAULT '';

ALTER TABLE customers        ENABLE ROW LEVEL SECURITY;
ALTER TABLE schedule_entries ENABLE ROW LEVEL SECURITY;
ALTER TABLE checkins         ENABLE ROW LEVEL SECURITY;
ALTER TABLE expenses         ENABLE ROW LEVEL SECURITY;
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

-- ── Referral Code Migration ──────────────────────────────────────────────────
-- Staff assign an affiliated referral code to selected customers, each with its
-- own discount percentage. Anyone else may quote that code at check-in to get
-- the discount; the redemption is recorded against the code owner.
ALTER TABLE customers
  ADD COLUMN IF NOT EXISTS referral_code         TEXT    NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS referral_discount_pct INTEGER NOT NULL DEFAULT 0;

-- Case-insensitive uniqueness so "bbo-abc" and "BBO-ABC" can't both exist.
-- Partial index: the '' default (no code) is exempt.
CREATE UNIQUE INDEX IF NOT EXISTS idx_customers_referral_code
  ON customers (upper(referral_code)) WHERE referral_code <> '';

ALTER TABLE checkins
  ADD COLUMN IF NOT EXISTS referral_code         TEXT    NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS referred_by_id        UUID REFERENCES customers(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS referred_by_name      TEXT    NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS referral_discount_pct INTEGER NOT NULL DEFAULT 0;

CREATE INDEX IF NOT EXISTS idx_checkins_referred_by ON checkins (referred_by_id);

-- ── Multi-Code Referral / Promo Migration ────────────────────────────────────
-- Supersedes the single customers.referral_code column above. A customer may
-- now hold any number of codes, and a code with owner_id = NULL is a universal
-- promo code that belongs to the gym rather than to a customer.
--   owner_id NOT NULL → affiliated referral code (self-referral is blocked)
--   owner_id NULL     → universal promo code (anyone may quote it)
CREATE TABLE IF NOT EXISTS referral_codes (
  id           UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  code         TEXT        NOT NULL,                 -- stored uppercase
  discount_pct INTEGER     NOT NULL,                 -- 1..100, applied to the base price
  owner_id     UUID        REFERENCES customers(id) ON DELETE CASCADE,
  label        TEXT        NOT NULL DEFAULT '',      -- e.g. 'Summer 2026'
  is_active    BOOLEAN     NOT NULL DEFAULT true,    -- false = paused, kept for history
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Case-insensitive uniqueness across every code, owned or universal.
CREATE UNIQUE INDEX IF NOT EXISTS idx_referral_codes_code ON referral_codes (upper(code));
CREATE INDEX IF NOT EXISTS idx_referral_codes_owner ON referral_codes (owner_id);

ALTER TABLE referral_codes ENABLE ROW LEVEL SECURITY;
-- No anon-key policies → service key only (same pattern as all other tables).

-- Backfill the codes that live on customers.referral_code, once.
INSERT INTO referral_codes (code, discount_pct, owner_id)
SELECT c.referral_code, GREATEST(c.referral_discount_pct, 1), c.id
FROM customers c
WHERE c.referral_code <> ''
  AND NOT EXISTS (
    SELECT 1 FROM referral_codes rc WHERE upper(rc.code) = upper(c.referral_code)
  );

-- customers.referral_code / referral_discount_pct are no longer read or written
-- by the app. They are kept as a backup of the pre-migration state; drop them
-- once the backfill above has been verified in production:
--   DROP INDEX IF EXISTS idx_customers_referral_code;
--   ALTER TABLE customers DROP COLUMN referral_code, DROP COLUMN referral_discount_pct;

-- ══════════════════════════════════════════════════════════════════════════════
-- Staff Users  (Issue #2 — multi-user auth with roles)
-- Replaces single env-var admin. Bootstrap: if table is empty, the app falls
-- back to ADMIN_USERNAME / ADMIN_PASSWORD env vars so first deploy still works.
-- Passwords are hashed with Node scrypt (salt:hash hex strings).
-- Roles: 'admin' (full access) | 'staff' (check-in / read-only ops).
-- ══════════════════════════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS staff_users (
  id            UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  username      TEXT        NOT NULL UNIQUE,
  password_hash TEXT        NOT NULL,   -- "salt:hash" both hex, scrypt N=32768 r=8 p=1 len=64
  role          TEXT        NOT NULL DEFAULT 'staff',  -- 'admin' | 'staff'
  is_active     BOOLEAN     NOT NULL DEFAULT true,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE staff_users ENABLE ROW LEVEL SECURITY;
-- No anon-key policies → service key only (same pattern as all other tables).

-- ══════════════════════════════════════════════════════════════════════════════
-- Revoked Tokens  (Issue #1 — persistent token revocation across cold starts)
-- On logout the token SHA-256 hash + expiry are written here.
-- verifyToken loads all non-expired hashes into memory on cold start, then
-- uses the in-memory set as a fast path for subsequent warm invocations.
-- Expired rows can be purged with:
--   DELETE FROM revoked_tokens WHERE expires_at < now();
-- ══════════════════════════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS revoked_tokens (
  token_hash  TEXT        PRIMARY KEY,             -- SHA-256 hex of the raw token string
  expires_at  TIMESTAMPTZ NOT NULL                  -- mirrors the token's own expiry
);

CREATE INDEX IF NOT EXISTS idx_revoked_tokens_expires ON revoked_tokens (expires_at);
ALTER TABLE revoked_tokens ENABLE ROW LEVEL SECURITY;
-- No anon-key policies → service key only.

-- ══════════════════════════════════════════════════════════════════════════════
-- Leaderboard 2026
-- Public leaderboard where customers self-log boulder sends.
-- All reads/writes go through server-side API routes (service key), so
-- RLS is enabled with no anon-key policies (same secure pattern as above).
-- ══════════════════════════════════════════════════════════════════════════════

-- Stores the public display nickname chosen by each customer.
-- One row per customer; upserted on every send submission.
CREATE TABLE IF NOT EXISTS leaderboard_nicknames (
  customer_id  UUID        PRIMARY KEY REFERENCES customers(id) ON DELETE CASCADE,
  nickname     TEXT        NOT NULL,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Case-insensitive uniqueness so "RockKing" and "rockking" can't coexist.
CREATE UNIQUE INDEX IF NOT EXISTS idx_leaderboard_nicknames_lower
  ON leaderboard_nicknames (lower(nickname));

-- One row per individual route successfully sent.
-- grade: 'V0'|'V1'|'V2'|'V3'|'V4'|'V5'|'V6'|'V7'|'V8'
-- wall:  'W1'|'W2'|'W3'|'W4'|'W5'|'W6'
-- points: V0=10  V1=15  V2=20  V3=25  V4=40
--         V5=60  V6=80  V7=100 V8=130
CREATE TABLE IF NOT EXISTS leaderboard_sends (
  id          UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id UUID        NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  wall        TEXT        NOT NULL,
  grade       TEXT        NOT NULL,
  points      INTEGER     NOT NULL,
  logged_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_lb_sends_customer ON leaderboard_sends (customer_id);
CREATE INDEX IF NOT EXISTS idx_lb_sends_logged   ON leaderboard_sends (logged_at);

ALTER TABLE leaderboard_nicknames ENABLE ROW LEVEL SECURITY;
ALTER TABLE leaderboard_sends     ENABLE ROW LEVEL SECURITY;
-- No anon-key policies → service key only (reads proxied through /api/public/leaderboard).

-- ══════════════════════════════════════════════════════════════════════════════
-- Wall Route Configuration  (Leaderboard 2026)
-- One row per wall. next_reset is the next scheduled reset date; the current
-- period starts at (next_reset + floor((today − next_reset) / period_days) * period_days).
-- v0…v8 columns hold the number of routes of each grade available this period.
-- Update next_reset after each reset so the period window rolls forward.
-- ══════════════════════════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS wall_configs (
  wall          TEXT        PRIMARY KEY,            -- 'W1'|'W2'|'W3'|'W4'|'W5'|'W6'
  next_reset    DATE        NOT NULL,               -- next scheduled reset date
  period_weeks  INTEGER     NOT NULL DEFAULT 5,     -- cycle length in weeks
  v0            INTEGER     NOT NULL DEFAULT 0,
  v1            INTEGER     NOT NULL DEFAULT 0,
  v2            INTEGER     NOT NULL DEFAULT 0,
  v3            INTEGER     NOT NULL DEFAULT 0,
  v4            INTEGER     NOT NULL DEFAULT 0,
  v5            INTEGER     NOT NULL DEFAULT 0,
  v6            INTEGER     NOT NULL DEFAULT 0,
  v7            INTEGER     NOT NULL DEFAULT 0,
  v8            INTEGER     NOT NULL DEFAULT 0,
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE wall_configs ENABLE ROW LEVEL SECURITY;
-- No anon-key policies → service key only.

-- Seed the initial wall configurations (safe to re-run; upserts on conflict).
INSERT INTO wall_configs (wall, next_reset, period_weeks, v0,v1,v2,v3,v4,v5,v6,v7,v8) VALUES
  ('W1', '2026-09-07', 5,  0,1,2,2,2,1,1,1,1),
  ('W2', '2026-08-10', 5,  2,2,2,2,1,1,1,0,0),
  ('W3', '2026-08-24', 5,  1,1,2,2,2,1,1,1,0),
  ('W4', '2026-08-31', 5,  0,0,2,2,2,1,1,1,1),
  ('W5', '2026-08-17', 5,  0,1,2,2,2,1,1,1,1),
  ('W6', '2026-08-03', 5,  2,2,2,2,2,1,1,1,0)
ON CONFLICT (wall) DO UPDATE SET
  next_reset   = EXCLUDED.next_reset,
  period_weeks = EXCLUDED.period_weeks,
  v0=EXCLUDED.v0, v1=EXCLUDED.v1, v2=EXCLUDED.v2, v3=EXCLUDED.v3,
  v4=EXCLUDED.v4, v5=EXCLUDED.v5, v6=EXCLUDED.v6, v7=EXCLUDED.v7,
  v8=EXCLUDED.v8, updated_at=now();

-- ══════════════════════════════════════════════════════════════════════════════
-- Staff Sign-Off  (Leaderboard 2026)
-- Every submission logged through the public leaderboard must be witnessed by a
-- staff member, who picks their name and signs on the kiosk.
--
-- Each submission is sealed with an HMAC over its facts (see
-- src/lib/leaderboard-sig.ts), so a row cannot be edited afterwards — here, in
-- the dashboard, or through the API — without GET /api/leaderboard/audit
-- flagging it. The seal proves the record is unaltered; it does not prove the
-- person who signed was really staff.
-- ══════════════════════════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS leaderboard_submissions (
  id            UUID        PRIMARY KEY,            -- set by the API; it is signed
  customer_id   UUID        NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  wall          TEXT        NOT NULL,               -- 'W1'…'W6'
  grades        JSONB       NOT NULL,               -- {"V3":2,"V5":1}
  sends_count   INTEGER     NOT NULL,
  points        INTEGER     NOT NULL,
  staff_name    TEXT        NOT NULL,               -- roster name, snapshot
  signed_at     TIMESTAMPTZ NOT NULL,
  image_sha256  TEXT        NOT NULL,               -- hex SHA-256 of the signature PNG
  signature     TEXT        NOT NULL,               -- base64url HMAC-SHA256 seal
  sig_version   SMALLINT    NOT NULL DEFAULT 1,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_lb_submissions_customer ON leaderboard_submissions (customer_id);
CREATE INDEX IF NOT EXISTS idx_lb_submissions_signed   ON leaderboard_submissions (signed_at);
CREATE INDEX IF NOT EXISTS idx_lb_submissions_staff    ON leaderboard_submissions (staff_name);

-- Signature images live apart from the submission row: at ~8 KB each they would
-- otherwise be dragged into every leaderboard read.
CREATE TABLE IF NOT EXISTS leaderboard_signature_images (
  submission_id UUID PRIMARY KEY REFERENCES leaderboard_submissions(id) ON DELETE CASCADE,
  image         TEXT NOT NULL                       -- data:image/png;base64,…
);

-- Link each send to the submission that authorised it.
-- NULL = logged before staff sign-off existed; still counts, shown as unsigned.
ALTER TABLE leaderboard_sends
  ADD COLUMN IF NOT EXISTS submission_id UUID REFERENCES leaderboard_submissions(id) ON DELETE CASCADE;

CREATE INDEX IF NOT EXISTS idx_lb_sends_submission ON leaderboard_sends (submission_id);

ALTER TABLE leaderboard_submissions       ENABLE ROW LEVEL SECURITY;
ALTER TABLE leaderboard_signature_images  ENABLE ROW LEVEL SECURITY;
-- No anon-key policies → service key only (same pattern as every other table).

-- ── Staff roster (optional; see supabase/migration-staff-signoff.sql) ────────
-- Mirrors the STAFF_NAMES constant in src/lib/staff.ts so the roster is also
-- queryable from SQL. The app does not read this table yet.
CREATE TABLE IF NOT EXISTS staff_roster (
  name       TEXT        PRIMARY KEY,
  is_active  BOOLEAN     NOT NULL DEFAULT true,
  sort_order INTEGER     NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE staff_roster ENABLE ROW LEVEL SECURITY;

INSERT INTO staff_roster (name, sort_order) VALUES
  ('Huyen', 1), ('Duyen Ha', 2), ('Thanh Tu', 3),
  ('Bao Anh', 4), ('Danny', 5), ('Minh Chau', 6)
ON CONFLICT (name) DO UPDATE SET
  sort_order = EXCLUDED.sort_order,
  is_active  = true;
