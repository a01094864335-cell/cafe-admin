import importlib.util
import json
from pathlib import Path
import sqlite3
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('recovery', ROOT / 'scripts/recovery.py')
r = importlib.util.module_from_spec(spec)
spec.loader.exec_module(r)


class RecoveryTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.path = Path(self.temp.name)
        self.source = self.path / 'source.sqlite'
        self.db = sqlite3.connect(self.source)
        self.addCleanup(self.db.close)
        self.db.row_factory = sqlite3.Row
        self.db.execute('PRAGMA foreign_keys=ON')
        for migration in sorted((ROOT / 'migrations').glob('*.sql')):
            self.db.executescript(migration.read_text())
        self.db.executescript((ROOT / 'tests/server/fixtures/synthetic.sql').read_text())
        self.db.executescript("""
        INSERT INTO commands(id,user_id,cafe_id,scope,key,payload_hash) VALUES ('op','u1','a','test','key','hash');
        INSERT INTO inventory_movements(cafe_id,dataset_id,id,created_by,updated_by,item_id,delta_hundredths,operation_id,kind) VALUES ('a','a-live','m1','u1','u1','i1',250,'op','opening');
        INSERT INTO payroll_settings(cafe_id,dataset_id,id,created_by,updated_by,employee_id,effective_from,weekly_hours,holiday_day,normal_days,calculation_start,calculation_end,threshold,cap_hours,max_weekly,average_weeks) VALUES ('a','a-live','p1','u1','u1','e1','2026-01-01',20,'일',5,'2026-01-01','2026-12-31',15,8,40,4);
        INSERT INTO payroll_rates VALUES ('a','a-live','p1',2026,10000);
        INSERT INTO work_logs(cafe_id,dataset_id,id,created_by,updated_by,employee_id,business_date,start_time,end_time,break_minutes) VALUES ('a','a-live','w1','u1','u1','e1','2026-10-01','09:00','13:00',0);
        UPDATE employees SET linked_user_id='u1' WHERE cafe_id='a' AND dataset_id='a-live';
        """)
        self.backup = {'version': 3, 'format': 'cafe-admin-cloud', 'exportedAt': '2026-10-09T00:00:00.000Z', 'cafe': {'name': '가상 카페 A', 'timezone': 'Asia/Seoul'}, 'metadata': {}, 'summary': r.summary(self.db, 'a', 'a-live'), 'tables': {}}
        for table in r.TABLES:
            self.backup['tables'][table] = [{k: v for k, v in dict(row).items() if k not in r.PRIVATE} for row in self.db.execute(f'SELECT * FROM {table} WHERE cafe_id=? AND dataset_id=?', ('a', 'a-live'))]
        self.file = self.path / 'backup.json'
        self.file.write_text(json.dumps(self.backup))
        self.before = '\n'.join(self.db.iterdump())

    def test_full_database_copy_preserves_all_tables_and_source(self):
        target = self.path / 'full.sqlite'
        self.assertEqual(r.recover(self.source, target)['integrity'], 'ok')
        with sqlite3.connect(target) as db:
            self.assertEqual('\n'.join(db.iterdump()), self.before)
        self.assertEqual('\n'.join(self.db.iterdump()), self.before)
        with self.assertRaises(FileExistsError):
            r.recover(self.source, target)

    def test_cafe_recovery_retains_memberships_other_cafe_and_old_dataset(self):
        self.db.execute("UPDATE sales SET card=999999,version=9 WHERE cafe_id='a' AND dataset_id='a-live'")
        self.db.commit()
        target = self.path / 'cafe.sqlite'
        report = r.recover(self.source, target, self.file, 'a', 'u1', 0)
        with sqlite3.connect(target) as db:
            db.row_factory = sqlite3.Row
            active = db.execute("SELECT active_dataset_id FROM cafes WHERE id='a'").fetchone()[0]
            self.assertEqual(r.summary(db, 'a', active), self.backup['summary'])
            self.assertEqual(db.execute("SELECT version FROM sales WHERE cafe_id='a' AND dataset_id=?", (active,)).fetchone()[0], 10)
            self.assertIsNone(db.execute("SELECT linked_user_id FROM employees WHERE cafe_id='a' AND dataset_id=?", (active,)).fetchone()[0])
            self.assertEqual(db.execute("SELECT state FROM datasets WHERE cafe_id='a' AND id='a-live'").fetchone()[0], 'retired')
            for table in ('cafes', 'datasets', 'memberships', *r.TABLES):
                key = 'id' if table == 'cafes' else 'cafe_id'
                expected = [dict(row) for row in self.db.execute(f'SELECT * FROM {table} WHERE {key}=?', ('b',))]
                actual = [dict(row) for row in db.execute(f'SELECT * FROM {table} WHERE {key}=?', ('b',))]
                self.assertEqual(actual, expected, table)
            self.assertEqual([dict(row) for row in db.execute('SELECT * FROM memberships')], [dict(row) for row in self.db.execute('SELECT * FROM memberships')])
            self.assertEqual(db.execute('PRAGMA foreign_key_check').fetchall(), [])
        self.assertEqual(self.db.execute("SELECT card FROM sales WHERE id='s1'").fetchone()[0], 999999)
        self.assertEqual(report['summary'], self.backup['summary'])

    def test_invalid_backup_or_operator_never_leaves_partial_output(self):
        for bad in ('total', 'cross-cafe', 'private', 'date', 'owner', 'revision'):
            backup = json.loads(json.dumps(self.backup))
            if bad == 'total': backup['summary']['sales']['total'] += 1
            if bad == 'cross-cafe': backup['tables']['work_logs'][0]['employee_id'] = 'e2'
            if bad == 'private': backup['tables']['employees'][0]['linked_user_id'] = 'u2'
            if bad == 'date': backup['tables']['sales'][0]['business_date'] = '2026-02-30'
            self.file.write_text(json.dumps(backup))
            target = self.path / (bad + '.sqlite')
            with self.assertRaises((ValueError, sqlite3.IntegrityError), msg=bad):
                r.recover(self.source, target, self.file, 'a', 'u2' if bad == 'owner' else 'u1', 1 if bad == 'revision' else 0)
            self.assertFalse(target.exists(), bad)
        self.assertEqual('\n'.join(self.db.iterdump()), self.before)


if __name__ == '__main__':
    unittest.main()
