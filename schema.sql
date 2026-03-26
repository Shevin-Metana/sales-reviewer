CREATE TABLE IF NOT EXISTS processed_meetings (
  meeting_id TEXT PRIMARY KEY,
  closer_email TEXT,
  closer_name TEXT,
  lead_name TEXT,
  score INTEGER,
  processed_at INTEGER
);
