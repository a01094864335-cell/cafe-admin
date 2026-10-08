-- No sample data or remote account configuration belongs in migrations.
CREATE TABLE users (
  id TEXT PRIMARY KEY NOT NULL, name TEXT NOT NULL, email TEXT NOT NULL,
  email_verified INTEGER NOT NULL DEFAULT 0 CHECK(email_verified IN (0,1)),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
) STRICT;
CREATE TABLE auth_identities (
  provider TEXT NOT NULL, subject TEXT NOT NULL, user_id TEXT NOT NULL REFERENCES users(id),
  PRIMARY KEY(provider, subject)
) STRICT;
CREATE TABLE sessions (
  token_hash TEXT PRIMARY KEY NOT NULL, user_id TEXT NOT NULL REFERENCES users(id),
  csrf_hash TEXT NOT NULL, expires_at TEXT NOT NULL, revoked_at TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
) STRICT;
CREATE INDEX sessions_user ON sessions(user_id);
CREATE TABLE oauth_transactions (
  state_hash TEXT PRIMARY KEY NOT NULL, browser_hash TEXT NOT NULL,
  nonce TEXT NOT NULL, verifier TEXT NOT NULL, expires_at TEXT NOT NULL, consumed_at TEXT
) STRICT;
CREATE TABLE cafes (
  id TEXT PRIMARY KEY NOT NULL, name TEXT NOT NULL, timezone TEXT NOT NULL DEFAULT 'Asia/Seoul',
  active_dataset_id TEXT, write_mode TEXT NOT NULL DEFAULT 'open' CHECK(write_mode IN ('open','import','export')),
  revision INTEGER NOT NULL DEFAULT 0 CHECK(revision >= 0),
  version INTEGER NOT NULL DEFAULT 1 CHECK(version >= 1),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  FOREIGN KEY(id, active_dataset_id) REFERENCES datasets(cafe_id, id)
) STRICT;
CREATE TABLE datasets (
  cafe_id TEXT NOT NULL REFERENCES cafes(id), id TEXT NOT NULL,
  state TEXT NOT NULL CHECK(state IN ('staging','active','retired')),
  metadata_json TEXT NOT NULL DEFAULT '{}' CHECK(json_valid(metadata_json)),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  PRIMARY KEY(cafe_id,id)
) STRICT;
CREATE UNIQUE INDEX datasets_one_active ON datasets(cafe_id) WHERE state='active';
CREATE TABLE memberships (
  id TEXT PRIMARY KEY NOT NULL, cafe_id TEXT NOT NULL REFERENCES cafes(id),
  user_id TEXT NOT NULL REFERENCES users(id), role TEXT NOT NULL CHECK(role IN ('owner','admin','staff')),
  status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','inactive')),
  version INTEGER NOT NULL DEFAULT 1 CHECK(version>=1),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE(cafe_id,user_id)
) STRICT;
CREATE UNIQUE INDEX memberships_one_owner ON memberships(cafe_id) WHERE role='owner' AND status='active';
CREATE INDEX memberships_user_active ON memberships(user_id,status,cafe_id);
CREATE TABLE invitations (
  id TEXT PRIMARY KEY NOT NULL, cafe_id TEXT NOT NULL REFERENCES cafes(id), token_hash TEXT NOT NULL UNIQUE,
  email TEXT NOT NULL, role TEXT NOT NULL CHECK(role IN ('admin','staff')),
  inviter_id TEXT NOT NULL REFERENCES users(id), expires_at TEXT NOT NULL,
  consumed_by TEXT REFERENCES users(id), consumed_at TEXT, cancelled_at TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  CHECK((consumed_by IS NULL) = (consumed_at IS NULL)),
  CHECK(consumed_at IS NULL OR cancelled_at IS NULL)
) STRICT;
CREATE INDEX invitations_cafe ON invitations(cafe_id,expires_at);
-- CHECK failure aborts the entire D1 batch, unlike an UPDATE affecting zero rows.
CREATE TABLE transaction_assertions (id TEXT PRIMARY KEY NOT NULL, ok INTEGER NOT NULL CHECK(ok=1)) STRICT;
CREATE TABLE commands (
  id TEXT PRIMARY KEY NOT NULL, user_id TEXT NOT NULL REFERENCES users(id),
  cafe_id TEXT REFERENCES cafes(id), scope TEXT NOT NULL, key TEXT NOT NULL, payload_hash TEXT NOT NULL,
  result_json TEXT CHECK(result_json IS NULL OR json_valid(result_json)),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE(user_id,scope,key), UNIQUE(cafe_id,id)
) STRICT;
CREATE TABLE audit_logs (
  id TEXT PRIMARY KEY NOT NULL, cafe_id TEXT NOT NULL REFERENCES cafes(id),
  actor_id TEXT NOT NULL REFERENCES users(id), operation_id TEXT NOT NULL,
  target TEXT NOT NULL, action TEXT NOT NULL, summary_json TEXT NOT NULL CHECK(json_valid(summary_json)),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  FOREIGN KEY(cafe_id,operation_id) REFERENCES commands(cafe_id,id)
) STRICT;
CREATE INDEX audit_logs_cafe_date ON audit_logs(cafe_id,created_at,id);
