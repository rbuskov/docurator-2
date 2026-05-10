CREATE TABLE app_config (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  fiscal_year_start_month INTEGER NOT NULL DEFAULT 1
    CHECK (fiscal_year_start_month BETWEEN 1 AND 12)
);

INSERT OR IGNORE INTO app_config (id, fiscal_year_start_month) VALUES (1, 1);
