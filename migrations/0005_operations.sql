ALTER TABLE audit_logs ADD COLUMN request_id TEXT;
CREATE TABLE request_windows (
  user_id TEXT PRIMARY KEY NOT NULL REFERENCES users(id),
  window INTEGER NOT NULL, count INTEGER NOT NULL CHECK(count BETWEEN 1 AND 120)
) STRICT;
CREATE INDEX sessions_expiry ON sessions(expires_at);
CREATE INDEX oauth_expiry ON oauth_transactions(expires_at);
