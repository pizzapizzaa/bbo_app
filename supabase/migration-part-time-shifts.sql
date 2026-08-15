-- ══════════════════════════════════════════════════════════════════════════════
-- Part-time shift claiming
--
-- The admin posts part-time slots that need filling; part-timers log in with a
-- single shared account, pick a slot and stamp it with their own name.
--
-- Modelling note: a claim writes the chosen name into `staff_name`, the same
-- column an admin-assigned shift uses. Every hours calculation in the app keys
-- off `staff_name`, so weekly totals, the part-timer panel and Monthly Hours all
-- pick up claimed shifts with no further changes. `claimed_by` duplicates the
-- name purely as an audit trail of who claimed vs. who was assigned.
--
-- Safe to run more than once.
-- ══════════════════════════════════════════════════════════════════════════════

ALTER TABLE schedule_entries
  -- 'assigned' (admin named the person) | 'part_time' (open slot to be claimed)
  ADD COLUMN IF NOT EXISTS shift_type         TEXT        NOT NULL DEFAULT 'assigned',
  -- Part-timer who claimed the slot; '' while the slot is still open.
  ADD COLUMN IF NOT EXISTS claimed_by         TEXT        NOT NULL DEFAULT '',
  -- Login the claim was made from — the shared part-time account, or the admin
  -- username when the admin filled the slot in directly.
  ADD COLUMN IF NOT EXISTS claimed_by_account TEXT        NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS claimed_at         TIMESTAMPTZ;

-- An open slot has no one on it yet, so `staff_name` is stored as ''.
-- The column stays NOT NULL; only the emptiness is new.
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'schedule_entries_shift_type_chk'
  ) THEN
    ALTER TABLE schedule_entries
      ADD CONSTRAINT schedule_entries_shift_type_chk
      CHECK (shift_type IN ('assigned', 'part_time'));
  END IF;
END $$;

-- Assigned shifts must always name someone; only part-time slots may sit empty.
--
-- Every pre-existing row is 'assigned', so this constraint is rejected outright
-- if any of them has a blank staff_name. Rather than fail the migration, adopt
-- those rows as open part-time slots — a nameless shift is exactly that.
UPDATE schedule_entries
   SET shift_type = 'part_time'
 WHERE shift_type = 'assigned' AND staff_name = '';

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'schedule_entries_assigned_has_name_chk'
  ) THEN
    ALTER TABLE schedule_entries
      ADD CONSTRAINT schedule_entries_assigned_has_name_chk
      CHECK (shift_type <> 'assigned' OR staff_name <> '');
  END IF;
END $$;

-- Drives the "Open Shifts" board and the OPEN row of the weekly calendar.
CREATE INDEX IF NOT EXISTS idx_schedule_open_shifts
  ON schedule_entries (date)
  WHERE shift_type = 'part_time' AND staff_name = '';

-- ── Accounts ──────────────────────────────────────────────────────────────────
-- The page decides what you can do from the role in your session token:
--   role 'admin' → post/edit/delete shifts (the admin account)
--   role 'staff' → claim and release open shifts only (the shared part-time
--                  account, shared by all six part-timers)
--
-- `staff_users.role` DEFAULTs to 'staff', so any account created without an
-- explicit role is currently a 'staff' one. Check the roster before deploying —
-- an admin left on 'staff' would lose the ability to post shifts:
--
--   SELECT username, role, is_active FROM staff_users ORDER BY created_at;
--
-- Promote the real admins, then create the shared part-time account:
--
--   UPDATE staff_users SET role = 'admin' WHERE username IN ('<admin username>');
--
-- Create the part-time account through POST /api/users (it hashes the password)
-- with {"username": "parttime", "password": "…", "role": "staff"}.
