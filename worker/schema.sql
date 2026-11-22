-- One row per Discord account per Daily (Malaysia-time date). A second save for the same day is ignored.
CREATE TABLE IF NOT EXISTS daily_scores (
  day      TEXT NOT NULL,        -- e.g. 2026-11-22 (Malaysia time)
  id       TEXT NOT NULL,        -- Discord user id
  name     TEXT NOT NULL,        -- Discord display name (taken from Discord, not from the browser)
  avatar   TEXT,                 -- Discord avatar hash
  correct  INTEGER NOT NULL,     -- right answers
  points   INTEGER NOT NULL,
  rounds   INTEGER NOT NULL,     -- matches played that day (normally 15)
  answers  TEXT NOT NULL,        -- c = correct, w = wrong, t = time ran out
  updated  INTEGER NOT NULL,     -- ms since epoch
  PRIMARY KEY (day, id)
);
CREATE INDEX IF NOT EXISTS idx_daily_rank ON daily_scores (day, correct DESC, points DESC);
CREATE INDEX IF NOT EXISTS idx_daily_user ON daily_scores (id);

-- Small key/value store for the Discord bot (e.g. the id of the live leaderboard message in the channel).
CREATE TABLE IF NOT EXISTS bot_state (
  k TEXT PRIMARY KEY,
  v TEXT NOT NULL
);
