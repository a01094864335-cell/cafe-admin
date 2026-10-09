#!/usr/bin/env python3
"""Offline recovery rehearsal. Writes a NEW SQLite copy; never edits the source or contacts D1."""
from contextlib import closing
import argparse
import datetime as dt
import hashlib
import json
import math
import os
from pathlib import Path
import sqlite3
import uuid

TABLES = ('employees', 'sales', 'purchases', 'expenses', 'other_incomes',
          'inventory_items', 'inventory_movements', 'work_logs', 'payroll_settings',
          'payroll_rates', 'weekly_confirmations', 'payroll_extras', 'sales_reconciliations')
PRIVATE = {'cafe_id', 'dataset_id', 'created_by', 'updated_by', 'linked_user_id', 'operation_id'}
TOTALS = {'sales': 'coalesce(card,0)+coalesce(cash,0)+coalesce(transfer,0)',
          'purchases': 'amount', 'expenses': 'amount', 'other_incomes': 'amount',
          'inventory_items': 'quantity_hundredths', 'payroll_extras': 'amount', 'sales_reconciliations': 'reported'}
MAX_SAFE = 9007199254740991


def require(condition, message):
    if not condition:
        raise ValueError(message)


def no_duplicates(pairs):
    result = {}
    for key, value in pairs:
        require(key not in result, 'Duplicate JSON key')
        result[key] = value
    return result


def read_backup(path):
    require(Path(path).stat().st_size <= 20 * 1024 * 1024, 'Backup exceeds 20 MiB')
    backup = json.loads(Path(path).read_text(), object_pairs_hook=no_duplicates,
                        parse_constant=lambda _: (_ for _ in ()).throw(ValueError('Invalid number')))
    require(isinstance(backup, dict) and set(backup) == {'version', 'format', 'exportedAt', 'cafe', 'metadata', 'summary', 'tables'}, 'Invalid backup fields')
    require(backup['version'] == 3 and backup['format'] == 'cafe-admin-cloud', 'Native v3 backup required')
    require(isinstance(backup['metadata'], dict), 'Invalid metadata')
    require(isinstance(backup['cafe'], dict) and backup['cafe'].get('timezone') == 'Asia/Seoul', 'Unsupported timezone')
    require(isinstance(backup['tables'], dict) and set(backup['tables']) == set(TABLES), 'All business tables required')
    require(isinstance(backup['summary'], dict) and set(backup['summary']) == set(TABLES), 'All summaries required')
    require(all(isinstance(rows, list) for rows in backup['tables'].values()), 'Invalid table rows')
    return backup


def summary(db, cafe, dataset):
    result = {}
    for table in TABLES:
        where = 'cafe_id=? AND dataset_id=?' + ('' if table in ('payroll_rates', 'inventory_movements') else ' AND deleted_at IS NULL')
        total = ',coalesce(sum(' + TOTALS[table] + '),0) total' if table in TOTALS else ''
        row = dict(db.execute(f'SELECT count(*) count{total} FROM {table} WHERE {where}', (cafe, dataset)).fetchone())
        require(all(type(v) is int and abs(v) <= MAX_SAFE for v in row.values()), 'Unsafe total')
        result[table] = row
    return result


def insert(db, table, row):
    keys = list(row)
    # table/columns are caller-owned allowlists, never identifiers taken from the backup.
    db.execute(f'INSERT INTO {table} ({",".join(keys)}) VALUES ({",".join("?" for _ in keys)})', list(row.values()))


def restore_cafe(db, backup, cafe, owner, revision):
    current = db.execute('SELECT * FROM cafes WHERE id=?', (cafe,)).fetchone()
    require(current is not None and current['revision'] == revision and current['write_mode'] == 'open', 'Cafe changed or is locked')
    require(type(revision) is int and 0 <= revision < MAX_SAFE and 1 <= current['version'] < MAX_SAFE, 'Cafe counter out of range')
    owners = db.execute("SELECT user_id FROM memberships WHERE cafe_id=? AND role='owner' AND status='active'", (cafe,)).fetchall()
    require(len(owners) == 1 and owners[0][0] == owner, 'Current sole owner required')
    require(current['timezone'] == backup['cafe']['timezone'], 'Timezone mismatch')
    dataset, operation = str(uuid.uuid4()), str(uuid.uuid4())
    db.execute("INSERT INTO datasets(cafe_id,id,state,metadata_json) VALUES (?,?,'staging',?)", (cafe, dataset, json.dumps(backup['metadata'], ensure_ascii=False)))
    digest = hashlib.sha256(json.dumps(backup, sort_keys=True, ensure_ascii=False).encode()).hexdigest()
    db.execute('INSERT INTO commands(id,user_id,cafe_id,scope,key,payload_hash,result_json) VALUES (?,?,?,?,?,?,?)', (operation, owner, cafe, 'operator:restore', operation, digest, json.dumps({'datasetId': dataset})))
    for table in TABLES:
        schema = {r['name']: r for r in db.execute(f'PRAGMA table_info({table})')}
        allowed = set(schema) - PRIVATE
        for original in backup['tables'][table]:
            require(isinstance(original, dict) and set(original) == allowed, 'Unknown or missing business field: ' + table)
            row = dict(original)
            for key, value in row.items():
                if value is None:
                    require(not schema[key]['notnull'], 'Missing required value: ' + table + '.' + key)
                    continue
                kind = schema[key]['type']
                if kind == 'INTEGER':
                    require(type(value) is int and abs(value) <= MAX_SAFE, 'Invalid integer: ' + key)
                elif kind == 'REAL':
                    require(type(value) in (int, float) and math.isfinite(value) and abs(value) <= MAX_SAFE, 'Invalid number: ' + key)
                else:
                    require(type(value) is str and len(value) <= 4000, 'Invalid text: ' + key)
                    if key in ('business_date', 'hire_date', 'end_date', 'effective_from', 'effective_to', 'first_week', 'calculation_start', 'calculation_end', 'week_start'):
                        require(dt.date.fromisoformat(value).isoformat() == value, 'Invalid date')
                    if key == 'month':
                        require(dt.date.fromisoformat(value + '-01').strftime('%Y-%m') == value, 'Invalid month')
            row.update(cafe_id=cafe, dataset_id=dataset)
            if table != 'payroll_rates':
                previous = db.execute(f'SELECT max(version) FROM {table} WHERE cafe_id=? AND id=?', (cafe, row['id'])).fetchone()[0] or 0
                row['version'] = max(row['version'], previous) + 1
                require(row['version'] <= MAX_SAFE, 'Version out of range')
                row.update(created_by=owner, updated_by=owner)
            if table == 'employees':
                row['linked_user_id'] = None
            if table == 'inventory_movements':
                # One operation per movement preserves UNIQUE(operation,item) even
                # when the source's private operation identifiers were removed.
                movement_operation = str(uuid.uuid4())
                db.execute('INSERT INTO commands(id,user_id,cafe_id,scope,key,payload_hash) VALUES (?,?,?,?,?,?)', (movement_operation, owner, cafe, 'operator:restore-movement', movement_operation, digest))
                row['operation_id'] = movement_operation
            insert(db, table, row)
    require(not db.execute('PRAGMA foreign_key_check').fetchall(), 'Invalid business relationship')
    actual = summary(db, cafe, dataset)
    require(actual == backup['summary'], 'Backup totals/counts do not match')
    db.execute("UPDATE datasets SET state='retired' WHERE cafe_id=? AND id=?", (cafe, current['active_dataset_id']))
    db.execute("UPDATE datasets SET state='active' WHERE cafe_id=? AND id=?", (cafe, dataset))
    db.execute('UPDATE cafes SET active_dataset_id=?,revision=revision+1,version=version+1 WHERE id=?', (dataset, cafe))
    db.execute('INSERT INTO audit_logs(id,cafe_id,actor_id,operation_id,target,action,summary_json) VALUES (?,?,?,?,?,?,?)', (str(uuid.uuid4()), cafe, owner, operation, dataset, 'recovery.restore', '{}'))
    return {'mode': 'offline-cafe-recovery', 'cafeId': cafe, 'datasetId': dataset, 'summary': actual, 'accountLinks': 'not restored; require separate approval'}


def recover(source, output, backup=None, cafe=None, owner=None, revision=None):
    source, output = Path(source).resolve(), Path(output).resolve()
    require(source.is_file() and source != output, 'Existing source and distinct output required')
    # Exclusive creation prevents overwriting an existing DB, even on a failed run.
    fd = os.open(output, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600)
    os.close(fd)
    try:
        with closing(sqlite3.connect(source.as_uri() + '?mode=ro', uri=True)) as src, closing(sqlite3.connect(output)) as dst:
            src.backup(dst)
            dst.row_factory = sqlite3.Row
            dst.execute('PRAGMA foreign_keys=ON')
            require(dst.execute('PRAGMA integrity_check').fetchone()[0] == 'ok', 'Source integrity check failed')
            require(not dst.execute('PRAGMA foreign_key_check').fetchall(), 'Source relationships invalid')
            with dst:
                report = restore_cafe(dst, read_backup(backup), cafe, owner, revision) if backup else {'mode': 'offline-full-db-copy', 'integrity': 'ok'}
            require(not dst.execute('PRAGMA foreign_key_check').fetchall(), 'Recovery relationships invalid')
        return report
    except Exception:
        output.unlink(missing_ok=True)
        raise


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--source', required=True, help='Isolated SQLite database, not a live D1 ID')
    parser.add_argument('--output', required=True, help='New isolated output file; must not exist')
    parser.add_argument('--backup', help='Native v3 JSON for one-cafe recovery')
    parser.add_argument('--cafe')
    parser.add_argument('--owner')
    parser.add_argument('--revision', type=int)
    args = parser.parse_args()
    if args.backup and (not args.cafe or not args.owner or args.revision is None):
        parser.error('--backup requires --cafe, --owner and --revision')
    print(json.dumps(recover(args.source, args.output, args.backup, args.cafe, args.owner, args.revision), ensure_ascii=False))


if __name__ == '__main__':
    main()
