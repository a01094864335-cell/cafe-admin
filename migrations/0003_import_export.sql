CREATE TABLE import_jobs (
  cafe_id TEXT NOT NULL, id TEXT NOT NULL, dataset_id TEXT NOT NULL,
  owner_id TEXT NOT NULL REFERENCES users(id), file_hash TEXT NOT NULL,
  state TEXT NOT NULL CHECK(state IN ('uploading','validating','ready','committed','failed','cancelled')),
  expected_chunks INTEGER NOT NULL CHECK(expected_chunks>=0),
  validated_revision INTEGER, summary_json TEXT CHECK(summary_json IS NULL OR json_valid(summary_json)),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  PRIMARY KEY(cafe_id,id), UNIQUE(cafe_id,file_hash), UNIQUE(cafe_id,dataset_id),
  FOREIGN KEY(cafe_id,dataset_id) REFERENCES datasets(cafe_id,id)
) STRICT;
CREATE UNIQUE INDEX import_one_running ON import_jobs(cafe_id) WHERE state IN ('uploading','validating','ready');
CREATE TABLE import_chunks (
  cafe_id TEXT NOT NULL, job_id TEXT NOT NULL, chunk_no INTEGER NOT NULL CHECK(chunk_no>=0),
  payload_hash TEXT NOT NULL, row_count INTEGER NOT NULL CHECK(row_count>=0),
  PRIMARY KEY(cafe_id,job_id,chunk_no),
  FOREIGN KEY(cafe_id,job_id) REFERENCES import_jobs(cafe_id,id)
) STRICT;
CREATE TABLE export_jobs (
  cafe_id TEXT NOT NULL, id TEXT NOT NULL, dataset_id TEXT NOT NULL,
  revision INTEGER NOT NULL CHECK(revision>=0), owner_id TEXT NOT NULL REFERENCES users(id),
  expires_at TEXT NOT NULL, state TEXT NOT NULL CHECK(state IN ('running','complete','failed','cancelled')),
  PRIMARY KEY(cafe_id,id), FOREIGN KEY(cafe_id,dataset_id) REFERENCES datasets(cafe_id,id)
) STRICT;
CREATE UNIQUE INDEX export_one_running ON export_jobs(cafe_id) WHERE state='running';
-- Active dataset is selected by the server, never from a client-supplied dataset ID.
CREATE VIEW active_sales AS
 SELECT s.* FROM sales s JOIN cafes c ON c.id=s.cafe_id AND c.active_dataset_id=s.dataset_id
 JOIN datasets d ON d.cafe_id=s.cafe_id AND d.id=s.dataset_id AND d.state='active'
 WHERE s.deleted_at IS NULL;
