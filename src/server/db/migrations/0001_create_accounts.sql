CREATE TABLE accounts (
  id INTEGER PRIMARY KEY,
  email TEXT NOT NULL UNIQUE,
  display_name TEXT NULL,
  slug TEXT NOT NULL UNIQUE,
  connected_at TEXT NOT NULL,
  last_seen_at TEXT NULL,
  status TEXT NOT NULL CHECK (status IN ('connected','needs_reauth'))
);
