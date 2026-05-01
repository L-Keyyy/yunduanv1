"""initial schema

Revision ID: 20260422_000001
Revises:
Create Date: 2026-04-22 03:00:00

"""
from __future__ import annotations

from alembic import op
import sqlalchemy as sa


revision = "20260422_000001"
down_revision = None
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "pricing_templates",
        sa.Column("id", sa.Integer(), nullable=False),
        sa.Column("name", sa.String(), nullable=False),
        sa.Column("purchase_cost", sa.Float(), nullable=True),
        sa.Column("weight_g", sa.Float(), nullable=True),
        sa.Column("target_margin_rate", sa.Float(), nullable=True),
        sa.Column("length_mm", sa.Float(), nullable=True),
        sa.Column("width_mm", sa.Float(), nullable=True),
        sa.Column("height_mm", sa.Float(), nullable=True),
        sa.Column("domestic_shipping", sa.Float(), nullable=True),
        sa.Column("strike_discount_rate", sa.Float(), nullable=True),
        sa.Column("ad_rate", sa.Float(), nullable=True),
        sa.Column("return_rate", sa.Float(), nullable=True),
        sa.Column("other_fee_rate", sa.Float(), nullable=True),
        sa.Column("has_battery", sa.Boolean(), nullable=False),
        sa.Column("has_liquid", sa.Boolean(), nullable=False),
        sa.Column("logistics_type", sa.String(), nullable=True),
        sa.Column("pickup_type", sa.String(), nullable=True),
        sa.Column("destination_region", sa.String(), nullable=True),
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
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index(op.f("ix_pricing_templates_id"), "pricing_templates", ["id"], unique=False)
    op.create_index(op.f("ix_pricing_templates_name"), "pricing_templates", ["name"], unique=True)

    op.create_table(
        "stores",
        sa.Column("id", sa.Integer(), nullable=False),
        sa.Column("store_name", sa.String(), nullable=False),
        sa.Column("client_id", sa.String(), nullable=False),
        sa.Column("api_key", sa.String(), nullable=False),
        sa.Column("currency", sa.String(), nullable=True),
        sa.Column("email", sa.String(), nullable=True),
        sa.Column("store_group", sa.String(), nullable=True),
        sa.Column("key_status", sa.String(), nullable=True),
        sa.Column("info", sa.String(), nullable=True),
        sa.Column("can_create", sa.String(), nullable=True),
        sa.Column("can_update", sa.String(), nullable=True),
        sa.Column("daily_limit", sa.String(), nullable=True),
        sa.Column("total_limit", sa.String(), nullable=True),
        sa.Column("watermark", sa.String(), nullable=True),
        sa.Column("warehouse_info", sa.String(), nullable=True),
        sa.Column("cookie_status", sa.String(), nullable=True),
        sa.Column(
            "status_update_time",
            sa.DateTime(timezone=True),
            server_default=sa.text("CURRENT_TIMESTAMP"),
            nullable=True,
        ),
        sa.Column(
            "add_time",
            sa.DateTime(timezone=True),
            server_default=sa.text("CURRENT_TIMESTAMP"),
            nullable=True,
        ),
        sa.Column("user_owner", sa.String(), nullable=True),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index(op.f("ix_stores_id"), "stores", ["id"], unique=False)
    op.create_index(op.f("ix_stores_store_name"), "stores", ["store_name"], unique=True)

    op.create_table(
        "order_records",
        sa.Column("id", sa.Integer(), nullable=False),
        sa.Column("store_id", sa.Integer(), nullable=False),
        sa.Column("posting_number", sa.String(), nullable=False),
        sa.Column("scheme", sa.String(), nullable=False),
        sa.Column("status", sa.String(), nullable=False),
        sa.Column("status_label", sa.String(), nullable=False),
        sa.Column("deadline_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("amount", sa.Float(), nullable=True),
        sa.Column("currency", sa.String(), nullable=True),
        sa.Column("all_waybills", sa.String(), nullable=True),
        sa.Column("domestic_waybill", sa.String(), nullable=True),
        sa.Column("tracking_no", sa.String(), nullable=True),
        sa.Column("sender_name", sa.String(), nullable=True),
        sa.Column("product_name", sa.String(), nullable=True),
        sa.Column("product_image", sa.String(), nullable=True),
        sa.Column("total_pieces", sa.Integer(), nullable=True),
        sa.Column("warehouse_status", sa.String(), nullable=True),
        sa.Column("responsible_person", sa.String(), nullable=True),
        sa.Column("length_mm", sa.Float(), nullable=True),
        sa.Column("width_mm", sa.Float(), nullable=True),
        sa.Column("height_mm", sa.Float(), nullable=True),
        sa.Column("weight_g", sa.Float(), nullable=True),
        sa.Column("estimated_price", sa.Float(), nullable=True),
        sa.Column("total_purchase_price", sa.Float(), nullable=True),
        sa.Column("labeling_fee", sa.Float(), nullable=True),
        sa.Column("warehouse_name", sa.String(), nullable=True),
        sa.Column("logistics_type", sa.String(), nullable=True),
        sa.Column("inbound_status", sa.String(), nullable=True),
        sa.Column("printed", sa.Boolean(), nullable=False),
        sa.Column("downloaded", sa.Boolean(), nullable=False),
        sa.Column("closed", sa.Boolean(), nullable=False),
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
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index(op.f("ix_order_records_id"), "order_records", ["id"], unique=False)
    op.create_index(op.f("ix_order_records_posting_number"), "order_records", ["posting_number"], unique=True)
    op.create_index(op.f("ix_order_records_scheme"), "order_records", ["scheme"], unique=False)
    op.create_index(op.f("ix_order_records_status"), "order_records", ["status"], unique=False)
    op.create_index(op.f("ix_order_records_store_id"), "order_records", ["store_id"], unique=False)

    op.create_table(
        "upload_jobs",
        sa.Column("id", sa.Integer(), nullable=False),
        sa.Column("store_id", sa.Integer(), nullable=False),
        sa.Column("status", sa.String(), nullable=False),
        sa.Column("item_count", sa.Integer(), nullable=False),
        sa.Column("source", sa.String(), nullable=True),
        sa.Column("local_task_id", sa.String(), nullable=True),
        sa.Column("ozon_task_id", sa.String(), nullable=True),
        sa.Column("request_payload", sa.Text(), nullable=False),
        sa.Column("result_payload", sa.Text(), nullable=True),
        sa.Column("error", sa.Text(), nullable=True),
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
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index(op.f("ix_upload_jobs_id"), "upload_jobs", ["id"], unique=False)
    op.create_index(op.f("ix_upload_jobs_local_task_id"), "upload_jobs", ["local_task_id"], unique=False)
    op.create_index(op.f("ix_upload_jobs_ozon_task_id"), "upload_jobs", ["ozon_task_id"], unique=False)
    op.create_index(op.f("ix_upload_jobs_status"), "upload_jobs", ["status"], unique=False)
    op.create_index(op.f("ix_upload_jobs_store_id"), "upload_jobs", ["store_id"], unique=False)

    op.create_table(
        "products",
        sa.Column("id", sa.Integer(), nullable=False),
        sa.Column("store_id", sa.Integer(), nullable=False),
        sa.Column("upload_job_id", sa.Integer(), nullable=True),
        sa.Column("offer_id", sa.String(), nullable=False),
        sa.Column("sku", sa.String(), nullable=True),
        sa.Column("article_no", sa.String(), nullable=True),
        sa.Column("product_name", sa.String(), nullable=False),
        sa.Column("primary_image", sa.String(), nullable=True),
        sa.Column("info", sa.Text(), nullable=True),
        sa.Column("source", sa.String(), nullable=True),
        sa.Column("category_level_1", sa.String(), nullable=True),
        sa.Column("category_level_2", sa.String(), nullable=True),
        sa.Column("category_level_3", sa.String(), nullable=True),
        sa.Column("status", sa.String(), nullable=True),
        sa.Column("archived", sa.Boolean(), nullable=False),
        sa.Column("auto_restock", sa.Boolean(), nullable=False),
        sa.Column("scheduled_shelf", sa.String(), nullable=True),
        sa.Column("warehouse_name", sa.String(), nullable=True),
        sa.Column("price", sa.Float(), nullable=True),
        sa.Column("display_price", sa.Float(), nullable=True),
        sa.Column("profit", sa.Float(), nullable=True),
        sa.Column("stock", sa.Integer(), nullable=True),
        sa.Column("backup_stock", sa.Integer(), nullable=True),
        sa.Column("weight_g", sa.Float(), nullable=True),
        sa.Column("length_mm", sa.Float(), nullable=True),
        sa.Column("width_mm", sa.Float(), nullable=True),
        sa.Column("height_mm", sa.Float(), nullable=True),
        sa.Column("remark", sa.String(), nullable=True),
        sa.Column("country", sa.String(), nullable=True),
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
        sa.ForeignKeyConstraint(["upload_job_id"], ["upload_jobs.id"]),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("store_id", "offer_id", name="uq_products_store_offer"),
    )
    op.create_index(op.f("ix_products_article_no"), "products", ["article_no"], unique=False)
    op.create_index(op.f("ix_products_category_level_1"), "products", ["category_level_1"], unique=False)
    op.create_index(op.f("ix_products_category_level_2"), "products", ["category_level_2"], unique=False)
    op.create_index(op.f("ix_products_category_level_3"), "products", ["category_level_3"], unique=False)
    op.create_index(op.f("ix_products_id"), "products", ["id"], unique=False)
    op.create_index(op.f("ix_products_offer_id"), "products", ["offer_id"], unique=False)
    op.create_index(op.f("ix_products_product_name"), "products", ["product_name"], unique=False)
    op.create_index(op.f("ix_products_sku"), "products", ["sku"], unique=False)
    op.create_index(op.f("ix_products_status"), "products", ["status"], unique=False)
    op.create_index(op.f("ix_products_store_id"), "products", ["store_id"], unique=False)


def downgrade() -> None:
    op.drop_index(op.f("ix_products_store_id"), table_name="products")
    op.drop_index(op.f("ix_products_status"), table_name="products")
    op.drop_index(op.f("ix_products_sku"), table_name="products")
    op.drop_index(op.f("ix_products_product_name"), table_name="products")
    op.drop_index(op.f("ix_products_offer_id"), table_name="products")
    op.drop_index(op.f("ix_products_id"), table_name="products")
    op.drop_index(op.f("ix_products_category_level_3"), table_name="products")
    op.drop_index(op.f("ix_products_category_level_2"), table_name="products")
    op.drop_index(op.f("ix_products_category_level_1"), table_name="products")
    op.drop_index(op.f("ix_products_article_no"), table_name="products")
    op.drop_table("products")

    op.drop_index(op.f("ix_upload_jobs_store_id"), table_name="upload_jobs")
    op.drop_index(op.f("ix_upload_jobs_status"), table_name="upload_jobs")
    op.drop_index(op.f("ix_upload_jobs_ozon_task_id"), table_name="upload_jobs")
    op.drop_index(op.f("ix_upload_jobs_local_task_id"), table_name="upload_jobs")
    op.drop_index(op.f("ix_upload_jobs_id"), table_name="upload_jobs")
    op.drop_table("upload_jobs")

    op.drop_index(op.f("ix_order_records_store_id"), table_name="order_records")
    op.drop_index(op.f("ix_order_records_status"), table_name="order_records")
    op.drop_index(op.f("ix_order_records_scheme"), table_name="order_records")
    op.drop_index(op.f("ix_order_records_posting_number"), table_name="order_records")
    op.drop_index(op.f("ix_order_records_id"), table_name="order_records")
    op.drop_table("order_records")

    op.drop_index(op.f("ix_stores_store_name"), table_name="stores")
    op.drop_index(op.f("ix_stores_id"), table_name="stores")
    op.drop_table("stores")

    op.drop_index(op.f("ix_pricing_templates_name"), table_name="pricing_templates")
    op.drop_index(op.f("ix_pricing_templates_id"), table_name="pricing_templates")
    op.drop_table("pricing_templates")
