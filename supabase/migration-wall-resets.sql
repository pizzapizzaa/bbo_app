-- ══════════════════════════════════════════════════════════════════════════════
-- Migration: Wall resets for Leaderboard 2026
--
-- Run this ONCE in the Supabase SQL Editor (Dashboard → SQL Editor → New Query)
-- BEFORE deploying the new code. The leaderboard now reads each wall's current
-- set from wall_resets; without the table every wall answers "Wall
-- configuration not found" and no sends can be logged.
--
-- Safe to re-run: every statement is IF NOT EXISTS / guarded.
-- Also folded into supabase/schema.sql for fresh installs.
--
-- WHY
-- ---
-- wall_configs rolled each wall's period forward on a fixed schedule
-- (next_reset + n × period_weeks). A late or skipped reset still started a new
-- period, so climbers could log the same routes twice, and the route counts for
-- each new set had to be edited here by hand.
--
-- Now staff record each reset on the POS Schedule page (Wall Resets tab):
--   closes_at — wall is stripped (usually Sunday 19:00); sends from here on
--               count against the new set
--   opens_at  — new set is ready (usually Tuesday at opening); nothing can be
--               logged on the wall between closes_at and opens_at
--   v0…v8     — routes of each grade in the new set
-- A reset can be entered ahead of time: the old set stays current until
-- closes_at passes.
--
-- wall_configs is no longer read by the app. It is left in place, untouched.
-- ══════════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS wall_resets (
  id          UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  wall        TEXT        NOT NULL CHECK (wall IN ('W1','W2','W3','W4','W5','W6')),
  closes_at   TIMESTAMPTZ NOT NULL,
  opens_at    TIMESTAMPTZ NOT NULL,
  v0          INTEGER     NOT NULL DEFAULT 0,
  v1          INTEGER     NOT NULL DEFAULT 0,
  v2          INTEGER     NOT NULL DEFAULT 0,
  v3          INTEGER     NOT NULL DEFAULT 0,
  v4          INTEGER     NOT NULL DEFAULT 0,
  v5          INTEGER     NOT NULL DEFAULT 0,
  v6          INTEGER     NOT NULL DEFAULT 0,
  v7          INTEGER     NOT NULL DEFAULT 0,
  v8          INTEGER     NOT NULL DEFAULT 0,
  notes       TEXT        NOT NULL DEFAULT '',
  created_by  TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (opens_at >= closes_at),
  CHECK (LEAST(v0,v1,v2,v3,v4,v5,v6,v7,v8) >= 0)
);

-- One reset per wall per moment; also what "current set" lookups walk.
CREATE UNIQUE INDEX IF NOT EXISTS idx_wall_resets_wall_closes
  ON wall_resets (wall, closes_at);

ALTER TABLE wall_resets ENABLE ROW LEVEL SECURITY;
-- No anon-key policies → service key only.

-- Carry each wall's current period over from wall_configs, so limits and the
-- sends already counted against them stay exactly as they are today. The start
-- uses the old formula: next_reset + whole periods, at midnight UTC.
-- Walls that already have a reset are skipped.
INSERT INTO wall_resets (wall, closes_at, opens_at, v0,v1,v2,v3,v4,v5,v6,v7,v8, notes, created_by)
SELECT c.wall, p.start_at, p.start_at,
       c.v0, c.v1, c.v2, c.v3, c.v4, c.v5, c.v6, c.v7, c.v8,
       'Carried over from wall_configs', 'migration'
FROM wall_configs c
CROSS JOIN LATERAL (
  SELECT (c.next_reset
          + (floor((current_date - c.next_reset)::numeric / (c.period_weeks * 7))
             * c.period_weeks * 7)::int
         )::timestamp AT TIME ZONE 'UTC' AS start_at
) p
WHERE NOT EXISTS (SELECT 1 FROM wall_resets r WHERE r.wall = c.wall);
