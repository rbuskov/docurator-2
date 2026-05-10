CREATE TABLE processed_messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  account_id INTEGER NOT NULL REFERENCES accounts(id),
  message_id TEXT NOT NULL,
  thread_id TEXT NOT NULL,
  internal_date TEXT NOT NULL,
  processed_at TEXT NOT NULL,
  model_used TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('success','failed')),
  error_message TEXT NULL,
  classification TEXT NULL CHECK (classification IN ('invoice','receipt','other') OR classification IS NULL),
  confidence TEXT NULL CHECK (confidence IN ('high','medium','low') OR confidence IS NULL),
  reason TEXT NULL,
  sender_domain TEXT NULL,
  subject TEXT NULL
);

CREATE INDEX processed_messages_account_message_processed_idx
  ON processed_messages (account_id, message_id, processed_at DESC);

CREATE INDEX processed_messages_account_processed_idx
  ON processed_messages (account_id, processed_at);
