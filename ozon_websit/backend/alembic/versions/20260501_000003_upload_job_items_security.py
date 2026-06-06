"""upload job items and encrypted secrets

Revision ID: 20260501_000003
Revises: 20260427_000002
Create Date: 2026-05-01 00:00:00

"""
from __future__ import annotations

from alembic import op
import sqlalchemy as sa


revision = "20260501_000003"
down_revision = "20260427_000002"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "upload_job_items",
        sa.Column("id", sa.Integer(), nullable=False),
        sa.Column("tenant_id", sa.Integer(), nullable=True),
        sa.Column("upload_job_id", sa.Integer(), nullable=False),
        sa.Column("store_id", sa.Integer(), nullable=False),
        sa.Column("offer_id", sa.String(), nullable=False),
        sa.Column("sku", sa.String(), nullable=True),
        sa.Column("status", sa.String(), nullable=False),
        sa.Column("request_payload", sa.Text(), nullable=False),
        sa.Column("result_payload", sa.Text(), nullable=True),
        sa.Column("error", sa.Text(), nullable=True),
        sa.Column("ozon_product_id", sa.String(), nullable=True),
        sa.Column("attempt_count", sa.Integer(), nullable=False),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("CURRENT_TIMESTAMP"),
            nullable=True,
        ),
        sa.Column(
            "updated_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("CURRENT_TIMESTAMP"),
            nullable=True,
        ),
        sa.ForeignKeyConstraint(["store_id"], ["stores.id"]),
        sa.ForeignKeyConstraint(["tenant_id"], ["tenants.id"]),
        sa.ForeignKeyConstraint(["upload_job_id"], ["upload_jobs.id"]),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("upload_job_id", "offer_id", name="uq_upload_job_items_job_offer"),
    )
    op.create_index(op.f("ix_upload_job_items_id"), "upload_job_items", ["id"], unique=False)
    op.create_index(op.f("ix_upload_job_items_tenant_id"), "upload_job_items", ["tenant_id"], unique=False)
    op.create_index(op.f("ix_upload_job_items_upload_job_id"), "upload_job_items", ["upload_job_id"], unique=False)
    op.create_index(op.f("ix_upload_job_items_store_id"), "upload_job_items", ["store_id"], unique=False)
    op.create_index(op.f("ix_upload_job_items_offer_id"), "upload_job_items", ["offer_id"], unique=False)
    op.create_index(op.f("ix_upload_job_items_sku"), "upload_job_items", ["sku"], unique=False)
    op.create_index(op.f("ix_upload_job_items_status"), "upload_job_items", ["status"], unique=False)
    op.create_index(op.f("ix_upload_job_items_ozon_product_id"), "upload_job_items", ["ozon_product_id"], unique=False)
    op.create_index(op.f("ix_upload_job_items_created_at"), "upload_job_items", ["created_at"], unique=False)


def downgrade() -> None:
    op.drop_index(op.f("ix_upload_job_items_created_at"), table_name="upload_job_items")
    op.drop_index(op.f("ix_upload_job_items_ozon_product_id"), table_name="upload_job_items")
    op.drop_index(op.f("ix_upload_job_items_status"), table_name="upload_job_items")
    op.drop_index(op.f("ix_upload_job_items_sku"), table_name="upload_job_items")
    op.drop_index(op.f("ix_upload_job_items_offer_id"), table_name="upload_job_items")
    op.drop_index(op.f("ix_upload_job_items_store_id"), table_name="upload_job_items")
    op.drop_index(op.f("ix_upload_job_items_upload_job_id"), table_name="upload_job_items")
    op.drop_index(op.f("ix_upload_job_items_tenant_id"), table_name="upload_job_items")
    op.drop_index(op.f("ix_upload_job_items_id"), table_name="upload_job_items")
    op.drop_table("upload_job_items")
