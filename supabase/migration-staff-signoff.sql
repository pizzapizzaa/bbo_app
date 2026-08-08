-- ══════════════════════════════════════════════════════════════════════════════
-- Migration: Staff Sign-Off for Leaderboard 2026
--
-- Run this ONCE in the Supabase SQL Editor (Dashboard → SQL Editor → New Query)
-- BEFORE deploying the new code. The leaderboard GET now reads
-- leaderboard_sends.submission_id; if the column is missing the board returns
-- a 500 and the public page shows "Could not load leaderboard".
--
-- Safe to re-run: every statement is IF NOT EXISTS / idempotent.
-- Also folded into supabase/schema.sql for fresh installs.
-- ══════════════════════════════════════════════════════════════════════════════

-- ── 1. Signed submissions ────────────────────────────────────────────────────
-- One row per staff-witnessed submission. `signature` is an HMAC-SHA256 over
-- the other columns (see src/lib/leaderboard-sig.ts), so editing any of them
-- here — or anywhere else — makes GET /api/leaderboard/audit flag the row.
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

-- ── 2. Signature images ──────────────────────────────────────────────────────
-- Kept out of the submissions row: at ~8 KB each they would otherwise be
-- dragged into every leaderboard read.
CREATE TABLE IF NOT EXISTS leaderboard_signature_images (
  submission_id UUID PRIMARY KEY REFERENCES leaderboard_submissions(id) ON DELETE CASCADE,
  image         TEXT NOT NULL                       -- data:image/png;base64,…
);

-- ── 3. Link sends to the submission that authorised them ─────────────────────
-- NULL = logged before sign-off existed. Those still count toward the ranking
-- and are shown on the board as unsigned.
ALTER TABLE leaderboard_sends
  ADD COLUMN IF NOT EXISTS submission_id UUID REFERENCES leaderboard_submissions(id) ON DELETE CASCADE;

CREATE INDEX IF NOT EXISTS idx_lb_sends_submission ON leaderboard_sends (submission_id);

-- ── 4. RLS ───────────────────────────────────────────────────────────────────
-- No anon-key policies → service key only, same as every other table.
ALTER TABLE leaderboard_submissions      ENABLE ROW LEVEL SECURITY;
ALTER TABLE leaderboard_signature_images ENABLE ROW LEVEL SECURITY;


-- ══════════════════════════════════════════════════════════════════════════════
-- 5. Staff roster
--
-- The dropdown on the leaderboard reads from src/lib/staff.ts, so this table is
-- OPTIONAL — it is here so the names live in the database too, for reporting
-- and for editing without a redeploy. Nothing breaks if you skip it; see the
-- note at the bottom for the code change needed to make the app read from it.
-- ══════════════════════════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS staff_roster (
  name       TEXT        PRIMARY KEY,
  is_active  BOOLEAN     NOT NULL DEFAULT true,
  sort_order INTEGER     NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE staff_roster ENABLE ROW LEVEL SECURITY;

-- Seed with the current roster. Re-running only refreshes ordering and
-- reactivates the listed names; it never deletes anyone.
INSERT INTO staff_roster (name, sort_order) VALUES
  ('Huyen',      1),
  ('Duyen Ha',   2),
  ('Thanh Tu',   3),
  ('Bao Anh',    4),
  ('Danny',      5),
  ('Minh Chau',  6)
ON CONFLICT (name) DO UPDATE SET
  sort_order = EXCLUDED.sort_order,
  is_active  = true;

-- ── Everyday roster maintenance ──────────────────────────────────────────────
-- Add someone:
--   INSERT INTO staff_roster (name, sort_order) VALUES ('New Person', 7)
--     ON CONFLICT (name) DO UPDATE SET is_active = true;
--
-- Someone leaves (keeps their historical sign-offs intact — never DELETE):
--   UPDATE staff_roster SET is_active = false WHERE name = 'Old Person';
--
-- Fix a spelling. Note that leaderboard_submissions.staff_name is a signed
-- snapshot: updating it there would break the seal, so past sign-offs keep the
-- old spelling by design.
--   UPDATE staff_roster SET name = 'Correct Name' WHERE name = 'Wrong Name';
--
-- Who signed off how much this month:
--   SELECT staff_name, COUNT(*) AS submissions, SUM(sends_count) AS sends
--     FROM leaderboard_submissions
--    WHERE signed_at >= date_trunc('month', now())
--    GROUP BY staff_name
--    ORDER BY submissions DESC;

-- ── To make the app read the roster from this table ──────────────────────────
-- Names currently come from the STAFF_NAMES constant in src/lib/staff.ts, which
-- the page renders server-side. To switch to the database instead:
--   1. In src/pages/leaderboard2026.astro frontmatter, replace the STAFF_NAMES
--      import with:
--        const { data: roster } = await db.from('staff_roster')
--          .select('name').eq('is_active', true).order('sort_order');
--        const STAFF_NAMES = (roster ?? []).map(r => r.name);
--   2. In src/pages/api/public/leaderboard.ts, replace isKnownStaff(staffName)
--      with the same query plus a membership check.
-- Until then, keep this table and src/lib/staff.ts in step.
