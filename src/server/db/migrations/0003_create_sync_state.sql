CREATE TABLE sync_state (
  account_id INTEGER PRIMARY KEY REFERENCES accounts(id),
  last_history_id TEXT NULL,
  last_synced_at TEXT NULL
);
