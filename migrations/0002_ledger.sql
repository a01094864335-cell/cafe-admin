CREATE TABLE employees (
  cafe_id TEXT NOT NULL, dataset_id TEXT NOT NULL, id TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 1 CHECK(version>=1),
  created_by TEXT NOT NULL REFERENCES users(id), updated_by TEXT NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')), deleted_at TEXT,
  name TEXT NOT NULL, linked_user_id TEXT REFERENCES users(id), hire_date TEXT, end_date TEXT,
  PRIMARY KEY(cafe_id,dataset_id,id),
  FOREIGN KEY(cafe_id,dataset_id) REFERENCES datasets(cafe_id,id),
  FOREIGN KEY(cafe_id,linked_user_id) REFERENCES memberships(cafe_id,user_id),
  UNIQUE(cafe_id,dataset_id,linked_user_id)
) STRICT;
CREATE TABLE sales (
  cafe_id TEXT NOT NULL, dataset_id TEXT NOT NULL, id TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 1 CHECK(version>=1),
  created_by TEXT NOT NULL REFERENCES users(id), updated_by TEXT NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')), deleted_at TEXT,
  business_date TEXT NOT NULL, card INTEGER  CHECK(card BETWEEN -1000000000000 AND 1000000000000), cash INTEGER  CHECK(cash BETWEEN -1000000000000 AND 1000000000000), transfer INTEGER  CHECK(transfer BETWEEN -1000000000000 AND 1000000000000), note TEXT NOT NULL DEFAULT '',
  PRIMARY KEY(cafe_id,dataset_id,id),
  FOREIGN KEY(cafe_id,dataset_id) REFERENCES datasets(cafe_id,id)
) STRICT;
CREATE UNIQUE INDEX sales_daily ON sales(cafe_id,dataset_id,business_date) WHERE deleted_at IS NULL;
CREATE TABLE purchases (
  cafe_id TEXT NOT NULL, dataset_id TEXT NOT NULL, id TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 1 CHECK(version>=1),
  created_by TEXT NOT NULL REFERENCES users(id), updated_by TEXT NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')), deleted_at TEXT,
  business_date TEXT NOT NULL, vendor TEXT NOT NULL DEFAULT '', item TEXT NOT NULL, amount INTEGER NOT NULL CHECK(amount BETWEEN -1000000000000 AND 1000000000000), note TEXT NOT NULL DEFAULT '',
  PRIMARY KEY(cafe_id,dataset_id,id),
  FOREIGN KEY(cafe_id,dataset_id) REFERENCES datasets(cafe_id,id)
) STRICT;
CREATE TABLE expenses (
  cafe_id TEXT NOT NULL, dataset_id TEXT NOT NULL, id TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 1 CHECK(version>=1),
  created_by TEXT NOT NULL REFERENCES users(id), updated_by TEXT NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')), deleted_at TEXT,
  business_date TEXT NOT NULL, vendor TEXT NOT NULL DEFAULT '', item TEXT NOT NULL, amount INTEGER NOT NULL CHECK(amount BETWEEN -1000000000000 AND 1000000000000), note TEXT NOT NULL DEFAULT '',
  PRIMARY KEY(cafe_id,dataset_id,id),
  FOREIGN KEY(cafe_id,dataset_id) REFERENCES datasets(cafe_id,id)
) STRICT;
CREATE TABLE other_incomes (
  cafe_id TEXT NOT NULL, dataset_id TEXT NOT NULL, id TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 1 CHECK(version>=1),
  created_by TEXT NOT NULL REFERENCES users(id), updated_by TEXT NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')), deleted_at TEXT,
  business_date TEXT NOT NULL, vendor TEXT NOT NULL DEFAULT '', item TEXT NOT NULL, amount INTEGER NOT NULL CHECK(amount BETWEEN -1000000000000 AND 1000000000000), note TEXT NOT NULL DEFAULT '',
  PRIMARY KEY(cafe_id,dataset_id,id),
  FOREIGN KEY(cafe_id,dataset_id) REFERENCES datasets(cafe_id,id)
) STRICT;
CREATE TABLE inventory_items (
  cafe_id TEXT NOT NULL, dataset_id TEXT NOT NULL, id TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 1 CHECK(version>=1),
  created_by TEXT NOT NULL REFERENCES users(id), updated_by TEXT NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')), deleted_at TEXT,
  name TEXT NOT NULL, unit TEXT NOT NULL, quantity_hundredths INTEGER NOT NULL DEFAULT 0, minimum_hundredths INTEGER NOT NULL DEFAULT 0, cost INTEGER  CHECK(cost BETWEEN -1000000000000 AND 1000000000000), supplier TEXT NOT NULL DEFAULT '',
  PRIMARY KEY(cafe_id,dataset_id,id),
  FOREIGN KEY(cafe_id,dataset_id) REFERENCES datasets(cafe_id,id)
) STRICT;
CREATE TABLE inventory_movements (
  cafe_id TEXT NOT NULL, dataset_id TEXT NOT NULL, id TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 1 CHECK(version>=1),
  created_by TEXT NOT NULL REFERENCES users(id), updated_by TEXT NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')), deleted_at TEXT,
  item_id TEXT NOT NULL, delta_hundredths INTEGER NOT NULL, operation_id TEXT NOT NULL, purchase_id TEXT, kind TEXT NOT NULL CHECK(kind IN ('opening','purchase','adjustment','reversal')), note TEXT NOT NULL DEFAULT '',
  PRIMARY KEY(cafe_id,dataset_id,id),
  FOREIGN KEY(cafe_id,dataset_id) REFERENCES datasets(cafe_id,id),
  FOREIGN KEY(cafe_id,dataset_id,item_id) REFERENCES inventory_items(cafe_id,dataset_id,id),
  FOREIGN KEY(cafe_id,dataset_id,purchase_id) REFERENCES purchases(cafe_id,dataset_id,id),
  FOREIGN KEY(cafe_id,operation_id) REFERENCES commands(cafe_id,id),
  UNIQUE(cafe_id,dataset_id,operation_id,item_id)
) STRICT;
CREATE TABLE work_logs (
  cafe_id TEXT NOT NULL, dataset_id TEXT NOT NULL, id TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 1 CHECK(version>=1),
  created_by TEXT NOT NULL REFERENCES users(id), updated_by TEXT NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')), deleted_at TEXT,
  employee_id TEXT NOT NULL, business_date TEXT NOT NULL, start_time TEXT NOT NULL, end_time TEXT NOT NULL, break_minutes INTEGER NOT NULL CHECK(break_minutes>=0), note TEXT NOT NULL DEFAULT '',
  PRIMARY KEY(cafe_id,dataset_id,id),
  FOREIGN KEY(cafe_id,dataset_id) REFERENCES datasets(cafe_id,id),
  FOREIGN KEY(cafe_id,dataset_id,employee_id) REFERENCES employees(cafe_id,dataset_id,id)
) STRICT;
CREATE UNIQUE INDEX work_logs_daily ON work_logs(cafe_id,dataset_id,employee_id,business_date) WHERE deleted_at IS NULL;
CREATE TABLE payroll_settings (
  cafe_id TEXT NOT NULL, dataset_id TEXT NOT NULL, id TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 1 CHECK(version>=1),
  created_by TEXT NOT NULL REFERENCES users(id), updated_by TEXT NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')), deleted_at TEXT,
  employee_id TEXT NOT NULL, effective_from TEXT NOT NULL, effective_to TEXT,
  first_week TEXT, weekly_hours REAL NOT NULL CHECK(weekly_hours>=0), holiday_day TEXT NOT NULL,
  normal_days REAL NOT NULL CHECK(normal_days>0), calculation_start TEXT NOT NULL, calculation_end TEXT NOT NULL,
  threshold REAL NOT NULL, cap_hours REAL NOT NULL, max_weekly REAL NOT NULL, average_weeks REAL NOT NULL CHECK(average_weeks>0),
  CHECK(effective_to IS NULL OR effective_to>=effective_from),
  PRIMARY KEY(cafe_id,dataset_id,id),
  FOREIGN KEY(cafe_id,dataset_id) REFERENCES datasets(cafe_id,id),
  FOREIGN KEY(cafe_id,dataset_id,employee_id) REFERENCES employees(cafe_id,dataset_id,id)
) STRICT;
CREATE TABLE payroll_rates (
  cafe_id TEXT NOT NULL, dataset_id TEXT NOT NULL, settings_id TEXT NOT NULL,
  year INTEGER NOT NULL, hourly_rate INTEGER CHECK(hourly_rate BETWEEN 0 AND 1000000000000),
  PRIMARY KEY(cafe_id,dataset_id,settings_id,year),
  FOREIGN KEY(cafe_id,dataset_id,settings_id) REFERENCES payroll_settings(cafe_id,dataset_id,id)
) STRICT;
CREATE TRIGGER payroll_no_overlap_insert BEFORE INSERT ON payroll_settings
WHEN NEW.deleted_at IS NULL BEGIN
 SELECT RAISE(ABORT,'payroll_period_overlap') WHERE EXISTS (
  SELECT 1 FROM payroll_settings p WHERE p.cafe_id=NEW.cafe_id AND p.dataset_id=NEW.dataset_id
  AND p.employee_id=NEW.employee_id AND p.id!=NEW.id AND p.deleted_at IS NULL
  AND p.effective_from<=COALESCE(NEW.effective_to,'9999-12-31')
  AND NEW.effective_from<=COALESCE(p.effective_to,'9999-12-31'));
END;
CREATE TRIGGER payroll_no_overlap_update BEFORE UPDATE ON payroll_settings
WHEN NEW.deleted_at IS NULL BEGIN
 SELECT RAISE(ABORT,'payroll_period_overlap') WHERE EXISTS (
  SELECT 1 FROM payroll_settings p WHERE p.cafe_id=NEW.cafe_id AND p.dataset_id=NEW.dataset_id
  AND p.employee_id=NEW.employee_id AND p.id!=NEW.id AND p.deleted_at IS NULL
  AND p.effective_from<=COALESCE(NEW.effective_to,'9999-12-31')
  AND NEW.effective_from<=COALESCE(p.effective_to,'9999-12-31'));
END;
CREATE TABLE weekly_confirmations (
  cafe_id TEXT NOT NULL, dataset_id TEXT NOT NULL, id TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 1 CHECK(version>=1),
  created_by TEXT NOT NULL REFERENCES users(id), updated_by TEXT NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')), deleted_at TEXT,
  employee_id TEXT NOT NULL, week_start TEXT NOT NULL, agreed_hours REAL, confirmation TEXT NOT NULL CHECK(confirmation IN ('미확인','개근·재직 확인','결근','검토필요')), note TEXT NOT NULL DEFAULT '',
  PRIMARY KEY(cafe_id,dataset_id,id),
  FOREIGN KEY(cafe_id,dataset_id) REFERENCES datasets(cafe_id,id),
  FOREIGN KEY(cafe_id,dataset_id,employee_id) REFERENCES employees(cafe_id,dataset_id,id)
) STRICT;
CREATE UNIQUE INDEX weekly_active ON weekly_confirmations(cafe_id,dataset_id,employee_id,week_start) WHERE deleted_at IS NULL;
CREATE TABLE payroll_extras (
  cafe_id TEXT NOT NULL, dataset_id TEXT NOT NULL, id TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 1 CHECK(version>=1),
  created_by TEXT NOT NULL REFERENCES users(id), updated_by TEXT NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')), deleted_at TEXT,
  employee_id TEXT NOT NULL, month TEXT NOT NULL, amount INTEGER  CHECK(amount BETWEEN -1000000000000 AND 1000000000000),
  PRIMARY KEY(cafe_id,dataset_id,id),
  FOREIGN KEY(cafe_id,dataset_id) REFERENCES datasets(cafe_id,id),
  FOREIGN KEY(cafe_id,dataset_id,employee_id) REFERENCES employees(cafe_id,dataset_id,id)
) STRICT;
CREATE UNIQUE INDEX payroll_extras_active ON payroll_extras(cafe_id,dataset_id,employee_id,month) WHERE deleted_at IS NULL;
CREATE TABLE sales_reconciliations (
  cafe_id TEXT NOT NULL, dataset_id TEXT NOT NULL, id TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 1 CHECK(version>=1),
  created_by TEXT NOT NULL REFERENCES users(id), updated_by TEXT NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')), deleted_at TEXT,
  month TEXT NOT NULL, reported INTEGER  CHECK(reported BETWEEN -1000000000000 AND 1000000000000), note TEXT NOT NULL DEFAULT '',
  PRIMARY KEY(cafe_id,dataset_id,id),
  FOREIGN KEY(cafe_id,dataset_id) REFERENCES datasets(cafe_id,id)
) STRICT;
CREATE UNIQUE INDEX reconciliations_active ON sales_reconciliations(cafe_id,dataset_id,month) WHERE deleted_at IS NULL;
CREATE INDEX sales_date ON sales(cafe_id,dataset_id,business_date,id);
CREATE INDEX purchases_date ON purchases(cafe_id,dataset_id,business_date,id);
CREATE INDEX expenses_date ON expenses(cafe_id,dataset_id,business_date,id);
CREATE INDEX other_incomes_date ON other_incomes(cafe_id,dataset_id,business_date,id);
CREATE INDEX work_logs_date ON work_logs(cafe_id,dataset_id,business_date,id);
