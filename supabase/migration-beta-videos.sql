CREATE TABLE IF NOT EXISTS beta_videos (
  id          UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  title       TEXT        NOT NULL,
  wall        TEXT        NOT NULL,
  route       TEXT        NOT NULL,
  description TEXT        NOT NULL DEFAULT '',
  video_url   TEXT        NOT NULL,
  is_active   BOOLEAN     NOT NULL DEFAULT true,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by  TEXT        NOT NULL DEFAULT ''
);

CREATE INDEX IF NOT EXISTS idx_beta_videos_wall_route ON beta_videos (wall, route);
ALTER TABLE beta_videos ENABLE ROW LEVEL SECURITY;
