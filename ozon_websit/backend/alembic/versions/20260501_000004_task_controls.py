"""task controls and upload scheduling

Revision ID: 20260501_000004
Revises: 20260501_000003
Create Date: 2026-05-01 00:04:00

"""
from __future__ import annotations

from alembic import op
import sqlalchemy as sa


revision = "20260501_000004"
down_revision = "20260501_000003"
branch_labels = None
depends_on = None


def _add_column(table_name: str, column: sa.Column) -> None:
    bind = op.get_bind()
    inspector = sa.inspect(bind)
    columns = {item["name"] for item in inspector.get_columns(table_name)}
    if column.name not in columns:
        op.add_column(table_name, column)


def _create_index(table_name: str, columns: list[str], name: str) -> None:
    bind = op.get_bind()
    inspector = sa.inspect(bind)
    indexes = {item["name"] for item in inspector.get_indexes(table_name)}
    if name not in indexes:
        op.create_index(name, table_name, columns, unique=False)


def _drop_index(table_name: str, name: str) -> None:
    bind = op.get_bind()
    inspector = sa.inspect(bind)
    indexes = {item["name"] for item in inspector.get_indexes(table_name)}
    if name in indexes:
        op.drop_index(name, table_name=table_name)


def _drop_column(table_name: str, column_name: str) -> None:
    bind = op.get_bind()
    inspector = sa.inspect(bind)
    columns = {item["name"] for item in inspector.get_columns(table_name)}
    if column_name in columns:
        op.drop_column(table_name, column_name)


def upgrade() -> None:
    _add_column("upload_jobs", sa.Column("attempt_count", sa.Integer(), nullable=False, server_default="0"))
    _add_column("upload_jobs", sa.Column("max_attempts", sa.Integer(), nullable=False, server_default="3"))
    _add_column("upload_jobs", sa.Column("celery_task_id", sa.String(), nullable=True))
    _add_column("upload_jobs", sa.Column("locked_at", sa.DateTime(timezone=True), nullable=True))
    _add_column("upload_jobs", sa.Column("started_at", sa.DateTime(timezone=True), nullable=True))
    _add_column("upload_jobs", sa.Column("finished_at", sa.DateTime(timezone=True), nullable=True))
    _add_column("upload_jobs", sa.Column("next_attempt_at", sa.DateTime(timezone=True), nullable=True))
    _add_column("upload_jobs", sa.Column("last_refreshed_at", sa.DateTime(timezone=True), nullable=True))
    _add_column("upload_jobs", sa.Column("next_refresh_at", sa.DateTime(timezone=True), nullable=True))
    _add_column("upload_jobs", sa.Column("cancel_requested", sa.Boolean(), nullable=False, server_default=sa.text("false")))
    _add_column("upload_jobs", sa.Column("canceled_at", sa.DateTime(timezone=True), nullable=True))
    _add_column("upload_jobs", sa.Column("timeout_seconds", sa.Integer(), nullable=False, server_default="900"))

    _create_index("upload_jobs", ["celery_task_id"], "ix_upload_jobs_celery_task_id")
    _create_index("upload_jobs", ["locked_at"], "ix_upload_jobs_locked_at")
    _create_index("upload_jobs", ["next_attempt_at"], "ix_upload_jobs_next_attempt_at")
    _create_index("upload_jobs", ["next_refresh_at"], "ix_upload_jobs_next_refresh_at")
    _create_index("upload_jobs", ["cancel_requested"], "ix_upload_jobs_cancel_requested")


def downgrade() -> None:
    for index_name in (
        "ix_upload_jobs_cancel_requested",
        "ix_upload_jobs_next_refresh_at",
        "ix_upload_jobs_next_attempt_at",
        "ix_upload_jobs_locked_at",
        "ix_upload_jobs_celery_task_id",
    ):
        _drop_index("upload_jobs", index_name)

    for column_name in (
        "timeout_seconds",
        "canceled_at",
        "cancel_requested",
        "next_refresh_at",
        "last_refreshed_at",
        "next_attempt_at",
        "finished_at",
        "started_at",
        "locked_at",
        "celery_task_id",
        "max_attempts",
        "attempt_count",
    ):
        _drop_column("upload_jobs", column_name)
