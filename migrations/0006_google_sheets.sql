-- Tokens are encrypted before persistence. Revision changes enqueue within the write transaction.
CREATE TABLE google_sheet_links (
 cafe_id TEXT PRIMARY KEY REFERENCES cafes(id), owner_id TEXT NOT NULL REFERENCES users(id),
 spreadsheet_id TEXT NOT NULL, refresh_cipher TEXT NOT NULL,
 requested_revision INTEGER NOT NULL, synced_revision INTEGER NOT NULL DEFAULT -1,
 last_success TEXT, error TEXT, attempts INTEGER NOT NULL DEFAULT 0,
 retry_at INTEGER NOT NULL DEFAULT 0, lease TEXT, lease_until INTEGER NOT NULL DEFAULT 0
) STRICT;
CREATE TRIGGER google_sheets_enqueue AFTER UPDATE OF revision ON cafes
WHEN NEW.revision != OLD.revision
BEGIN
 UPDATE google_sheet_links SET requested_revision=NEW.revision WHERE cafe_id=NEW.id;
END;
CREATE TABLE google_sheet_oauth (
 state_hash TEXT PRIMARY KEY, browser_hash TEXT NOT NULL, cafe_id TEXT NOT NULL REFERENCES cafes(id),
 owner_id TEXT NOT NULL REFERENCES users(id), session_hash TEXT NOT NULL,
 nonce TEXT NOT NULL, verifier TEXT NOT NULL, expires_at TEXT NOT NULL, consumed INTEGER NOT NULL DEFAULT 0
) STRICT;
