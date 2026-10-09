import importlib.util
import json
from pathlib import Path
import sqlite3
import sys
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('recovery', ROOT / 'scripts/recovery.py')
r = importlib.util.module_from_spec(spec)
spec.loader.exec_module(r)
sys.path.insert(0, str(ROOT / 'scripts'))
import recovery_sql as sql_recovery


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
        self.db.executescript((ROOT / 'tests/server/fixtures/recovery.sql').read_text())
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

    def apply_sql(self, sql):
        # D1 file import supplies the transaction; simulate that contract locally.
        try:
            self.db.executescript('BEGIN IMMEDIATE;\n' + sql + '\nCOMMIT;')
        except Exception:
            self.db.rollback()
            raise

    def test_sql_plan_restores_one_cafe_and_preserves_other_cafe_and_memberships(self):
        self.db.execute("UPDATE sales SET card=999999,version=9 WHERE cafe_id='a' AND dataset_id='a-live'")
        self.db.commit()
        expected_b = [tuple(row) for row in self.db.execute("SELECT * FROM sales WHERE cafe_id='b'")]
        members = [tuple(row) for row in self.db.execute('SELECT * FROM memberships ORDER BY id')]
        sql, report = sql_recovery.make_plan(self.source, self.file, 'a', 'u1', 0)
        self.apply_sql(sql)
        active = self.db.execute("SELECT active_dataset_id FROM cafes WHERE id='a'").fetchone()[0]
        self.assertEqual(r.summary(self.db, 'a', active), self.backup['summary'])
        self.assertEqual(self.db.execute("SELECT version FROM sales WHERE cafe_id='a' AND dataset_id=?", (active,)).fetchone()[0], 10)
        self.assertIsNone(self.db.execute("SELECT linked_user_id FROM employees WHERE cafe_id='a' AND dataset_id=?", (active,)).fetchone()[0])
        self.assertEqual([tuple(row) for row in self.db.execute("SELECT * FROM sales WHERE cafe_id='b'")], expected_b)
        self.assertEqual([tuple(row) for row in self.db.execute('SELECT * FROM memberships ORDER BY id')], members)
        self.assertEqual(self.db.execute('SELECT count(*) FROM transaction_assertions').fetchone()[0], 0)
        self.assertEqual(self.db.execute('PRAGMA foreign_key_check').fetchall(), [])
        self.assertEqual(self.db.execute("SELECT count(*) FROM audit_logs WHERE action='recovery.restore'").fetchone()[0], 1)
        self.assertEqual(report['summary'], self.backup['summary'])
        after = '\n'.join(self.db.iterdump())
        with self.assertRaises(sqlite3.IntegrityError):
            self.apply_sql(sql)
        self.assertEqual('\n'.join(self.db.iterdump()), after, 'Replaying a completed plan must not restore twice')

    def test_sql_plan_rejects_cafe_membership_and_record_changes(self):
        for mutation in ("UPDATE cafes SET revision=revision+1 WHERE id='a'",
                         "UPDATE memberships SET role='staff',version=version+1 WHERE id='ma2'",
                         "UPDATE sales SET version=version+1 WHERE id='s1'"):
            sql, _ = sql_recovery.make_plan(self.source, self.file, 'a', 'u1', self.db.execute("SELECT revision FROM cafes WHERE id='a'").fetchone()[0])
            self.db.execute(mutation)
            self.db.commit()
            changed = '\n'.join(self.db.iterdump())
            with self.assertRaises(sqlite3.IntegrityError):
                self.apply_sql(sql)
            self.assertEqual('\n'.join(self.db.iterdump()), changed)

    def test_sql_plan_failure_after_staging_rolls_back_everything(self):
        sql, _ = sql_recovery.make_plan(self.source, self.file, 'a', 'u1', 0)
        sql = sql.replace("UPDATE datasets SET state='retired'", "INSERT INTO transaction_assertions(id,ok) VALUES ('forced-failure',0);\nUPDATE datasets SET state='retired'")
        with self.assertRaises(sqlite3.IntegrityError):
            self.apply_sql(sql)
        self.assertEqual('\n'.join(self.db.iterdump()), self.before)

    def test_sql_literals_preserve_business_text_without_executing_it(self):
        value = "test'); DROP TABLE users; --\n가상\x00메모"
        self.backup['tables']['sales'][0]['note'] = value
        self.file.write_text(json.dumps(self.backup))
        sql, _ = sql_recovery.make_plan(self.source, self.file, 'a', 'u1', 0)
        self.apply_sql(sql)
        self.assertEqual(self.db.execute("SELECT note FROM active_sales WHERE cafe_id='a'").fetchone()[0], value)
        self.assertEqual(self.db.execute('SELECT count(*) FROM users').fetchone()[0], 3)

    def test_sql_plan_rejects_exhausted_cafe_counter_and_preserves_existing_output(self):
        output = self.path / 'reviewed.sql'
        output.write_text('already reviewed')
        with self.assertRaises(FileExistsError):
            sql_recovery.write_plan(self.source, self.file, 'a', 'u1', 0, output)
        self.assertEqual(output.read_text(), 'already reviewed')
        self.db.execute('UPDATE cafes SET revision=? WHERE id=?', (r.MAX_SAFE, 'a'))
        self.db.commit()
        with self.assertRaises(ValueError):
            sql_recovery.make_plan(self.source, self.file, 'a', 'u1', r.MAX_SAFE)


if __name__ == '__main__':
    unittest.main()
