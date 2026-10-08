-- Preserve the legacy distinction between missing input and a recorded zero.
ALTER TABLE work_logs ADD COLUMN break_missing INTEGER NOT NULL DEFAULT 0 CHECK(break_missing IN (0,1));
ALTER TABLE payroll_settings ADD COLUMN weekly_hours_missing INTEGER NOT NULL DEFAULT 0 CHECK(weekly_hours_missing IN (0,1));
ALTER TABLE import_jobs ADD COLUMN manifest_json TEXT CHECK(manifest_json IS NULL OR json_valid(manifest_json));
ALTER TABLE export_jobs ADD COLUMN snapshot_json TEXT CHECK(snapshot_json IS NULL OR json_valid(snapshot_json));
CREATE INDEX inventory_purchase_history ON inventory_movements(cafe_id,dataset_id,purchase_id,item_id);
CREATE INDEX work_logs_period ON work_logs(cafe_id,dataset_id,business_date) WHERE deleted_at IS NULL;
CREATE INDEX weekly_period ON weekly_confirmations(cafe_id,dataset_id,week_start) WHERE deleted_at IS NULL;
CREATE INDEX extras_period ON payroll_extras(cafe_id,dataset_id,month) WHERE deleted_at IS NULL;
CREATE TABLE import_source_ids (
 cafe_id TEXT NOT NULL, job_id TEXT NOT NULL, source_id TEXT NOT NULL,
 kind TEXT NOT NULL, target_id TEXT NOT NULL,
 PRIMARY KEY(cafe_id,job_id,source_id),
 FOREIGN KEY(cafe_id,job_id) REFERENCES import_jobs(cafe_id,id)
) STRICT;
