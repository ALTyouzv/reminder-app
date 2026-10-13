CREATE TABLE IF NOT EXISTS tasks (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  title       TEXT    NOT NULL,
  details     TEXT    NOT NULL DEFAULT '',
  remind_at   INTEGER,                 -- UTC milliseconds, NULL = no reminder
  repeat      TEXT    NOT NULL DEFAULT 'none',  -- none | daily | weekly
  lead_min    INTEGER NOT NULL DEFAULT 0,       -- "remind me before", minutes
  early_sent  INTEGER NOT NULL DEFAULT 0,
  done        INTEGER NOT NULL DEFAULT 0,
  notified    INTEGER NOT NULL DEFAULT 0,
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_tasks_due ON tasks (done, notified, remind_at);

CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
