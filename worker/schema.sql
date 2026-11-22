CREATE TABLE IF NOT EXISTS scores (
  id      TEXT PRIMARY KEY,      -- Discord user id
  name    TEXT NOT NULL,         -- Discord display name (taken from Discord, not from the browser)
  avatar  TEXT,                  -- Discord avatar hash
  score   INTEGER NOT NULL,
  rounds  INTEGER NOT NULL,
  streak  INTEGER NOT NULL,
  acc     INTEGER NOT NULL,
  updated INTEGER NOT NULL       -- ms since epoch
);
CREATE INDEX IF NOT EXISTS idx_scores_score ON scores (score DESC);
