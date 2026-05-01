from typing import Optional

from sqlalchemy import (
    Boolean,
    Column,
    DateTime,
    Float,
    ForeignKey,
    Integer,
    String,
    Text,
    UniqueConstraint,
)
from sqlalchemy.sql import func

from database import Base
from security import decrypt_secret, encrypt_secret


class User(Base):
    __tablename__ = "users"

    id = Column(Integer, primary_key=True, index=True)
    username = Column(String, unique=True, index=True, nullable=False)
    display_name = Column(String, nullable=False)
    email = Column(String, unique=True, index=True, nullable=True)
    password_hash = Column(String, nullable=False)
    primary_tenant_id = Column(Integer, ForeignKey("tenants.id"), nullable=True, index=True)
    is_active = Column(Boolean, default=True, nullable=False)
    is_admin = Column(Boolean, default=False, nullable=False)
    last_login_at = Column(DateTime(timezone=True), nullable=True)
    created_at = Column(DateTime(timezone=True), server_default=func.now())
    updated_at = Column(
        DateTime(timezone=True), server_default=func.now(), onupdate=func.now()
    )


class Tenant(Base):
    __tablename__ = "tenants"

    id = Column(Integer, primary_key=True, index=True)
    name = Column(String, nullable=False, index=True)
    slug = Column(String, unique=True, index=True, nullable=False)
    status = Column(String, default="active", nullable=False, index=True)
    plan_code = Column(String, default="starter", nullable=False)
    subscription_status = Column(String, default="active", nullable=False, index=True)
    store_limit = Column(Integer, default=1, nullable=False)
    user_limit = Column(Integer, default=3, nullable=False)
    expires_at = Column(DateTime(timezone=True), nullable=True)
    created_at = Column(DateTime(timezone=True), server_default=func.now())
    updated_at = Column(
        DateTime(timezone=True), server_default=func.now(), onupdate=func.now()
    )


class TenantMember(Base):
    __tablename__ = "tenant_members"
    __table_args__ = (
        UniqueConstraint("tenant_id", "user_id", name="uq_tenant_members_tenant_user"),
    )

    id = Column(Integer, primary_key=True, index=True)
    tenant_id = Column(Integer, ForeignKey("tenants.id"), nullable=False, index=True)
    user_id = Column(Integer, ForeignKey("users.id"), nullable=False, index=True)
    role = Column(String, default="user", nullable=False, index=True)
    status = Column(String, default="active", nullable=False, index=True)
    created_at = Column(DateTime(timezone=True), server_default=func.now())
    updated_at = Column(
        DateTime(timezone=True), server_default=func.now(), onupdate=func.now()
    )


class Role(Base):
    __tablename__ = "roles"
    __table_args__ = (
        UniqueConstraint("scope", "tenant_id", "code", name="uq_roles_scope_tenant_code"),
    )

    id = Column(Integer, primary_key=True, index=True)
    tenant_id = Column(Integer, ForeignKey("tenants.id"), nullable=True, index=True)
    code = Column(String, nullable=False, index=True)
    name = Column(String, nullable=False)
    scope = Column(String, default="tenant", nullable=False, index=True)
    is_system = Column(Boolean, default=False, nullable=False)
    created_at = Column(DateTime(timezone=True), server_default=func.now())
    updated_at = Column(
        DateTime(timezone=True), server_default=func.now(), onupdate=func.now()
    )


class Permission(Base):
    __tablename__ = "permissions"

    id = Column(Integer, primary_key=True, index=True)
    code = Column(String, unique=True, index=True, nullable=False)
    name = Column(String, nullable=False)
    group = Column(String, nullable=True, index=True)
    description = Column(String, nullable=True)
    created_at = Column(DateTime(timezone=True), server_default=func.now())


class Menu(Base):
    __tablename__ = "menus"

    id = Column(Integer, primary_key=True, index=True)
    code = Column(String, unique=True, index=True, nullable=False)
    title = Column(String, nullable=False)
    path = Column(String, nullable=True)
    parent_code = Column(String, nullable=True, index=True)
    sort_order = Column(Integer, default=0, nullable=False)
    required_permission = Column(String, nullable=True)
    is_admin = Column(Boolean, default=False, nullable=False, index=True)
    is_active = Column(Boolean, default=True, nullable=False)
    created_at = Column(DateTime(timezone=True), server_default=func.now())
    updated_at = Column(
        DateTime(timezone=True), server_default=func.now(), onupdate=func.now()
    )


class UserRole(Base):
    __tablename__ = "user_roles"
    __table_args__ = (
        UniqueConstraint("user_id", "role_id", "tenant_id", name="uq_user_roles_user_role_tenant"),
    )

    id = Column(Integer, primary_key=True, index=True)
    user_id = Column(Integer, ForeignKey("users.id"), nullable=False, index=True)
    role_id = Column(Integer, ForeignKey("roles.id"), nullable=False, index=True)
    tenant_id = Column(Integer, ForeignKey("tenants.id"), nullable=True, index=True)
    created_at = Column(DateTime(timezone=True), server_default=func.now())


class RolePermission(Base):
    __tablename__ = "role_permissions"
    __table_args__ = (
        UniqueConstraint("role_id", "permission_id", name="uq_role_permissions_role_permission"),
    )

    id = Column(Integer, primary_key=True, index=True)
    role_id = Column(Integer, ForeignKey("roles.id"), nullable=False, index=True)
    permission_id = Column(Integer, ForeignKey("permissions.id"), nullable=False, index=True)
    created_at = Column(DateTime(timezone=True), server_default=func.now())


class TenantPlan(Base):
    __tablename__ = "tenant_plans"

    id = Column(Integer, primary_key=True, index=True)
    tenant_id = Column(Integer, ForeignKey("tenants.id"), nullable=False, index=True)
    plan_code = Column(String, default="starter", nullable=False, index=True)
    name = Column(String, nullable=False)
    billing_cycle = Column(String, default="monthly", nullable=False)
    price = Column(Float, default=0.0, nullable=False)
    store_limit = Column(Integer, default=1, nullable=False)
    user_limit = Column(Integer, default=3, nullable=False)
    starts_at = Column(DateTime(timezone=True), nullable=True)
    ends_at = Column(DateTime(timezone=True), nullable=True)
    status = Column(String, default="active", nullable=False, index=True)
    created_at = Column(DateTime(timezone=True), server_default=func.now())
    updated_at = Column(
        DateTime(timezone=True), server_default=func.now(), onupdate=func.now()
    )


class StoreQuota(Base):
    __tablename__ = "store_quotas"

    id = Column(Integer, primary_key=True, index=True)
    tenant_id = Column(Integer, ForeignKey("tenants.id"), nullable=False, index=True)
    store_id = Column(Integer, ForeignKey("stores.id"), nullable=True, index=True)
    max_stores = Column(Integer, default=1, nullable=False)
    max_daily_create = Column(Integer, default=250, nullable=False)
    max_daily_update = Column(Integer, default=5000, nullable=False)
    max_total_products = Column(Integer, default=8000, nullable=False)
    created_at = Column(DateTime(timezone=True), server_default=func.now())
    updated_at = Column(
        DateTime(timezone=True), server_default=func.now(), onupdate=func.now()
    )


class Subscription(Base):
    __tablename__ = "subscriptions"

    id = Column(Integer, primary_key=True, index=True)
    tenant_id = Column(Integer, ForeignKey("tenants.id"), nullable=False, index=True)
    plan_code = Column(String, default="starter", nullable=False, index=True)
    status = Column(String, default="active", nullable=False, index=True)
    current_period_start = Column(DateTime(timezone=True), nullable=True)
    current_period_end = Column(DateTime(timezone=True), nullable=True)
    trial_end = Column(DateTime(timezone=True), nullable=True)
    cancel_at = Column(DateTime(timezone=True), nullable=True)
    created_at = Column(DateTime(timezone=True), server_default=func.now())
    updated_at = Column(
        DateTime(timezone=True), server_default=func.now(), onupdate=func.now()
    )


class AuditLog(Base):
    __tablename__ = "audit_logs"

    id = Column(Integer, primary_key=True, index=True)
    tenant_id = Column(Integer, ForeignKey("tenants.id"), nullable=True, index=True)
    user_id = Column(Integer, ForeignKey("users.id"), nullable=True, index=True)
    actor_username = Column(String, nullable=True, index=True)
    action = Column(String, nullable=False, index=True)
    resource_type = Column(String, nullable=True, index=True)
    resource_id = Column(String, nullable=True, index=True)
    details = Column(Text, nullable=True)
    ip_address = Column(String, nullable=True)
    user_agent = Column(String, nullable=True)
    created_at = Column(DateTime(timezone=True), server_default=func.now(), index=True)


class LoginLog(Base):
    __tablename__ = "login_logs"

    id = Column(Integer, primary_key=True, index=True)
    tenant_id = Column(Integer, ForeignKey("tenants.id"), nullable=True, index=True)
    user_id = Column(Integer, ForeignKey("users.id"), nullable=True, index=True)
    username = Column(String, nullable=False, index=True)
    role_scope = Column(String, nullable=True, index=True)
    success = Column(Boolean, default=False, nullable=False, index=True)
    ip_address = Column(String, nullable=True)
    user_agent = Column(String, nullable=True)
    failure_reason = Column(String, nullable=True)
    created_at = Column(DateTime(timezone=True), server_default=func.now(), index=True)


class SyncSchedule(Base):
    __tablename__ = "sync_schedules"

    id = Column(Integer, primary_key=True, index=True)
    tenant_id = Column(Integer, ForeignKey("tenants.id"), nullable=False, index=True)
    store_id = Column(Integer, ForeignKey("stores.id"), nullable=True, index=True)
    name = Column(String, nullable=False)
    job_type = Column(String, nullable=False, index=True)
    enabled = Column(Boolean, default=True, nullable=False, index=True)
    interval_minutes = Column(Integer, default=60, nullable=False)
    days = Column(Integer, default=7, nullable=False)
    last_run_at = Column(DateTime(timezone=True), nullable=True)
    next_run_at = Column(DateTime(timezone=True), nullable=True, index=True)
    last_status = Column(String, nullable=True, index=True)
    last_message = Column(Text, nullable=True)
    last_task_id = Column(String, nullable=True, index=True)
    locked_until = Column(DateTime(timezone=True), nullable=True, index=True)
    created_at = Column(DateTime(timezone=True), server_default=func.now())
    updated_at = Column(
        DateTime(timezone=True), server_default=func.now(), onupdate=func.now()
    )


class SyncRun(Base):
    __tablename__ = "sync_runs"

    id = Column(Integer, primary_key=True, index=True)
    tenant_id = Column(Integer, ForeignKey("tenants.id"), nullable=False, index=True)
    schedule_id = Column(Integer, ForeignKey("sync_schedules.id"), nullable=True, index=True)
    store_id = Column(Integer, ForeignKey("stores.id"), nullable=True, index=True)
    job_type = Column(String, nullable=False, index=True)
    status = Column(String, default="queued", nullable=False, index=True)
    triggered_by = Column(String, default="system", nullable=False, index=True)
    task_id = Column(String, nullable=True, index=True)
    started_at = Column(DateTime(timezone=True), nullable=True)
    finished_at = Column(DateTime(timezone=True), nullable=True)
    result_payload = Column(Text, nullable=True)
    error = Column(Text, nullable=True)
    created_at = Column(DateTime(timezone=True), server_default=func.now(), index=True)


class UserCloudFollowConfig(Base):
    __tablename__ = "user_cloud_follow_configs"
    __table_args__ = (
        UniqueConstraint("tenant_id", "username", name="uq_cloud_follow_config_tenant_user"),
    )

    id = Column(Integer, primary_key=True, index=True)
    tenant_id = Column(Integer, ForeignKey("tenants.id"), nullable=True, index=True)
    user_id = Column(Integer, ForeignKey("users.id"), nullable=True, index=True)
    username = Column(String, nullable=False, index=True)
    front_cookie_encrypted = Column("front_cookie", Text, nullable=True)
    user_agent_encrypted = Column("user_agent", Text, nullable=True)
    created_at = Column(DateTime(timezone=True), server_default=func.now())
    updated_at = Column(
        DateTime(timezone=True), server_default=func.now(), onupdate=func.now()
    )

    @property
    def front_cookie(self) -> Optional[str]:
        return decrypt_secret(self.front_cookie_encrypted)

    @front_cookie.setter
    def front_cookie(self, value: Optional[str]) -> None:
        self.front_cookie_encrypted = encrypt_secret(value)

    @property
    def user_agent(self) -> Optional[str]:
        return decrypt_secret(self.user_agent_encrypted)

    @user_agent.setter
    def user_agent(self, value: Optional[str]) -> None:
        self.user_agent_encrypted = encrypt_secret(value)


class CloudFollowCollectTask(Base):
    __tablename__ = "cloud_follow_collect_tasks"

    id = Column(Integer, primary_key=True, index=True)
    tenant_id = Column(Integer, ForeignKey("tenants.id"), nullable=True, index=True)
    user_owner = Column(String, nullable=False, index=True)
    store_id = Column(Integer, ForeignKey("stores.id"), nullable=False, index=True)
    reference = Column(String, nullable=False, index=True)
    resolved_product_id = Column(String, nullable=True, index=True)
    status = Column(String, default="pending_collect", nullable=False, index=True)
    include_variants = Column(Boolean, default=False, nullable=False)
    max_variants = Column(Integer, default=20, nullable=False)
    price = Column(String, nullable=True)
    old_price = Column(String, nullable=True)
    follow_min_price = Column(String, nullable=True)
    model = Column(String, nullable=True)
    source_url = Column(String, nullable=True)
    product_payload = Column(Text, nullable=True)
    result_payload = Column(Text, nullable=True)
    error = Column(Text, nullable=True)
    upload_job_id = Column(Integer, ForeignKey("upload_jobs.id"), nullable=True, index=True)
    claimed_at = Column(DateTime(timezone=True), nullable=True, index=True)
    completed_at = Column(DateTime(timezone=True), nullable=True, index=True)
    created_at = Column(DateTime(timezone=True), server_default=func.now(), index=True)
    updated_at = Column(
        DateTime(timezone=True), server_default=func.now(), onupdate=func.now()
    )


class Store(Base):
    __tablename__ = "stores"
    __table_args__ = (
        UniqueConstraint("tenant_id", "store_name", name="uq_stores_tenant_store_name"),
    )

    id = Column(Integer, primary_key=True, index=True)
    tenant_id = Column(Integer, ForeignKey("tenants.id"), nullable=True, index=True)
    store_name = Column(String, index=True, nullable=False)
    client_id_encrypted = Column("client_id", String, nullable=False)
    api_key_encrypted = Column("api_key", String, nullable=False)
    currency = Column(String, default="CNY")
    email = Column(String, nullable=True)
    store_group = Column(String, nullable=True)

    key_status = Column(String, default="unverified")
    info = Column(String, nullable=True)
    can_create = Column(String, default="0 / 250")
    can_update = Column(String, default="0 / 5000")
    daily_limit = Column(String, default="0")
    total_limit = Column(String, default="0 / 8000")
    watermark = Column(String, default="disabled")
    warehouse_info = Column(String, nullable=True)
    cookie_status = Column(String, default="unknown")

    status_update_time = Column(
        DateTime(timezone=True), server_default=func.now(), onupdate=func.now()
    )
    add_time = Column(DateTime(timezone=True), server_default=func.now())
    user_owner = Column(String, default="admin")

    @property
    def client_id(self) -> str:
        return decrypt_secret(self.client_id_encrypted) or ""

    @client_id.setter
    def client_id(self, value: Optional[str]) -> None:
        self.client_id_encrypted = encrypt_secret(value) or ""

    @property
    def api_key(self) -> str:
        return decrypt_secret(self.api_key_encrypted) or ""

    @api_key.setter
    def api_key(self, value: Optional[str]) -> None:
        self.api_key_encrypted = encrypt_secret(value) or ""


class UploadJob(Base):
    __tablename__ = "upload_jobs"

    id = Column(Integer, primary_key=True, index=True)
    tenant_id = Column(Integer, ForeignKey("tenants.id"), nullable=True, index=True)
    store_id = Column(Integer, ForeignKey("stores.id"), nullable=False, index=True)
    status = Column(String, nullable=False, default="created", index=True)
    item_count = Column(Integer, nullable=False, default=0)
    source = Column(String, nullable=True)
    local_task_id = Column(String, nullable=True, index=True)
    ozon_task_id = Column(String, nullable=True, index=True)
    request_payload = Column(Text, nullable=False)
    result_payload = Column(Text, nullable=True)
    error = Column(Text, nullable=True)
    created_at = Column(DateTime(timezone=True), server_default=func.now())
    updated_at = Column(
        DateTime(timezone=True), server_default=func.now(), onupdate=func.now()
    )


class UploadJobItem(Base):
    __tablename__ = "upload_job_items"
    __table_args__ = (
        UniqueConstraint("upload_job_id", "offer_id", name="uq_upload_job_items_job_offer"),
    )

    id = Column(Integer, primary_key=True, index=True)
    tenant_id = Column(Integer, ForeignKey("tenants.id"), nullable=True, index=True)
    upload_job_id = Column(Integer, ForeignKey("upload_jobs.id"), nullable=False, index=True)
    store_id = Column(Integer, ForeignKey("stores.id"), nullable=False, index=True)
    offer_id = Column(String, nullable=False, index=True)
    sku = Column(String, nullable=True, index=True)
    status = Column(String, default="queued", nullable=False, index=True)
    request_payload = Column(Text, nullable=False)
    result_payload = Column(Text, nullable=True)
    error = Column(Text, nullable=True)
    ozon_product_id = Column(String, nullable=True, index=True)
    attempt_count = Column(Integer, default=0, nullable=False)
    created_at = Column(DateTime(timezone=True), server_default=func.now(), index=True)
    updated_at = Column(
        DateTime(timezone=True), server_default=func.now(), onupdate=func.now()
    )


class Product(Base):
    __tablename__ = "products"
    __table_args__ = (
        UniqueConstraint("store_id", "offer_id", name="uq_products_store_offer"),
    )

    id = Column(Integer, primary_key=True, index=True)
    tenant_id = Column(Integer, ForeignKey("tenants.id"), nullable=True, index=True)
    store_id = Column(Integer, ForeignKey("stores.id"), nullable=False, index=True)
    upload_job_id = Column(Integer, ForeignKey("upload_jobs.id"), nullable=True)
    offer_id = Column(String, nullable=False, index=True)
    sku = Column(String, nullable=True, index=True)
    article_no = Column(String, nullable=True, index=True)
    product_name = Column(String, nullable=False, index=True)
    primary_image = Column(String, nullable=True)
    info = Column(Text, nullable=True)
    source = Column(String, nullable=True)
    category_level_1 = Column(String, nullable=True, index=True)
    category_level_2 = Column(String, nullable=True, index=True)
    category_level_3 = Column(String, nullable=True, index=True)
    status = Column(String, default="approved", index=True)
    archived = Column(Boolean, default=False, nullable=False)
    auto_restock = Column(Boolean, default=False, nullable=False)
    scheduled_shelf = Column(String, nullable=True)
    warehouse_name = Column(String, nullable=True)
    price = Column(Float, default=0.0)
    display_price = Column(Float, default=0.0)
    profit = Column(Float, default=0.0)
    stock = Column(Integer, default=0)
    backup_stock = Column(Integer, default=0)
    weight_g = Column(Float, default=0.0)
    length_mm = Column(Float, default=0.0)
    width_mm = Column(Float, default=0.0)
    height_mm = Column(Float, default=0.0)
    remark = Column(String, nullable=True)
    country = Column(String, default="CN")
    created_at = Column(DateTime(timezone=True), server_default=func.now())
    updated_at = Column(
        DateTime(timezone=True), server_default=func.now(), onupdate=func.now()
    )


class OrderRecord(Base):
    __tablename__ = "order_records"

    id = Column(Integer, primary_key=True, index=True)
    tenant_id = Column(Integer, ForeignKey("tenants.id"), nullable=True, index=True)
    store_id = Column(Integer, ForeignKey("stores.id"), nullable=False, index=True)
    posting_number = Column(String, nullable=False, unique=True, index=True)
    scheme = Column(String, nullable=False, index=True)
    status = Column(String, nullable=False, index=True)
    status_label = Column(String, nullable=False)
    deadline_at = Column(DateTime(timezone=True), nullable=True)
    amount = Column(Float, default=0.0)
    currency = Column(String, default="RUB")

    all_waybills = Column(String, nullable=True)
    domestic_waybill = Column(String, nullable=True)
    tracking_no = Column(String, nullable=True)
    sender_name = Column(String, nullable=True)
    product_name = Column(String, nullable=True)
    product_image = Column(String, nullable=True)
    total_pieces = Column(Integer, default=1)
    warehouse_status = Column(String, nullable=True)
    responsible_person = Column(String, nullable=True)
    length_mm = Column(Float, default=0.0)
    width_mm = Column(Float, default=0.0)
    height_mm = Column(Float, default=0.0)
    weight_g = Column(Float, default=0.0)
    estimated_price = Column(Float, default=0.0)
    total_purchase_price = Column(Float, default=0.0)
    labeling_fee = Column(Float, default=0.0)
    warehouse_name = Column(String, nullable=True)
    logistics_type = Column(String, nullable=True)
    inbound_status = Column(String, default="pending")
    printed = Column(Boolean, default=False, nullable=False)
    downloaded = Column(Boolean, default=False, nullable=False)
    closed = Column(Boolean, default=False, nullable=False)
    created_at = Column(DateTime(timezone=True), server_default=func.now())
    updated_at = Column(
        DateTime(timezone=True), server_default=func.now(), onupdate=func.now()
    )


class PricingTemplate(Base):
    __tablename__ = "pricing_templates"
    __table_args__ = (
        UniqueConstraint("tenant_id", "name", name="uq_pricing_templates_tenant_name"),
    )

    id = Column(Integer, primary_key=True, index=True)
    tenant_id = Column(Integer, ForeignKey("tenants.id"), nullable=True, index=True)
    name = Column(String, nullable=False, index=True)
    purchase_cost = Column(Float, default=0.0)
    weight_g = Column(Float, default=0.0)
    target_margin_rate = Column(Float, default=0.0)
    length_mm = Column(Float, default=0.0)
    width_mm = Column(Float, default=0.0)
    height_mm = Column(Float, default=0.0)
    domestic_shipping = Column(Float, default=0.0)
    strike_discount_rate = Column(Float, default=0.0)
    ad_rate = Column(Float, default=0.0)
    return_rate = Column(Float, default=0.0)
    other_fee_rate = Column(Float, default=0.0)
    has_battery = Column(Boolean, default=False, nullable=False)
    has_liquid = Column(Boolean, default=False, nullable=False)
    logistics_type = Column(String, default="FBS")
    pickup_type = Column(String, default="Pickup")
    destination_region = Column(String, default="Russia")
    created_at = Column(DateTime(timezone=True), server_default=func.now())
    updated_at = Column(
        DateTime(timezone=True), server_default=func.now(), onupdate=func.now()
    )
