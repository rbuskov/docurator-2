CREATE TABLE documents (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  account_id INTEGER NOT NULL REFERENCES accounts(id),
  message_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('attachment','rendered_body')),
  filename TEXT NOT NULL,
  mime_type TEXT NOT NULL,
  size INTEGER NOT NULL,
  content_hash TEXT NOT NULL,
  file_path TEXT NOT NULL,
  vendor TEXT NULL,
  amount REAL NULL,
  currency TEXT NULL,
  transaction_date TEXT NULL,
  review_status TEXT NOT NULL DEFAULT 'pending'
    CHECK (review_status IN ('pending','approved','rejected')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (account_id, content_hash)
);

CREATE INDEX documents_account_review_created_idx
  ON documents (account_id, review_status, created_at);

CREATE INDEX documents_account_message_idx
  ON documents (account_id, message_id);
