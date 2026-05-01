#!/usr/bin/env python3
"""One-time SQLite to PostgreSQL data migration for the EC2 deployment."""
from __future__ import annotations

import argparse
import datetime as dt
import os
import sqlite3
import sys
from pathlib import Path
from typing import Any

import sqlalchemy as sa
from sqlalchemy.sql.sqltypes import Boolean, Date, DateTime


def _parse_env_file(path: Path) -> dict[str, str]:
    values: dict[str, str] = {}
    if not path.exists():
        return values
    for raw_line in path.read_text(encoding="utf-8", errors="ignore").splitlines():
        line = raw_line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        value = value.strip()
        if len(value) >= 2 and value[0] == value[-1] and value[0] in {"'", '"'}:
            value = value[1:-1]
        values[key.strip()] = value
    return values


def _sqlite_tables(conn: sqlite3.Connection) -> set[str]:
    rows = conn.execute(
        """
        SELECT name
        FROM sqlite_master
        WHERE type = 'table'
          AND name NOT LIKE 'sqlite_%'
        """
    ).fetchall()
    return {str(row[0]) for row in rows}


def _sqlite_columns(conn: sqlite3.Connection, table_name: str) -> set[str]:
    return {str(row[1]) for row in conn.execute(f'PRAGMA table_info("{table_name}")')}


def _convert_value(value: Any, column: sa.Column[Any]) -> Any:
    if value is None:
        return None

    column_type = column.type
    if isinstance(column_type, Boolean):
        if isinstance(value, str):
            return value.strip().lower() in {"1", "true", "t", "yes", "y", "on"}
        return bool(value)

    if isinstance(column_type, (DateTime, Date)) and isinstance(value, str):
        normalized = value.strip()
        if not normalized:
            return None
        if normalized.endswith("Z"):
            normalized = normalized[:-1] + "+00:00"
        try:
            parsed = dt.datetime.fromisoformat(normalized)
        except ValueError:
            return value
        if isinstance(column_type, Date) and not isinstance(column_type, DateTime):
            return parsed.date()
        return parsed

    return value


def _copy_table(
    sqlite_conn: sqlite3.Connection,
    pg_conn: sa.Connection,
    table: sa.Table,
    source_columns: set[str],
) -> int:
    common_columns = [column for column in table.columns if column.name in source_columns]
    if not common_columns:
        return 0

    column_sql = ", ".join(f'"{column.name}"' for column in common_columns)
    source_rows = sqlite_conn.execute(f'SELECT {column_sql} FROM "{table.name}"').fetchall()
    if not source_rows:
        return 0

    payload = []
    for source_row in source_rows:
        row: dict[str, Any] = {}
        for column in common_columns:
            row[column.name] = _convert_value(source_row[column.name], column)
        payload.append(row)

    pg_conn.execute(table.insert(), payload)
    return len(payload)


def _reset_serial_sequence(pg_conn: sa.Connection, table: sa.Table) -> None:
    pk_columns = list(table.primary_key.columns)
    if len(pk_columns) != 1:
        return
    pk_name = pk_columns[0].name
    quoted_table = pg_conn.dialect.identifier_preparer.quote(table.name)
    quoted_pk = pg_conn.dialect.identifier_preparer.quote(pk_name)
    sequence_name = pg_conn.execute(
        sa.text("SELECT pg_get_serial_sequence(:table_name, :column_name)"),
        {"table_name": table.name, "column_name": pk_name},
    ).scalar()
    if not sequence_name:
        return
    pg_conn.execute(
        sa.text(
            f"""
            SELECT setval(
                :sequence_name,
                COALESCE((SELECT MAX({quoted_pk}) FROM {quoted_table}), 1),
                (SELECT COUNT(*) > 0 FROM {quoted_table})
            )
            """
        ),
        {"sequence_name": sequence_name},
    )


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--sqlite", required=True, help="Path to the SQLite backup file")
    parser.add_argument("--env", default="/home/ec2-user/ozon_backend/.env")
    parser.add_argument("--yes", action="store_true", help="Actually migrate data")
    parser.add_argument("--dry-run", action="store_true", help="Only print the migration plan")
    args = parser.parse_args()

    sqlite_path = Path(args.sqlite)
    if not sqlite_path.exists():
        print(f"SQLite backup not found: {sqlite_path}", file=sys.stderr)
        return 2

    env_values = _parse_env_file(Path(args.env))
    database_url = os.environ.get("DATABASE_URL") or env_values.get("DATABASE_URL", "")
    if not database_url.startswith("postgresql"):
        print("Refusing to migrate: DATABASE_URL is not PostgreSQL", file=sys.stderr)
        return 2
    if not args.yes and not args.dry_run:
        print("Refusing to migrate without --yes or --dry-run", file=sys.stderr)
        return 2

    sqlite_conn = sqlite3.connect(sqlite_path)
    sqlite_conn.row_factory = sqlite3.Row
    source_tables = _sqlite_tables(sqlite_conn)

    engine = sa.create_engine(database_url)
    metadata = sa.MetaData()
    metadata.reflect(bind=engine)
    target_tables = [
        table
        for table in metadata.sorted_tables
        if table.name != "alembic_version"
    ]

    copy_plan = [
        table
        for table in target_tables
        if table.name in source_tables
    ]
    print("SQLite source:", sqlite_path)
    print("PostgreSQL target tables:", len(target_tables))
    print("Tables to copy:", ", ".join(table.name for table in copy_plan))

    if args.dry_run:
        for table in copy_plan:
            count = sqlite_conn.execute(f'SELECT COUNT(*) FROM "{table.name}"').fetchone()[0]
            print(f"{table.name}: {count}")
        return 0

    quoted_tables = [
        engine.dialect.identifier_preparer.quote(table.name)
        for table in target_tables
    ]
    with engine.begin() as pg_conn:
        if quoted_tables:
            pg_conn.execute(
                sa.text(
                    "TRUNCATE TABLE "
                    + ", ".join(quoted_tables)
                    + " RESTART IDENTITY CASCADE"
                )
            )

        for table in copy_plan:
            source_columns = _sqlite_columns(sqlite_conn, table.name)
            copied = _copy_table(sqlite_conn, pg_conn, table, source_columns)
            print(f"{table.name}: copied {copied}")

        for table in target_tables:
            _reset_serial_sequence(pg_conn, table)

    print("Migration complete")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
