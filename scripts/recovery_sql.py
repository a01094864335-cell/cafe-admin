#!/usr/bin/env python3
"""Generate a reviewed, atomic D1 import file for ONE cafe. No network access."""
from contextlib import closing
import argparse
import json
import math
import os
from pathlib import Path
import sqlite3
import uuid

from recovery import TABLES, TOTALS, MAX_SAFE, read_backup, require, restore_cafe


def literal(value):
    if value is None:
        return 'NULL'
    if isinstance(value, str):
        # Hex literals preserve quotes, newlines, Unicode and NUL without SQL injection.
        return "CAST(X'" + value.encode('utf-8').hex() + "' AS TEXT)"
    require(type(value) in (int, float) and math.isfinite(value) and abs(value) <= MAX_SAFE, 'Unsafe SQL value')
    return repr(value)


def equal_row(row):
    return ' AND '.join(key + ' IS ' + literal(value) for key, value in row.items())


def make_plan(source, backup_path, cafe, owner, revision):
    source = Path(source).resolve()
    require(source.is_file(), 'Existing isolated SQLite source required')
    backup = read_backup(backup_path)
    with closing(sqlite3.connect(source.as_uri() + '?mode=ro', uri=True)) as src, closing(sqlite3.connect(':memory:')) as db:
        src.backup(db)
        db.row_factory = sqlite3.Row
        db.execute('PRAGMA foreign_keys=ON')
        require(db.execute('PRAGMA integrity_check').fetchone()[0] == 'ok', 'Source integrity check failed')
        require(not db.execute('PRAGMA foreign_key_check').fetchall(), 'Source relationships invalid')
        current = db.execute('SELECT * FROM cafes WHERE id=?', (cafe,)).fetchone()
        require(current is not None, 'Cafe missing')
        current = dict(current)
        memberships = [dict(row) for row in db.execute('SELECT * FROM memberships WHERE cafe_id=? ORDER BY id', (cafe,))]
        command_ids = {row[0] for row in db.execute('SELECT id FROM commands')}
        prior_versions = {}
        for table in TABLES:
            if table != 'payroll_rates':
                prior_versions[table] = dict(db.execute(f'SELECT id,max(version) FROM {table} WHERE cafe_id=? GROUP BY id', (cafe,)))
        with db:
            report = restore_cafe(db, backup, cafe, owner, revision)
        dataset = report['datasetId']
        new_commands = [dict(row) for row in db.execute('SELECT * FROM commands') if row['id'] not in command_ids]
        operation = next(row['id'] for row in new_commands if row['scope'] == 'operator:restore')
        statements, guards = [], []

        def emit(sql):
            require(len((sql + ';').encode('utf-8')) <= 100000, 'SQL statement exceeds D1 limit')
            statements.append(sql + ';')

        def assertion(predicate):
            guard = str(uuid.uuid4())
            guards.append(guard)
            emit('INSERT INTO transaction_assertions(id,ok) VALUES (' + literal(guard) + ',(' + predicate + '))')

        def insert(table, row):
            emit(f'INSERT INTO {table} ({",".join(row)}) VALUES ({",".join(literal(value) for value in row.values())})')

        # These run inside the SAME D1 file-import transaction as staging and activation.
        assertion('EXISTS(SELECT 1 FROM cafes WHERE ' + equal_row(current) + ')')
        assertion('(SELECT count(*) FROM memberships WHERE cafe_id=' + literal(cafe) + ')=' + str(len(memberships)))
        for membership in memberships:
            assertion('EXISTS(SELECT 1 FROM memberships WHERE ' + equal_row(membership) + ')')
        assertion("EXISTS(SELECT 1 FROM datasets WHERE cafe_id=" + literal(cafe) + ' AND id=' + literal(current['active_dataset_id']) + " AND state='active')")
        emit("UPDATE cafes SET write_mode='import' WHERE id=" + literal(cafe))
        data = dict(db.execute('SELECT * FROM datasets WHERE cafe_id=? AND id=?', (cafe, dataset)).fetchone())
        data['state'] = 'staging'
        insert('datasets', data)
        for row in new_commands:
            insert('commands', row)
        for table in TABLES:
            for row in db.execute(f'SELECT * FROM {table} WHERE cafe_id=? AND dataset_id=?', (cafe, dataset)):
                if table != 'payroll_rates':
                    previous = prior_versions[table].get(row['id'], 0)
                    assertion(f'(SELECT coalesce(max(version),0) FROM {table} WHERE cafe_id={literal(cafe)} AND id={literal(row["id"])})={previous}')
                insert(table, dict(row))
        for table, expected in report['summary'].items():
            where = f'cafe_id={literal(cafe)} AND dataset_id={literal(dataset)}' + ('' if table in ('payroll_rates', 'inventory_movements') else ' AND deleted_at IS NULL')
            assertion(f'(SELECT count(*) FROM {table} WHERE {where})={expected["count"]}')
            if table in TOTALS:
                assertion(f'(SELECT coalesce(sum({TOTALS[table]}),0) FROM {table} WHERE {where})={expected["total"]}')
        assertion('NOT EXISTS(SELECT 1 FROM pragma_foreign_key_check)')
        emit("UPDATE datasets SET state='retired' WHERE cafe_id=" + literal(cafe) + ' AND id=' + literal(current['active_dataset_id']))
        emit("UPDATE datasets SET state='active' WHERE cafe_id=" + literal(cafe) + ' AND id=' + literal(dataset))
        emit("UPDATE cafes SET active_dataset_id=" + literal(dataset) + ",write_mode='open',revision=revision+1,version=version+1 WHERE id=" + literal(cafe))
        for row in db.execute('SELECT * FROM audit_logs WHERE operation_id=?', (operation,)):
            insert('audit_logs', dict(row))
        emit('DELETE FROM transaction_assertions WHERE id IN (' + ','.join(literal(guard) for guard in guards) + ')')
        assertion_count = len(guards)
        sql = '\n'.join([
            '-- ONE cafe recovery: use wrangler d1 execute --remote --file with an explicitly verified DB config.',
            '-- Execute the WHOLE file once. D1 file import is atomic and blocks queries during import.',
            '-- Do not split into commands or copy this file to an unapproved database.',
            *statements, '',
        ])
        return sql, {**report, 'mode': 'reviewed-cafe-sql-plan', 'sourceRevision': revision,
                     'statementCount': len(statements), 'assertionCount': assertion_count,
                     'operationId': operation}


def write_plan(source, backup, cafe, owner, revision, output):
    sql, report = make_plan(source, backup, cafe, owner, revision)
    fd = os.open(output, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600)
    try:
        with os.fdopen(fd, 'w', encoding='utf-8') as file:
            file.write(sql)
    except Exception:
        Path(output).unlink(missing_ok=True)
        raise
    return report


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    for name in ('source', 'backup', 'cafe', 'owner', 'output'):
        parser.add_argument('--' + name, required=True)
    parser.add_argument('--revision', type=int, required=True)
    args = parser.parse_args()
    print(json.dumps(write_plan(args.source, args.backup, args.cafe, args.owner, args.revision, args.output), ensure_ascii=False))


if __name__ == '__main__':
    main()
