import base64
import ast
import asyncio
import copy
import hashlib
import hmac
import json
import logging
import secrets
import socket
import time
from datetime import date, datetime, timedelta, timezone
from pathlib import Path
from threading import Lock
from typing import Any, Awaitable, Callable, Dict, Iterable, List, Optional, Sequence
from urllib.parse import parse_qs, quote, urlparse

import httpx
from fastapi import Body, Depends, FastAPI, HTTPException, Query, Request, status
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from jose import JWTError, jwt
from sqlalchemy import func, inspect, or_, text
from sqlalchemy.orm import Session
from websocket import create_connection

from activities_client import (
    activate_products,
    approve_discount_tasks,
    deactivate_products,
    get_actions,
    get_candidates,
    get_discount_tasks,
    get_participating_products,
    reject_discount_tasks,
)
import commission_data
from config import settings
from database import Base, SessionLocal, engine, get_db
from extension_upload_bridge import build_upload_item
import models
import schemas
from notifications_client import get_discount_tasks_alerts, get_unfulfilled_orders
from ozon_frontend_product import build_product_data as build_ozon_frontend_product_data
from ozon_frontend_product import extract_product_id as extract_ozon_frontend_product_id
from ozon_client import (
    archive_products,
    fetch_fbs_postings,
    get_products_info_list,
    get_upload_task_info,
    list_warehouses,
    list_products_page,
    unarchive_products,
    update_product_prices,
    update_product_stocks,
    upload_products,
    verify_ozon_credentials,
)
from sourcing_1688 import compare_1688_sources

logger = logging.getLogger(__name__)

try:
    from celery.result import AsyncResult
    from celery_app import celery_app

    CELERY_AVAILABLE = True
except Exception:
    AsyncResult = None  # type: ignore[assignment]
    celery_app = None  # type: ignore[assignment]
    CELERY_AVAILABLE = False

CHROME_DEVTOOLS_BASE = settings.chrome_devtools_base
OZON_BUYER_ORIGIN = "https://www.ozon.ru"
_ACTIVITY_PRODUCT_DETAILS_CACHE_TTL_SECONDS = 600.0
_ACTIVITY_QUERY_CACHE_TTL_SECONDS = 120.0
_ACTIVITY_CACHE_LOCK = Lock()
_ACTIVITY_PRODUCT_DETAILS_CACHE: Dict[str, tuple[float, Dict[str, Any]]] = {}
_ACTIVITY_QUERY_CACHE: Dict[str, tuple[float, Dict[str, Any]]] = {}
SELLER_ANALYTICS_CACHE_TTL_SECONDS = float(settings.SELLER_ANALYTICS_CACHE_TTL_SECONDS)
SELLER_MARKET_TRENDS_CACHE_TTL_SECONDS = SELLER_ANALYTICS_CACHE_TTL_SECONDS
SELLER_MARKET_TRENDS_DISK_CACHE_TTL_SECONDS = SELLER_ANALYTICS_CACHE_TTL_SECONDS
SELLER_MARKET_TRENDS_CACHE_LOCK = Lock()
SELLER_MARKET_TRENDS_CACHE: Dict[str, tuple[float, Dict[str, Any]]] = {}
SELLER_MARKET_TRENDS_CACHE_FILE = Path(__file__).resolve().parent / "cache" / "seller_market_trends.json"
SELLER_MARKET_ALL_ROOTS_CACHE_TTL_SECONDS = SELLER_ANALYTICS_CACHE_TTL_SECONDS
SELLER_MARKET_ALL_ROOTS_CACHE_LOCK = Lock()
SELLER_MARKET_ALL_ROOTS_CACHE: Dict[str, tuple[float, Dict[str, Any]]] = {}
SELLER_MARKET_ALL_ROOTS_CACHE_FILE = Path(__file__).resolve().parent / "cache" / "seller_market_all_roots.json"
SELLER_HOT_TAGS_CACHE_TTL_SECONDS = SELLER_ANALYTICS_CACHE_TTL_SECONDS
SELLER_HOT_TAGS_MAX_ROWS = 5000
SELLER_HOT_TAGS_GROUP_SAMPLE_LIMIT = 50
SELLER_HOT_TAGS_BATCH_SIZE = 5
SELLER_HOT_TAGS_HISTORY_LIMIT = 14
SELLER_HOT_TAGS_ALLOWED_TREND_WINDOW_DAYS = (7, 28)
SELLER_HOT_TAGS_DEFAULT_TREND_WINDOW_DAYS = 7
SELLER_HOT_TAGS_CACHE_LOCK = Lock()
SELLER_HOT_TAGS_CACHE: Dict[str, tuple[float, Dict[str, Any]]] = {}
SELLER_HOT_TAGS_CACHE_FILE = Path(__file__).resolve().parent / "cache" / "seller_hot_tags.json"
SELLER_PRODUCT_MARKET_CACHE_TTL_SECONDS = SELLER_ANALYTICS_CACHE_TTL_SECONDS
SELLER_PRODUCT_MARKET_CACHE_LOCK = Lock()
SELLER_PRODUCT_MARKET_CACHE: Dict[str, tuple[float, Dict[str, Any]]] = {}
SERVICE_STARTED_AT = datetime.now(timezone.utc)
PASSWORD_HASH_ALGORITHM = "sha256"
PASSWORD_HASH_ITERATIONS = 260000
USERNAME_MIN_LENGTH = 3
USERNAME_MAX_LENGTH = 40
DEFAULT_TENANT_SLUG = "default"
SYSTEM_PERMISSIONS = [
    ("admin:read", "管理端查看", "admin"),
    ("admin:write", "管理端写入", "admin"),
    ("tenants:manage", "租户管理", "tenant"),
    ("users:manage", "用户管理", "user"),
    ("roles:manage", "角色权限管理", "rbac"),
    ("menus:manage", "菜单管理", "rbac"),
    ("billing:manage", "订阅套餐管理", "billing"),
    ("audit:read", "审计日志查看", "audit"),
    ("app:read", "应用访问", "app"),
    ("stores:manage", "店铺管理", "store"),
]
SYSTEM_MENUS = [
    ("admin.dashboard", "管理仪表盘", "/admin", None, 10, "admin:read", True),
    ("admin.tenants", "租户管理", "/admin/tenants", None, 20, "tenants:manage", True),
    ("admin.users", "用户管理", "/admin/users", None, 30, "users:manage", True),
    ("admin.roles", "角色权限", "/admin/roles", None, 40, "roles:manage", True),
    ("admin.audit", "审计日志", "/admin/audit-logs", None, 50, "audit:read", True),
]
SYNC_JOB_TYPES = {
    "verify_stores": "校验店铺",
    "sync_products": "同步商品",
    "sync_orders": "同步订单",
    "sync_core": "核心同步",
}
UPLOAD_ACTIVE_STATUSES = {"dispatching", "uploading", "submitted", "processing"}
UPLOAD_TERMINAL_STATUSES = {
    "completed",
    "completed_with_errors",
    "failed",
    "canceled",
}
UPLOAD_RETRYABLE_STATUSES = {"queued", "retrying", "submit_failed", "queue_failed"}
UPLOAD_DISPATCH_LIMIT = int(settings.UPLOAD_MAX_GLOBAL_ACTIVE_STORES)
UPLOAD_RESULT_POLL_INTERVAL_SECONDS = int(settings.UPLOAD_RESULT_POLL_INTERVAL_SECONDS)
UPLOAD_INITIAL_RESULT_POLL_DELAY_SECONDS = max(
    5,
    min(60, int(settings.UPLOAD_INITIAL_RESULT_POLL_DELAY_SECONDS or 10)),
)
UPLOAD_TIMEOUT_SECONDS = int(settings.UPLOAD_TIMEOUT_SECONDS)
UPLOAD_MAX_ATTEMPTS = int(settings.UPLOAD_MAX_ATTEMPTS)
CLOUD_FOLLOW_FRONTEND_FETCH_CONCURRENCY = max(
    1,
    min(8, int(settings.CLOUD_FOLLOW_FRONTEND_FETCH_CONCURRENCY or 4)),
)
UPLOAD_BUILD_ITEM_CONCURRENCY = max(
    1,
    min(8, int(settings.UPLOAD_BUILD_ITEM_CONCURRENCY or 4)),
)
ORDER_SYNC_INTERVAL_MINUTES = int(settings.ORDER_SYNC_INTERVAL_MINUTES)


def _table_exists(table_name: str) -> bool:
    try:
        return inspect(engine).has_table(table_name)
    except Exception:
        return False


def _ensure_product_schema() -> None:
    if not _table_exists("products"):
        return
    try:
        column_names = {column["name"] for column in inspect(engine).get_columns("products")}
    except Exception:
        return

    with engine.begin() as connection:
        if "warehouse_name" not in column_names:
            connection.execute(text("ALTER TABLE products ADD COLUMN warehouse_name VARCHAR"))


def _ensure_auth_schema() -> None:
    try:
        models.User.__table__.create(bind=engine, checkfirst=True)
    except Exception:
        return


def _ensure_store_owner_schema() -> None:
    if not _table_exists("stores"):
        return
    try:
        column_names = {column["name"] for column in inspect(engine).get_columns("stores")}
    except Exception:
        return

    with engine.begin() as connection:
        if "user_owner" not in column_names:
            connection.execute(
                text("ALTER TABLE stores ADD COLUMN user_owner VARCHAR DEFAULT 'admin'")
            )
        connection.execute(
            text(
                """
                UPDATE stores
                SET user_owner = :default_owner
                WHERE user_owner IS NULL OR TRIM(user_owner) = ''
                """
            ),
            {"default_owner": settings.ADMIN_USERNAME},
        )


def _add_column_if_missing(table_name: str, column_name: str, ddl: str) -> None:
    if not _table_exists(table_name):
        return
    try:
        column_names = {column["name"] for column in inspect(engine).get_columns(table_name)}
    except Exception:
        return
    if column_name in column_names:
        return
    with engine.begin() as connection:
        connection.execute(text(f"ALTER TABLE {table_name} ADD COLUMN {ddl}"))


def _ensure_tenant_schema() -> None:
    for table in (
        models.Tenant.__table__,
        models.TenantMember.__table__,
        models.Role.__table__,
        models.Permission.__table__,
        models.Menu.__table__,
        models.UserRole.__table__,
        models.RolePermission.__table__,
        models.TenantPlan.__table__,
        models.StoreQuota.__table__,
        models.Subscription.__table__,
        models.AuditLog.__table__,
        models.LoginLog.__table__,
        models.SyncSchedule.__table__,
        models.SyncRun.__table__,
        models.UserCloudFollowConfig.__table__,
        models.CloudFollowCollectTask.__table__,
        models.UploadJobItem.__table__,
    ):
        table.create(bind=engine, checkfirst=True)

    _add_column_if_missing("users", "primary_tenant_id", "primary_tenant_id INTEGER")
    _add_column_if_missing("users", "last_login_at", "last_login_at TIMESTAMP")
    _add_column_if_missing("stores", "tenant_id", "tenant_id INTEGER")
    _add_column_if_missing("upload_jobs", "tenant_id", "tenant_id INTEGER")
    _add_column_if_missing("upload_jobs", "attempt_count", "attempt_count INTEGER DEFAULT 0 NOT NULL")
    _add_column_if_missing("upload_jobs", "max_attempts", "max_attempts INTEGER DEFAULT 3 NOT NULL")
    _add_column_if_missing("upload_jobs", "celery_task_id", "celery_task_id VARCHAR")
    _add_column_if_missing("upload_jobs", "locked_at", "locked_at TIMESTAMP")
    _add_column_if_missing("upload_jobs", "started_at", "started_at TIMESTAMP")
    _add_column_if_missing("upload_jobs", "finished_at", "finished_at TIMESTAMP")
    _add_column_if_missing("upload_jobs", "next_attempt_at", "next_attempt_at TIMESTAMP")
    _add_column_if_missing("upload_jobs", "last_refreshed_at", "last_refreshed_at TIMESTAMP")
    _add_column_if_missing("upload_jobs", "next_refresh_at", "next_refresh_at TIMESTAMP")
    _add_column_if_missing("upload_jobs", "cancel_requested", "cancel_requested BOOLEAN DEFAULT FALSE NOT NULL")
    _add_column_if_missing("upload_jobs", "canceled_at", "canceled_at TIMESTAMP")
    _add_column_if_missing("upload_jobs", "timeout_seconds", "timeout_seconds INTEGER DEFAULT 900 NOT NULL")
    _add_column_if_missing("upload_job_items", "tenant_id", "tenant_id INTEGER")
    _add_column_if_missing("products", "tenant_id", "tenant_id INTEGER")
    _add_column_if_missing("order_records", "tenant_id", "tenant_id INTEGER")
    _add_column_if_missing("pricing_templates", "tenant_id", "tenant_id INTEGER")


def _normalize_warehouse_labels() -> None:
    bad_suffix = "칵훰꾑욋"
    with engine.begin() as connection:
        connection.execute(
            text(
                """
                UPDATE products
                SET warehouse_name = REPLACE(warehouse_name, :bad_suffix, :good_suffix)
                WHERE warehouse_name LIKE :pattern
                """
            ),
            {"bad_suffix": bad_suffix, "good_suffix": "默认仓库", "pattern": f"%{bad_suffix}%"},
        )
        if _table_exists("order_records"):
            connection.execute(
                text(
                    """
                    UPDATE order_records
                    SET warehouse_name = REPLACE(warehouse_name, :bad_suffix, :good_suffix)
                    WHERE warehouse_name LIKE :pattern
                    """
                ),
                {"bad_suffix": bad_suffix, "good_suffix": "默认仓库", "pattern": f"%{bad_suffix}%"},
            )


def _encrypt_existing_sensitive_fields() -> None:
    if not _table_exists("stores"):
        return

    db = SessionLocal()
    try:
        changed = False
        for store in db.query(models.Store).all():
            if store.client_id_encrypted and not str(store.client_id_encrypted).startswith(
                "enc:v1:"
            ):
                store.client_id = store.client_id_encrypted
                changed = True
            if store.api_key_encrypted and not str(store.api_key_encrypted).startswith(
                "enc:v1:"
            ):
                store.api_key = store.api_key_encrypted
                changed = True

        if _table_exists("user_cloud_follow_configs"):
            for config in db.query(models.UserCloudFollowConfig).all():
                if config.front_cookie_encrypted and not str(
                    config.front_cookie_encrypted
                ).startswith("enc:v1:"):
                    config.front_cookie = config.front_cookie_encrypted
                    changed = True
                if config.user_agent_encrypted and not str(
                    config.user_agent_encrypted
                ).startswith("enc:v1:"):
                    config.user_agent = config.user_agent_encrypted
                    changed = True

        if changed:
            db.commit()
    except Exception:
        db.rollback()
        raise
    finally:
        db.close()


def _initialize_runtime_database() -> None:
    if settings.AUTO_CREATE_SCHEMA:
        Base.metadata.create_all(bind=engine)
    _ensure_auth_schema()
    _ensure_tenant_schema()
    _ensure_store_owner_schema()
    _ensure_product_schema()
    _normalize_warehouse_labels()
    _encrypt_existing_sensitive_fields()
    _ensure_default_auth_user()
    _ensure_default_tenant_seed()


def _normalize_username(username: str) -> str:
    return str(username or "").strip()


def _normalize_display_name(display_name: Optional[str], username: str) -> str:
    value = str(display_name or "").strip()
    if value:
        return value[:80]
    normalized_username = _normalize_username(username)
    return normalized_username[:80] or "用户"


def _build_password_hash(password: str, salt: Optional[bytes] = None) -> str:
    salt_bytes = salt or secrets.token_bytes(16)
    digest = hashlib.pbkdf2_hmac(
        PASSWORD_HASH_ALGORITHM,
        password.encode("utf-8"),
        salt_bytes,
        PASSWORD_HASH_ITERATIONS,
    )
    salt_token = base64.urlsafe_b64encode(salt_bytes).decode("ascii").rstrip("=")
    digest_token = base64.urlsafe_b64encode(digest).decode("ascii").rstrip("=")
    return (
        f"pbkdf2_{PASSWORD_HASH_ALGORITHM}"
        f"${PASSWORD_HASH_ITERATIONS}"
        f"${salt_token}"
        f"${digest_token}"
    )


def _verify_password(password: str, password_hash: str) -> bool:
    try:
        scheme, iterations_text, salt_token, digest_token = str(password_hash).split(
            "$", 3
        )
        algorithm = scheme.removeprefix("pbkdf2_")
        iterations = int(iterations_text)
        salt = base64.urlsafe_b64decode(salt_token + "=" * (-len(salt_token) % 4))
        expected_digest = base64.urlsafe_b64decode(
            digest_token + "=" * (-len(digest_token) % 4)
        )
    except Exception:
        return False

    actual_digest = hashlib.pbkdf2_hmac(
        algorithm,
        password.encode("utf-8"),
        salt,
        iterations,
    )
    return hmac.compare_digest(actual_digest, expected_digest)


def _user_tenant(db: Session, user: models.User) -> Optional[models.Tenant]:
    if not user.primary_tenant_id:
        return None
    return (
        db.query(models.Tenant)
        .filter(models.Tenant.id == user.primary_tenant_id)
        .first()
    )


def _user_role_codes(
    db: Session,
    user: models.User,
    tenant_id: Optional[int] = None,
) -> List[str]:
    rows = (
        db.query(models.Role.code)
        .join(models.UserRole, models.UserRole.role_id == models.Role.id)
        .filter(models.UserRole.user_id == user.id)
        .all()
    )
    codes = {row[0] for row in rows if row and row[0]}
    if user.is_admin:
        codes.add("super_admin")
    if tenant_id:
        member = (
            db.query(models.TenantMember)
            .filter(
                models.TenantMember.user_id == user.id,
                models.TenantMember.tenant_id == tenant_id,
                models.TenantMember.status == "active",
            )
            .first()
        )
        if member and member.role:
            codes.add(member.role)
    return sorted(codes)


def _serialize_auth_user(user: models.User, db: Optional[Session] = None) -> Dict[str, Any]:
    tenant = _user_tenant(db, user) if db is not None else None
    tenant_id = tenant.id if tenant else user.primary_tenant_id
    roles = _user_role_codes(db, user, tenant_id) if db is not None else (
        ["super_admin"] if user.is_admin else []
    )
    return {
        "id": user.id,
        "username": user.username,
        "display_name": user.display_name,
        "email": user.email,
        "is_admin": bool(user.is_admin),
        "is_super_admin": bool(user.is_admin or "super_admin" in roles),
        "is_tenant_admin": "tenant_admin" in roles,
        "is_active": bool(user.is_active),
        "tenant_id": tenant_id,
        "tenant_name": tenant.name if tenant else None,
        "roles": roles,
    }


def _find_user_by_username(db: Session, username: str) -> Optional[models.User]:
    normalized_username = _normalize_username(username)
    if not normalized_username:
        return None
    return (
        db.query(models.User)
        .filter(models.User.username == normalized_username)
        .first()
    )


def _current_username(request: Request) -> str:
    username = _normalize_username(getattr(request.state, "current_user", ""))
    if not username:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Authentication required",
        )
    return username


def _current_user_id(request: Request) -> Optional[int]:
    value = getattr(request.state, "current_user_id", None)
    try:
        return int(value) if value is not None else None
    except (TypeError, ValueError):
        return None


def _current_tenant_id(request: Request) -> Optional[int]:
    value = getattr(request.state, "current_tenant_id", None)
    try:
        return int(value) if value is not None else None
    except (TypeError, ValueError):
        return None


def _request_tenant_id_or_user_primary(db: Session, request: Request, username: str) -> Optional[int]:
    tenant_id = _current_tenant_id(request)
    if tenant_id is not None:
        return tenant_id
    user = _find_user_by_username(db, username)
    return user.primary_tenant_id if user else None


def _cloud_follow_config_query(db: Session, username: str, tenant_id: Optional[int]):
    query = db.query(models.UserCloudFollowConfig).filter(
        models.UserCloudFollowConfig.username == username
    )
    if tenant_id is None:
        return query.filter(models.UserCloudFollowConfig.tenant_id.is_(None))
    return query.filter(models.UserCloudFollowConfig.tenant_id == tenant_id)


def _get_cloud_follow_config(
    db: Session,
    *,
    username: str,
    tenant_id: Optional[int],
) -> Optional[models.UserCloudFollowConfig]:
    return _cloud_follow_config_query(db, username, tenant_id).first()


def _serialize_cloud_follow_config(
    config: Optional[models.UserCloudFollowConfig],
) -> Dict[str, Any]:
    if not config:
        return {"front_cookie": None, "user_agent": None, "updated_at": None}
    return {
        "front_cookie": config.front_cookie or None,
        "user_agent": config.user_agent or None,
        "updated_at": config.updated_at,
    }


def _resolve_cloud_follow_session_config(
    db: Session,
    *,
    username: str,
    tenant_id: Optional[int],
    front_cookie: Optional[str],
    user_agent: Optional[str],
) -> tuple[Optional[str], Optional[str]]:
    saved = _get_cloud_follow_config(db, username=username, tenant_id=tenant_id)
    resolved_cookie = str(front_cookie or "").strip()
    resolved_user_agent = str(user_agent or "").strip()
    if not resolved_cookie and saved and saved.front_cookie:
        resolved_cookie = str(saved.front_cookie).strip()
    if not resolved_user_agent and saved and saved.user_agent:
        resolved_user_agent = str(saved.user_agent).strip()
    return resolved_cookie or None, resolved_user_agent or None


def _normalize_cloud_follow_text(value: Any) -> Optional[str]:
    text_value = str(value or "").strip()
    return text_value or None


def _serialize_cloud_follow_collect_task(
    task: models.CloudFollowCollectTask,
) -> Dict[str, Any]:
    return {
        "id": task.id,
        "tenant_id": task.tenant_id,
        "user_owner": task.user_owner,
        "store_id": task.store_id,
        "reference": task.reference,
        "resolved_product_id": task.resolved_product_id,
        "status": task.status,
        "include_variants": bool(task.include_variants),
        "max_variants": int(task.max_variants or 20),
        "price": task.price,
        "old_price": task.old_price,
        "follow_min_price": task.follow_min_price,
        "model": task.model,
        "source_url": task.source_url,
        "error": task.error,
        "upload_job_id": task.upload_job_id,
        "claimed_at": task.claimed_at,
        "completed_at": task.completed_at,
        "created_at": task.created_at,
        "updated_at": task.updated_at,
    }


def _cloud_follow_collect_task_scope(
    db: Session,
    *,
    username: str,
    tenant_id: Optional[int],
):
    query = db.query(models.CloudFollowCollectTask).filter(
        models.CloudFollowCollectTask.user_owner == username
    )
    if tenant_id is None:
        return query.filter(models.CloudFollowCollectTask.tenant_id.is_(None))
    return query.filter(models.CloudFollowCollectTask.tenant_id == tenant_id)


def _reset_stale_cloud_follow_collect_tasks(
    db: Session,
    *,
    username: str,
    tenant_id: Optional[int],
    older_than_minutes: int = 10,
) -> None:
    threshold = datetime.now(timezone.utc) - timedelta(minutes=older_than_minutes)
    stale_tasks = (
        _cloud_follow_collect_task_scope(db, username=username, tenant_id=tenant_id)
        .filter(
            models.CloudFollowCollectTask.status == "collecting",
            models.CloudFollowCollectTask.claimed_at.isnot(None),
            models.CloudFollowCollectTask.claimed_at < threshold,
        )
        .all()
    )
    if not stale_tasks:
        return
    for task in stale_tasks:
        task.status = "pending_collect"
        task.error = "collect_retry_timeout"
        task.claimed_at = None
    db.commit()


def _dedupe_cloud_follow_product_payloads(
    payloads: Iterable[Dict[str, Any]],
    limit: int,
) -> List[Dict[str, Any]]:
    result: List[Dict[str, Any]] = []
    seen: set[str] = set()
    for payload in payloads:
        if not isinstance(payload, dict):
            continue
        product_id = str(payload.get("productId") or payload.get("sku") or "").strip()
        if product_id and product_id in seen:
            continue
        if product_id:
            seen.add(product_id)
        result.append(payload)
        if len(result) >= limit:
            break
    return result


async def _build_upload_items_for_payloads(
    *,
    store: models.Store,
    source_payloads: List[Dict[str, Any]],
    price: Any = None,
    old_price: Any = None,
    min_price: Any = None,
    model: Optional[str] = None,
    concurrency: int = UPLOAD_BUILD_ITEM_CONCURRENCY,
) -> tuple[List[Dict[str, Any]], List[str]]:
    if not source_payloads:
        return [], []

    bounded_concurrency = max(1, min(int(concurrency or 1), len(source_payloads), 8))
    semaphore = asyncio.Semaphore(bounded_concurrency)

    async def build_one(index: int, source_payload: Dict[str, Any]) -> tuple[int, Optional[Dict[str, Any]], Optional[str]]:
        async with semaphore:
            try:
                prepared = await build_upload_item(
                    client_id=store.client_id,
                    api_key=store.api_key,
                    scraped_data=source_payload,
                    price=price,
                    old_price=old_price,
                    min_price=min_price,
                    model=model,
                )
                item = prepared.get("item")
                if isinstance(item, dict):
                    return index, item, None
                return index, None, "build_upload_item returned invalid item payload"
            except Exception as exc:
                return index, None, str(exc)

    results = await asyncio.gather(
        *(build_one(index, source_payload) for index, source_payload in enumerate(source_payloads))
    )
    items: List[Dict[str, Any]] = []
    build_errors: List[str] = []
    for _index, item, error in sorted(results, key=lambda entry: entry[0]):
        if item is not None:
            items.append(item)
        elif error:
            build_errors.append(error)
    return items, build_errors


async def _submit_cloud_follow_collect_task_payloads(
    *,
    db: Session,
    store: models.Store,
    task: models.CloudFollowCollectTask,
    product_payloads: List[Dict[str, Any]],
) -> models.UploadJob:
    normalized_limit = max(1, min(100, int(task.max_variants or 20)))
    source_payloads = _dedupe_cloud_follow_product_payloads(product_payloads, normalized_limit)
    if not source_payloads:
        raise HTTPException(status_code=400, detail="No product data was returned by extension")

    first_payload = source_payloads[0]
    shared_model = str(task.model or "").strip()
    if not shared_model:
        model_seed = str(first_payload.get("productId") or task.resolved_product_id or task.id)
        shared_model = f"M{model_seed}-{secrets.token_hex(3).upper()}"

    items, build_errors = await _build_upload_items_for_payloads(
        store=store,
        source_payloads=source_payloads,
        price=task.price,
        old_price=task.old_price,
        min_price=task.follow_min_price,
        model=shared_model,
    )

    if not items:
        raise HTTPException(
            status_code=400,
            detail=build_errors[0] if build_errors else "No uploadable items were built",
        )

    _validate_upload_items(items)
    local_task_id = f"cloud-follow-ext-{task.id}-{secrets.token_hex(4)}"
    extension_meta = {
        "collect_task_id": task.id,
        "reference": task.reference,
        "source_product_id": str(task.resolved_product_id or ""),
        "source_url": task.source_url,
        "title": str(first_payload.get("title") or ""),
        "variant_mode": "variants" if len(items) > 1 else "single",
        "collector": "extension",
    }
    return await _submit_upload_job(
        db=db,
        store=store,
        items=items,
        source="cloud_follow_extension",
        local_task_id=local_task_id,
        requested_store_id=store.id,
        extension_meta=extension_meta,
    )


def _request_role_codes(request: Request) -> List[str]:
    roles = getattr(request.state, "current_roles", []) or []
    return [str(role) for role in roles if role]


def _user_store_query(db: Session, username: str):
    user = _find_user_by_username(db, username)
    tenant_id = user.primary_tenant_id if user else None
    query = db.query(models.Store)
    if tenant_id is not None:
        query = query.filter(models.Store.tenant_id == tenant_id)
    else:
        query = query.filter(models.Store.user_owner == username)
    return query.order_by(models.Store.id.asc())


def _user_store_ids_query(db: Session, username: str):
    user = _find_user_by_username(db, username)
    tenant_id = user.primary_tenant_id if user else None
    query = db.query(models.Store.id)
    if tenant_id is not None:
        return query.filter(models.Store.tenant_id == tenant_id)
    return query.filter(models.Store.user_owner == username)


def _scope_query_to_user_stores(query, store_id_column: Any, db: Session, username: str):
    return query.filter(store_id_column.in_(_user_store_ids_query(db, username)))


def _store_tenant_id(db: Session, store_id: Optional[int]) -> Optional[int]:
    if store_id is None:
        return None
    row = db.query(models.Store.tenant_id).filter(models.Store.id == store_id).first()
    return row[0] if row else None


def _ensure_default_auth_user() -> None:
    if not _table_exists("users"):
        return

    db = SessionLocal()
    try:
        existing_count = db.query(models.User).count()
        if existing_count > 0:
            return

        default_username = _normalize_username(settings.ADMIN_USERNAME) or "admin"
        admin_password = str(settings.ADMIN_PASSWORD or "").strip()
        if not admin_password:
            logger.warning(
                "No default admin user was created because ADMIN_PASSWORD is not set. "
                "Set ADMIN_PASSWORD in the deployment environment before first startup."
            )
            return

        default_user = models.User(
            username=default_username,
            display_name="系统管理员",
            email=None,
            password_hash=_build_password_hash(admin_password),
            is_active=True,
            is_admin=True,
        )
        db.add(default_user)
        db.commit()
    finally:
        db.close()


def _get_or_create_default_tenant(db: Session) -> models.Tenant:
    tenant = (
        db.query(models.Tenant)
        .filter(models.Tenant.slug == DEFAULT_TENANT_SLUG)
        .first()
    )
    if tenant:
        return tenant
    tenant = models.Tenant(
        name="默认租户",
        slug=DEFAULT_TENANT_SLUG,
        status="active",
        plan_code="starter",
        subscription_status="active",
        store_limit=3,
        user_limit=10,
    )
    db.add(tenant)
    db.flush()
    return tenant


def _get_or_create_role(
    db: Session,
    code: str,
    name: str,
    scope: str,
    tenant_id: Optional[int] = None,
    is_system: bool = True,
) -> models.Role:
    query = db.query(models.Role).filter(
        models.Role.code == code,
        models.Role.scope == scope,
    )
    if tenant_id is None:
        query = query.filter(models.Role.tenant_id.is_(None))
    else:
        query = query.filter(models.Role.tenant_id == tenant_id)
    role = query.first()
    if role:
        return role
    role = models.Role(
        code=code,
        name=name,
        scope=scope,
        tenant_id=tenant_id,
        is_system=is_system,
    )
    db.add(role)
    db.flush()
    return role


def _ensure_role_permission(
    db: Session,
    role: models.Role,
    permission: models.Permission,
) -> None:
    exists = (
        db.query(models.RolePermission)
        .filter(
            models.RolePermission.role_id == role.id,
            models.RolePermission.permission_id == permission.id,
        )
        .first()
    )
    if not exists:
        db.add(models.RolePermission(role_id=role.id, permission_id=permission.id))


def _ensure_user_role(
    db: Session,
    user: models.User,
    role: models.Role,
    tenant_id: Optional[int] = None,
) -> None:
    exists = (
        db.query(models.UserRole)
        .filter(
            models.UserRole.user_id == user.id,
            models.UserRole.role_id == role.id,
            models.UserRole.tenant_id == tenant_id,
        )
        .first()
    )
    if not exists:
        db.add(models.UserRole(user_id=user.id, role_id=role.id, tenant_id=tenant_id))


def _ensure_tenant_member(
    db: Session,
    tenant_id: int,
    user_id: int,
    role: str,
) -> None:
    member = (
        db.query(models.TenantMember)
        .filter(
            models.TenantMember.tenant_id == tenant_id,
            models.TenantMember.user_id == user_id,
        )
        .first()
    )
    if member:
        if member.role != role:
            member.role = role
        member.status = "active"
        return
    db.add(
        models.TenantMember(
            tenant_id=tenant_id,
            user_id=user_id,
            role=role,
            status="active",
        )
    )


def _ensure_default_tenant_seed() -> None:
    if not _table_exists("tenants") or not _table_exists("users"):
        return

    db = SessionLocal()
    try:
        tenant = _get_or_create_default_tenant(db)
        permissions_by_code: Dict[str, models.Permission] = {}
        for code, name, group in SYSTEM_PERMISSIONS:
            permission = (
                db.query(models.Permission)
                .filter(models.Permission.code == code)
                .first()
            )
            if not permission:
                permission = models.Permission(code=code, name=name, group=group)
                db.add(permission)
                db.flush()
            permissions_by_code[code] = permission

        for code, title, path, parent_code, sort_order, required_permission, is_admin in SYSTEM_MENUS:
            menu = db.query(models.Menu).filter(models.Menu.code == code).first()
            if not menu:
                menu = models.Menu(code=code, title=title)
                db.add(menu)
            menu.title = title
            menu.path = path
            menu.parent_code = parent_code
            menu.sort_order = sort_order
            menu.required_permission = required_permission
            menu.is_admin = is_admin
            menu.is_active = True

        super_admin_role = _get_or_create_role(
            db, "super_admin", "Super Admin", "admin", None, True
        )
        tenant_admin_role = _get_or_create_role(
            db, "tenant_admin", "Tenant Admin", "tenant", tenant.id, True
        )
        user_role = _get_or_create_role(db, "user", "User", "tenant", tenant.id, True)

        for permission in permissions_by_code.values():
            _ensure_role_permission(db, super_admin_role, permission)
        for code in ("app:read", "stores:manage"):
            _ensure_role_permission(db, tenant_admin_role, permissions_by_code[code])
        _ensure_role_permission(db, user_role, permissions_by_code["app:read"])

        users = db.query(models.User).all()
        for user in users:
            if not user.primary_tenant_id:
                user.primary_tenant_id = tenant.id
            role_name = "super_admin" if user.is_admin else "tenant_admin"
            _ensure_tenant_member(db, tenant.id, user.id, role_name)
            if user.is_admin:
                _ensure_user_role(db, user, super_admin_role, None)
            _ensure_user_role(
                db,
                user,
                tenant_admin_role if not user.is_admin else tenant_admin_role,
                tenant.id,
            )

        if _table_exists("stores"):
            db.execute(
                text(
                    """
                    UPDATE stores
                    SET tenant_id = :tenant_id
                    WHERE tenant_id IS NULL
                    """
                ),
                {"tenant_id": tenant.id},
            )
        for table_name in ("upload_jobs", "upload_job_items", "products", "order_records"):
            if _table_exists(table_name):
                db.execute(
                    text(
                        f"""
                        UPDATE {table_name}
                        SET tenant_id = (
                            SELECT stores.tenant_id
                            FROM stores
                            WHERE stores.id = {table_name}.store_id
                        )
                        WHERE tenant_id IS NULL
                        """
                    )
                )
        if _table_exists("pricing_templates"):
            db.execute(
                text(
                    """
                    UPDATE pricing_templates
                    SET tenant_id = :tenant_id
                    WHERE tenant_id IS NULL
                    """
                ),
                {"tenant_id": tenant.id},
            )

        if not db.query(models.Subscription).filter(models.Subscription.tenant_id == tenant.id).first():
            db.add(
                models.Subscription(
                    tenant_id=tenant.id,
                    plan_code="starter",
                    status="active",
                )
            )
        if not db.query(models.TenantPlan).filter(models.TenantPlan.tenant_id == tenant.id).first():
            db.add(
                models.TenantPlan(
                    tenant_id=tenant.id,
                    plan_code="starter",
                    name="Starter",
                    billing_cycle="monthly",
                    price=0.0,
                    store_limit=tenant.store_limit,
                    user_limit=tenant.user_limit,
                    status="active",
                )
            )
        if not db.query(models.StoreQuota).filter(models.StoreQuota.tenant_id == tenant.id).first():
            db.add(
                models.StoreQuota(
                    tenant_id=tenant.id,
                    max_stores=tenant.store_limit,
                    max_daily_create=250,
                    max_daily_update=5000,
                    max_total_products=8000,
                )
            )
        db.commit()
    finally:
        db.close()


def _can_run_local_bootstrap() -> bool:
    return all(
        _table_exists(table_name)
        for table_name in (
            "stores",
            "upload_jobs",
            "products",
            "order_records",
            "pricing_templates",
        )
    )


def _chrome_devtools_targets() -> List[Dict[str, Any]]:
    try:
        with httpx.Client(timeout=5.0, trust_env=False) as client:
            response = client.get(f"{CHROME_DEVTOOLS_BASE}/json/list")
            response.raise_for_status()
            payload = response.json()
    except Exception as exc:
        raise HTTPException(
            status_code=400,
            detail=f"无法连接 Chrome 调试端点 {CHROME_DEVTOOLS_BASE}: {exc}",
        ) from exc

    if not isinstance(payload, list):
        raise HTTPException(
            status_code=400,
            detail=f"Chrome 调试端点 {CHROME_DEVTOOLS_BASE} 返回了异常数据",
        )
    return payload


def _pick_seller_target(preferred_url_fragment: Optional[str] = None) -> Dict[str, Any]:
    targets = _chrome_devtools_targets()
    pages = [
        item
        for item in targets
        if item.get("type") == "page"
        and "seller.ozon.ru/app/" in str(item.get("url") or "")
        and item.get("webSocketDebuggerUrl")
    ]
    if not pages:
        raise HTTPException(
            status_code=400,
            detail="没有找到已打开的 Ozon Seller 页面，请先在 Chrome 中打开 seller.ozon.ru",
        )

    if preferred_url_fragment:
        for page in pages:
            if preferred_url_fragment in str(page.get("url") or ""):
                return page
        raise HTTPException(
            status_code=400,
            detail=f"没有找到已打开的 Seller 页面: {preferred_url_fragment}",
        )

    for page in pages:
        if "seller.ozon.ru/app/crossborder/warehouse" in str(page.get("url") or ""):
            return page
    return pages[0]


def _pick_ozon_buyer_target(preferred_url_fragment: Optional[str] = None) -> Dict[str, Any]:
    targets = _chrome_devtools_targets()
    pages = [
        item
        for item in targets
        if item.get("type") == "page"
        and "ozon.ru/" in str(item.get("url") or "")
        and "seller.ozon.ru/" not in str(item.get("url") or "")
        and item.get("webSocketDebuggerUrl")
    ]
    if not pages:
        raise HTTPException(
            status_code=400,
            detail="No open Ozon buyer page was found in Chrome. Open www.ozon.ru once, then retry.",
        )

    if preferred_url_fragment:
        for page in pages:
            if preferred_url_fragment in str(page.get("url") or ""):
                return page

    for page in pages:
        if "/product/" in str(page.get("url") or ""):
            return page
    return pages[0]


def _resolve_ozon_product_reference(reference: Any) -> tuple[int, str]:
    normalized = str(reference or "").strip()
    if not normalized:
        raise HTTPException(status_code=400, detail="reference is required")

    resolved_product_id = extract_ozon_frontend_product_id(normalized)
    if not resolved_product_id and normalized.isdigit():
        numeric_id = int(normalized)
        if numeric_id >= 100000:
            resolved_product_id = numeric_id

    if not resolved_product_id:
        raise HTTPException(
            status_code=400,
            detail="Unable to resolve product id from reference. Provide an Ozon product link or SKU/product id.",
        )

    source_url = normalized
    if not source_url.startswith("http://") and not source_url.startswith("https://"):
        source_url = f"{OZON_BUYER_ORIGIN}/product/{resolved_product_id}/"
    return int(resolved_product_id), source_url


def _ozon_entrypoint_paths(product_id: int) -> List[str]:
    product_path = f"/product/{int(product_id)}/"
    return [
        product_path,
        f"{product_path}?layout_container=pdpPage2column&layout_page_index=2",
    ]


async def _fetch_ozon_entrypoint_payloads_via_cookie(
    product_id: int,
    *,
    front_cookie: str,
    user_agent: Optional[str] = None,
) -> Dict[str, Any]:
    cookie_value = str(front_cookie or "").strip()
    if not cookie_value:
        raise HTTPException(status_code=400, detail="front_cookie is required for cookie mode")

    headers = {
        "accept": "application/json",
        "cookie": cookie_value,
        "referer": f"{OZON_BUYER_ORIGIN}/product/{int(product_id)}/",
    }
    if user_agent:
        headers["user-agent"] = str(user_agent).strip()

    async with httpx.AsyncClient(timeout=20.0, follow_redirects=True, trust_env=False) as client:
        async def fetch_path(path: str) -> Dict[str, Any]:
            endpoint = (
                f"{OZON_BUYER_ORIGIN}/api/entrypoint-api.bx/page/json/v2?url="
                f"{quote(path, safe='')}"
            )
            try:
                response = await client.get(endpoint, headers=headers)
            except Exception as exc:
                raise HTTPException(
                    status_code=502,
                    detail=f"Ozon frontend request failed for {path}: {exc}",
                ) from exc

            if not response.is_success:
                sample = response.text[:300]
                normalized_sample = sample.lower()
                if response.status_code == 403 and (
                    "antibot challenge page" in normalized_sample
                    or "abt-complaints" in normalized_sample
                    or "<title>antibot challenge page</title>" in normalized_sample
                ):
                    raise HTTPException(
                        status_code=502,
                        detail=(
                            "Ozon cookie session hit Antibot challenge (403). "
                            "Refresh your Front Cookie/User-Agent from a logged-in Ozon buyer page."
                        ),
                    )
                raise HTTPException(
                    status_code=502,
                    detail=(
                        f"Ozon frontend request rejected for {path}: "
                        f"status={response.status_code}, body={sample}"
                    ),
                )
            try:
                payload = response.json()
            except Exception as exc:
                raise HTTPException(
                    status_code=502,
                    detail=f"Ozon frontend returned invalid JSON for {path}",
                ) from exc

            if not isinstance(payload, dict):
                raise HTTPException(
                    status_code=502,
                    detail=f"Ozon frontend returned unexpected payload type for {path}",
                )
            return payload

        payloads = await asyncio.gather(
            *(fetch_path(path) for path in _ozon_entrypoint_paths(product_id))
        )

    return {
        "payloads": list(payloads),
        "page_url": f"{OZON_BUYER_ORIGIN}/product/{int(product_id)}/",
        "source": "front_cookie",
    }


def _fetch_ozon_entrypoint_payloads_from_browser(
    product_id: int,
    *,
    preferred_url_fragment: Optional[str] = None,
) -> Dict[str, Any]:
    target = _pick_ozon_buyer_target(preferred_url_fragment=preferred_url_fragment)
    paths_literal = json.dumps(_ozon_entrypoint_paths(product_id), ensure_ascii=False)
    script = f"""
    (async () => {{
      const paths = {paths_literal};
      const payloads = [];
      for (const path of paths) {{
        try {{
          const response = await fetch(`/api/entrypoint-api.bx/page/json/v2?url=${{encodeURIComponent(path)}}`, {{
            method: 'GET',
            credentials: 'include',
            headers: {{ accept: 'application/json' }},
            cache: 'no-store'
          }});
          const text = await response.text();
          let data = null;
          try {{
            data = JSON.parse(text);
          }} catch (error) {{
            data = null;
          }}
          if (!response.ok || !data) {{
            return JSON.stringify({{
              ok: false,
              status: response.status,
              path,
              error: text.slice(0, 1200)
            }});
          }}
          payloads.push(data);
        }} catch (error) {{
          return JSON.stringify({{
            ok: false,
            path,
            error: String(error)
          }});
        }}
      }}
      return JSON.stringify({{
        ok: true,
        payloads,
        pageUrl: location.href
      }});
    }})()
    """
    raw_payload = _chrome_runtime_evaluate(target, script, await_promise=True)
    try:
        parsed = json.loads(str(raw_payload or "{}"))
    except Exception as exc:
        raise HTTPException(
            status_code=502,
            detail=f"Failed to parse browser payload: {exc}",
        ) from exc

    if not isinstance(parsed, dict) or not parsed.get("ok"):
        if isinstance(parsed, dict):
            status_code = _safe_int(parsed.get("status"), 0)
            error_text = str(parsed.get("error") or "")
            normalized = error_text.lower()
            if status_code == 403 and (
                "antibot challenge page" in normalized
                or "abt-complaints" in normalized
                or "<title>antibot challenge page</title>" in normalized
            ):
                raise HTTPException(
                    status_code=502,
                    detail=(
                        "Ozon browser session hit Antibot challenge (403). "
                        "Open https://www.ozon.ru in cloud Chrome and complete the challenge/login, "
                        "or configure Front Cookie + User-Agent."
                    ),
                )
            compact_error = error_text[:260] if error_text else ""
            raise HTTPException(
                status_code=502,
                detail=(
                    "Browser frontend fetch failed: "
                    f"status={status_code or 'unknown'}, path={parsed.get('path')}, error={compact_error}"
                ),
            )
        raise HTTPException(
            status_code=502,
            detail=f"Browser frontend fetch failed: {parsed}",
        )
    payloads = parsed.get("payloads")
    if not isinstance(payloads, list) or not payloads:
        raise HTTPException(
            status_code=502,
            detail="Browser frontend fetch returned empty payload list",
        )
    return {
        "payloads": payloads,
        "page_url": str(parsed.get("pageUrl") or target.get("url") or ""),
        "source": "browser_session",
    }


async def _fetch_ozon_entrypoint_payloads(
    product_id: int,
    *,
    front_cookie: Optional[str],
    user_agent: Optional[str],
    use_browser_session: bool,
    preferred_url_fragment: Optional[str],
) -> Dict[str, Any]:
    if front_cookie:
        try:
            return await _fetch_ozon_entrypoint_payloads_via_cookie(
                product_id,
                front_cookie=front_cookie,
                user_agent=user_agent,
            )
        except HTTPException:
            if not use_browser_session:
                raise

    if use_browser_session:
        return await asyncio.to_thread(
            _fetch_ozon_entrypoint_payloads_from_browser,
            product_id,
            preferred_url_fragment=preferred_url_fragment,
        )

    raise HTTPException(
        status_code=400,
        detail="No usable frontend session source. Provide front_cookie or enable browser session mode.",
    )


def _chrome_runtime_evaluate(
    target: Dict[str, Any], expression: str, *, await_promise: bool = False
) -> Any:
    websocket_url = str(target.get("webSocketDebuggerUrl") or "")
    if not websocket_url:
        raise HTTPException(status_code=400, detail="Chrome 页面缺少调试 WebSocket 地址")

    connection = None
    message_id = 0
    try:
        connection = create_connection(websocket_url, timeout=120, suppress_origin=True)

        def send(method: str, params: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
            nonlocal message_id
            message_id += 1
            connection.send(
                json.dumps(
                    {"id": message_id, "method": method, "params": params or {}},
                    ensure_ascii=False,
                )
            )
            while True:
                payload = json.loads(connection.recv())
                if payload.get("id") != message_id:
                    continue
                if payload.get("error"):
                    raise HTTPException(
                        status_code=400,
                        detail=f"Chrome 调试执行失败: {payload['error']}",
                    )
                return payload.get("result", {})

        send("Runtime.enable")
        result = send(
            "Runtime.evaluate",
            {
                "expression": expression,
                "awaitPromise": await_promise,
                "returnByValue": True,
            },
        )
    except HTTPException:
        raise
    except Exception as exc:
        raise HTTPException(status_code=400, detail=f"Chrome 调试连接失败: {exc}") from exc
    finally:
        if connection is not None:
            try:
                connection.close()
            except Exception:
                pass

    remote = result.get("result", {})
    if "value" in remote:
        return remote.get("value")
    if result.get("exceptionDetails"):
        raise HTTPException(status_code=400, detail="Chrome 页面脚本执行异常")
    return None


def _fetch_seller_warehouses_from_browser() -> Dict[str, Any]:
    target = _pick_seller_target()
    script = """
    (async () => {
      const companyId = Number((document.cookie.match(/(?:^|; )sc_company_id=(\\d+)/) || [])[1] || 0)
      if (!companyId) {
        return JSON.stringify({
          ok: false,
          error: '当前 Seller 页面缺少 sc_company_id cookie',
          sellerUrl: location.href,
        })
      }
      try {
        const response = await fetch('/api/site/logistic-service/v5/facade/warehouse/list', {
          method: 'POST',
          credentials: 'include',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ companyId }),
        })
        const text = await response.text()
        let data = null
        try {
          data = JSON.parse(text)
        } catch (error) {
          data = null
        }
        return JSON.stringify({
          ok: response.ok,
          status: response.status,
          companyId,
          sellerUrl: location.href,
          data,
          text: response.ok ? '' : text.slice(0, 1200),
        })
      } catch (error) {
        return JSON.stringify({
          ok: false,
          error: String(error),
          companyId,
          sellerUrl: location.href,
        })
      }
    })()
    """
    raw_payload = _chrome_runtime_evaluate(target, script, await_promise=True)
    try:
        payload = json.loads(str(raw_payload or "{}"))
    except Exception as exc:
        raise HTTPException(status_code=400, detail=f"Seller 页面返回了无法解析的数据: {exc}") from exc

    if not payload.get("ok"):
        detail = payload.get("text") or payload.get("error") or "Seller 仓库接口调用失败"
        raise HTTPException(status_code=400, detail=detail)

    company_id = int(payload.get("companyId") or 0)
    if company_id <= 0:
        raise HTTPException(status_code=400, detail="Seller 页面没有返回有效 companyId")

    warehouse_rows = payload.get("data", {}).get("warehouses") or []
    warehouses: List[Dict[str, Any]] = []
    for row in warehouse_rows:
        if not isinstance(row, dict):
            continue
        warehouse_id = int(row.get("warehouseId") or 0)
        name = str(row.get("name") or "").strip()
        if warehouse_id <= 0 or not name:
            continue

        address_data = row.get("address") or {}
        address_parts = [
            str(address_data.get(key) or "").strip()
            for key in ("country", "region", "city", "street", "house", "building")
        ]
        warehouses.append(
            {
                "warehouse_id": warehouse_id,
                "name": name,
                "status": str(row.get("status") or "").strip() or None,
                "status_lms": str(row.get("statusLms") or "").strip() or None,
                "city": str(address_data.get("city") or "").strip() or None,
                "address": ", ".join(part for part in address_parts if part) or None,
            }
        )

    if not warehouses:
        raise HTTPException(status_code=400, detail="当前 Seller 页面没有返回仓库列表")

    return {
        "company_id": company_id,
        "seller_url": str(payload.get("sellerUrl") or target.get("url") or ""),
        "warehouses": warehouses,
    }


def _normalize_product_market_period(period: Optional[str]) -> str:
    normalized = str(period or "").strip().lower()
    alias_map = {
        "7d": "weekly",
        "7_days": "weekly",
        "week": "weekly",
        "weekly": "weekly",
        "28d": "monthly",
        "28_days": "monthly",
        "month": "monthly",
        "monthly": "monthly",
    }
    return alias_map.get(normalized, "weekly")


def _normalize_market_match_text(value: Any) -> str:
    return " ".join(str(value or "").strip().lower().split())


def _seller_product_market_cache_key(product: models.Product, period: str) -> str:
    return json.dumps(
        {
            "scope": "seller_product_market",
            "tenant_id": product.tenant_id,
            "store_id": product.store_id,
            "product_id": product.id,
            "sku": str(product.sku or "").strip(),
            "article_no": str(product.article_no or "").strip(),
            "product_name": str(product.product_name or "").strip(),
            "period": _normalize_product_market_period(period),
        },
        ensure_ascii=False,
        sort_keys=True,
    )


def _select_product_market_item(
    product: models.Product, items: Sequence[Dict[str, Any]]
) -> tuple[Optional[Dict[str, Any]], Optional[str]]:
    product_sku = _normalize_market_match_text(product.sku)
    product_article = _normalize_market_match_text(product.article_no)
    product_name = _normalize_market_match_text(product.product_name)
    best_item: Optional[Dict[str, Any]] = None
    best_mode: Optional[str] = None
    best_score = 0

    for item in items:
        if not isinstance(item, dict):
            continue

        item_name = _normalize_market_match_text(item.get("name"))
        item_article = _normalize_market_match_text(item.get("article"))
        item_sku_candidates = {
            _normalize_market_match_text(item.get("sku")),
            _normalize_market_match_text(item.get("variantId")),
        }

        score = 0
        mode: Optional[str] = None
        if product_sku and product_sku in item_sku_candidates:
            score = 400
            mode = "sku"
        elif product_article and product_article == item_article:
            score = 300
            mode = "article"
        elif product_name and product_name == item_name:
            score = 200
            mode = "name"
        elif product_name and item_name and product_name in item_name:
            score = 100
            mode = "name_fuzzy"

        if score > best_score:
            best_score = score
            best_mode = mode
            best_item = item

    return best_item, best_mode


def _serialize_product_market_item(item: Dict[str, Any]) -> Dict[str, Any]:
    return {
        "variant_id": _safe_int(item.get("variantId"), 0) or None,
        "sku": str(item.get("sku") or "").strip() or None,
        "seller_id": _safe_int(item.get("sellerId"), 0) or None,
        "article": str(item.get("article") or "").strip() or None,
        "link": str(item.get("link") or "").strip() or None,
        "name": str(item.get("name") or "").strip() or None,
        "brand": str(item.get("brand") or "").strip() or None,
        "photo": str(item.get("photo") or "").strip() or None,
        "seller_name": str(item.get("sellerName") or "").strip() or None,
        "sales_schema": str(item.get("salesSchema") or "").strip() or None,
        "category_1": str(item.get("category1") or "").strip() or None,
        "category_3": str(item.get("category3") or "").strip() or None,
        "sold_sum": round(_safe_float(item.get("soldSum"), 0.0), 2),
        "sold_count": _safe_int(item.get("soldCount"), 0),
        "gmv_sum": round(_safe_float(item.get("gmvSum"), 0.0), 2),
        "avg_gmv": round(_safe_float(item.get("avgGmv"), 0.0), 2),
        "sales_dynamics": round(_safe_float(item.get("salesDynamics"), 0.0), 2),
        "session_count": _safe_int(item.get("sessionCount"), 0),
        "session_count_search": _safe_int(item.get("sessionCountSearch"), 0),
        "qty_view_pdp": _safe_int(item.get("qtyViewPdp"), 0),
        "views": _safe_int(item.get("views"), 0),
        "conv_to_cart": round(_safe_float(item.get("convToCart"), 0.0), 2),
        "conv_to_cart_pdp": round(_safe_float(item.get("convToCartPdp"), 0.0), 2),
        "conv_to_cart_search": round(_safe_float(item.get("convToCartSearch"), 0.0), 2),
        "conv_view_to_order": round(_safe_float(item.get("convViewToOrder"), 0.0), 2),
        "avg_price": round(_safe_float(item.get("avgPrice"), 0.0), 2),
        "min_seller_price": round(_safe_float(item.get("minSellerPrice"), 0.0), 2),
        "discount": round(_safe_float(item.get("discount"), 0.0), 2),
        "drr": round(_safe_float(item.get("drr"), 0.0), 2),
        "stock": _safe_int(item.get("stock"), 0),
        "fbs_stock": _safe_int(item.get("fbsStock"), 0),
        "fbo_stock": _safe_int(item.get("fboStock"), 0),
        "cb_stock": _safe_int(item.get("cbStock"), 0),
        "retail_stock": _safe_int(item.get("retailStock"), 0),
        "accessibility": round(_safe_float(item.get("accessibility"), 0.0), 2),
        "accessibility_by_days": round(_safe_float(item.get("accessibilityByDays"), 0.0), 2),
        "days_in_stock": _safe_int(item.get("daysInStock"), 0),
        "sum_missed_gmv": round(_safe_float(item.get("sumMissedGmv"), 0.0), 2),
        "days_in_promo": _safe_int(item.get("daysInPromo"), 0),
        "promo_revenue_share": round(_safe_float(item.get("promoRevenueShare"), 0.0), 2),
        "days_with_trafarets": _safe_int(item.get("daysWithTrafarets"), 0),
        "bin": str(item.get("bin") or "").strip() or None,
        "avg_delivery_days": round(_safe_float(item.get("avgDeliveryDays"), 0.0), 2),
        "avg_delivery_time": round(_safe_float(item.get("avgDeliveryTime"), 0.0), 2),
        "nullable_redemption_rate": round(_safe_float(item.get("nullableRedemptionRate"), 0.0), 2),
        "nullable_create_date": str(item.get("nullableCreateDate") or "").strip() or None,
    }


def _fetch_product_market_insights_from_browser(
    product: models.Product, period: str = "weekly"
) -> Dict[str, Any]:
    normalized_period = _normalize_product_market_period(period)
    cache_key = _seller_product_market_cache_key(product, normalized_period)
    with SELLER_PRODUCT_MARKET_CACHE_LOCK:
        cached_entry = SELLER_PRODUCT_MARKET_CACHE.get(cache_key)
    if cached_entry and time.time() - cached_entry[0] <= SELLER_PRODUCT_MARKET_CACHE_TTL_SECONDS:
        return cached_entry[1]

    try:
        target = _pick_seller_target("seller.ozon.ru/app/analytics/what-to-sell/ozon-bestsellers")
    except HTTPException:
        target = _pick_seller_target()

    request_filter = {
        "period": normalized_period,
        "sku": str(product.sku or "").strip() or None,
        "name": str(product.product_name or "").strip() or None,
    }

    script = """
    (async () => {
      const input = __REQUEST_INPUT__
      const companyId = Number((document.cookie.match(/(?:^|; )sc_company_id=(\\d+)/) || [])[1] || 0)
      if (!companyId) {
        return JSON.stringify({
          ok: false,
          error: '当前 Seller 页面缺少 sc_company_id cookie',
          sellerUrl: location.href,
        })
      }

      const filter = {
        stock: 'any_stock',
        period: input.period || 'weekly',
      }
      if (input.sku) {
        filter.sku = input.sku
      } else if (input.name) {
        filter.name = input.name
      }

      try {
        const response = await fetch('/api/site/seller-analytics/what_to_sell/data/v3', {
          method: 'POST',
          credentials: 'include',
          headers: {
            'accept': 'application/json, text/plain, */*',
            'content-type': 'application/json',
            'x-o3-app-name': 'seller-ui',
            'x-o3-company-id': String(companyId),
            'x-o3-language': document.documentElement.lang || 'zh-Hans',
            'x-o3-page-type': 'analytics_platform',
          },
          body: JSON.stringify({
            limit: '20',
            offset: '0',
            filter,
            sort: { key: 'sum_gmv_desc' },
          }),
        })
        const text = await response.text()
        let data = null
        try {
          data = JSON.parse(text)
        } catch (error) {
          data = null
        }
        return JSON.stringify({
          ok: response.ok,
          status: response.status,
          companyId,
          sellerUrl: location.href,
          query: filter,
          data,
          text: response.ok ? '' : text.slice(0, 1200),
        })
      } catch (error) {
        return JSON.stringify({
          ok: false,
          error: String(error),
          companyId,
          sellerUrl: location.href,
          query: filter,
        })
      }
    })()
    """
    script = script.replace("__REQUEST_INPUT__", json.dumps(request_filter, ensure_ascii=False))
    raw_payload = _chrome_runtime_evaluate(target, script, await_promise=True)
    try:
        payload = json.loads(str(raw_payload or "{}"))
    except Exception as exc:
        raise HTTPException(status_code=400, detail=f"Seller 页面返回了无法解析的数据: {exc}") from exc

    if not payload.get("ok"):
        detail = payload.get("text") or payload.get("error") or "Seller 商品市场分析接口调用失败"
        raise HTTPException(status_code=400, detail=detail)

    response_data = payload.get("data") or {}
    raw_items = response_data.get("items") or []
    items = [item for item in raw_items if isinstance(item, dict)]
    matched_item, matched_by = _select_product_market_item(product, items)
    result = {
        "matched": matched_item is not None,
        "matched_by": matched_by,
        "period": normalized_period,
        "update_date": str(response_data.get("updateDate") or "").strip() or None,
        "total": _safe_int(response_data.get("totals"), len(items)),
        "source_url": str(payload.get("sellerUrl") or target.get("url") or ""),
        "query": {
            "sku": request_filter["sku"],
            "name": None if request_filter["sku"] else request_filter["name"],
            "article_no": str(product.article_no or "").strip() or None,
            "period": normalized_period,
            "candidate_count": len(items),
            "request_filter": payload.get("query") if isinstance(payload.get("query"), dict) else request_filter,
        },
        "benchmark": response_data.get("benchmark") if isinstance(response_data.get("benchmark"), dict) else {},
        "item": _serialize_product_market_item(matched_item) if matched_item else None,
    }
    with SELLER_PRODUCT_MARKET_CACHE_LOCK:
        SELLER_PRODUCT_MARKET_CACHE[cache_key] = (time.time(), result)
    return result


def _normalize_market_drill_path(path_ids: Optional[Sequence[int]]) -> List[int]:
    normalized: List[int] = []
    for value in path_ids or []:
        category_id = _safe_int(value, 0)
        if category_id > 0:
            normalized.append(category_id)
        if len(normalized) >= 2:
            break
    return normalized


def _normalize_market_period(period: Optional[str]) -> str:
    normalized = str(period or "").strip().lower()
    if normalized in {"7_days", "28_days", "quarter", "year"}:
        return normalized
    return "28_days"


def _fetch_seller_market_category_trends_from_browser(
    path_ids: Optional[Sequence[int]] = None,
    period: str = "28_days",
    tenant_id: Optional[int] = None,
) -> Dict[str, Any]:
    drill_path = _normalize_market_drill_path(path_ids)
    normalized_period = _normalize_market_period(period)
    cache_key = _seller_market_trends_cache_key(drill_path, normalized_period, tenant_id)
    cached_entry = SELLER_MARKET_TRENDS_CACHE.get(cache_key)
    if cached_entry and time.time() - cached_entry[0] <= SELLER_MARKET_TRENDS_CACHE_TTL_SECONDS:
        return cached_entry[1]
    disk_cache_entry = _load_seller_market_trends_disk_cache(cache_key)
    if disk_cache_entry and _is_seller_market_trends_disk_cache_fresh(float(disk_cache_entry["cachedAt"])):
        return disk_cache_entry["result"]
    fallback_result = disk_cache_entry["result"] if disk_cache_entry else None
    try:
        target = _pick_seller_target("seller.ozon.ru/app/analytics/what-to-sell/categories-comparison")
    except HTTPException:
        try:
            target = _pick_seller_target()
        except HTTPException:
            if fallback_result is not None:
                return fallback_result
            raise

    seller_company_id = _seller_company_id_from_target(target)
    if seller_company_id:
        scoped_cache_key = _seller_market_trends_cache_key(
            drill_path,
            normalized_period,
            tenant_id,
            seller_company_id=seller_company_id,
        )
        scoped_cached_entry = SELLER_MARKET_TRENDS_CACHE.get(scoped_cache_key)
        if scoped_cached_entry and time.time() - scoped_cached_entry[0] <= SELLER_MARKET_TRENDS_CACHE_TTL_SECONDS:
            return scoped_cached_entry[1]
        scoped_disk_cache_entry = _load_seller_market_trends_disk_cache(scoped_cache_key)
        if scoped_disk_cache_entry and _is_seller_market_trends_disk_cache_fresh(float(scoped_disk_cache_entry["cachedAt"])):
            return scoped_disk_cache_entry["result"]
        fallback_result = scoped_disk_cache_entry["result"] if scoped_disk_cache_entry else fallback_result
        cache_key = scoped_cache_key

    script = """
    (async () => {
      const requestedPath = __REQUESTED_PATH__
      const companyId = Number((document.cookie.match(/(?:^|; )sc_company_id=(\\d+)/) || [])[1] || 0)
      if (!companyId) {
        return JSON.stringify({
          ok: false,
          error: '当前 Seller 页面缺少 sc_company_id cookie',
          sellerUrl: location.href,
        })
      }

      const searchParams = new URLSearchParams(location.search)
      const pageCategoryPath = (searchParams.get('category') || '')
        .split('_')
        .map((part) => Number(part))
        .filter((part) => Number.isFinite(part) && part > 0)
      const periodValue = searchParams.get('period') || '28_days'
      const periodMap = {
        '7_days': { api: 'period_week', slice: 'slice_day', label: '7天' },
        '28_days': { api: 'period_month', slice: 'slice_day', label: '28天' },
        quarter: { api: 'period_quarter', slice: 'slice_week', label: '季度' },
        year: { api: 'period_year', slice: 'slice_month', label: '年' },
      }
      const periodMeta = periodMap[periodValue] || periodMap['28_days']
      const scopeButtonText = [...document.querySelectorAll('button')]
        .map((button) => (button.innerText || '').replace(/\\s+/g, ' ').trim())
        .find((text) =>
          text.startsWith('类目:') ||
          text.startsWith('Категория:') ||
          text.startsWith('Category:')
        )
      const scopeLabel = scopeButtonText
        ? scopeButtonText.split(':').slice(1).join(':').trim()
        : ''
      const effectivePath = requestedPath.length
        ? requestedPath
        : (pageCategoryPath.length >= 2 ? [pageCategoryPath[1]] : [])
      const currentLevel = Math.min(effectivePath.length + 1, 3)
      const group = `group_category${currentLevel}`
      let basePathLabel = ''
      let rootOptions = []

      try {
        const html = await fetch(location.pathname + location.search, {
          credentials: 'include',
        }).then((response) => response.text())
        const level1Regex = /\\\"id\\\":\\\"(\\d+)\\\",\\\"concatenatedId\\\":\\\"_[^\\\"]*\\\",\\\"name\\\":\\\"([^\\\"]+)\\\",\\\"level\\\":1/g
        const seenRootIds = new Set()
        let level1Match = null
        while ((level1Match = level1Regex.exec(html))) {
          const categoryId = Number(level1Match[1] || 0)
          const categoryName = String(level1Match[2] || '').trim()
          if (!categoryId || !categoryName || seenRootIds.has(categoryId)) {
            continue
          }
          seenRootIds.add(categoryId)
          rootOptions.push({
            id: categoryId,
            name: categoryName,
          })
        }
      } catch (error) {
        rootOptions = []
      }

      if (effectivePath.length >= 1) {
        const rootOption = rootOptions.find((option) => option.id === effectivePath[0])
        basePathLabel = rootOption ? rootOption.name : ''
      }

      if (!effectivePath.length && rootOptions.length) {
        return JSON.stringify({
          ok: true,
          status: 200,
          companyId,
          sellerUrl: location.href,
          scopeLabel,
          rootScope: 'none',
          requestedPath: [],
          basePathLabel: '',
          rootOptions,
          currentLevel: 1,
          group: '',
          period: periodMeta.api,
          periodLabel: periodMeta.label,
          data: {
            items: [],
          },
          text: '',
        })
      }

      const payload = {
        filter: {
          sex: [],
          brand_ids: [],
          seller_ids: [],
          price_segment: {},
        },
        group,
        period_slice: periodMeta.slice,
        period: periodMeta.api,
        sort: {
          direction: 'direction_desc',
          metric: 'metric_gmv',
        },
        is_premium: false,
      }

      if (currentLevel === 2 && effectivePath.length >= 1) {
        payload.filter.category = {
          category_type: 'category1',
          id: effectivePath[0],
          is_own: false,
        }
      } else if (currentLevel === 3 && effectivePath.length >= 2) {
        payload.filter.category = {
          category_type: 'category2',
          id: effectivePath[1],
          is_own: false,
        }
      }

      try {
        const language = document.documentElement.lang || 'zh-Hans'
        const response = await fetch('/api/site/exar-api/v2/gb/seller/metrics', {
          method: 'POST',
          credentials: 'include',
          headers: {
            'content-type': 'application/json',
            'x-o3-app-name': 'seller-ui',
            'x-o3-company-id': String(companyId),
            'x-o3-language': language,
            'x-o3-page-type': 'analytics_other_domain',
          },
          body: JSON.stringify(payload),
        })
        const text = await response.text()
        let data = null
        try {
          data = JSON.parse(text)
        } catch (error) {
          data = null
        }
        return JSON.stringify({
          ok: response.ok,
          status: response.status,
          companyId,
          sellerUrl: location.href,
          scopeLabel,
          rootScope: effectivePath.length ? 'selected' : 'none',
          requestedPath: effectivePath,
          basePathLabel,
          rootOptions,
          currentLevel,
          group,
          period: periodMeta.api,
          periodLabel: periodMeta.label,
          data,
          text: response.ok ? '' : text.slice(0, 1200),
        })
      } catch (error) {
        return JSON.stringify({
          ok: false,
          error: String(error),
          companyId,
          sellerUrl: location.href,
          scopeLabel,
          rootScope: effectivePath.length ? 'selected' : 'none',
          requestedPath: effectivePath,
          basePathLabel,
          rootOptions,
          currentLevel,
          group,
          period: periodMeta.api,
          periodLabel: periodMeta.label,
        })
      }
    })()
    """
    script = script.replace("__REQUESTED_PATH__", json.dumps(drill_path, ensure_ascii=False))
    script = script.replace("__REQUESTED_PERIOD__", json.dumps(normalized_period, ensure_ascii=False))
    try:
        raw_payload = _chrome_runtime_evaluate(target, script, await_promise=True)
        payload = json.loads(str(raw_payload or "{}"))
    except HTTPException:
        if fallback_result is not None:
            return fallback_result
        raise
    except Exception as exc:
        if fallback_result is not None:
            return fallback_result
        raise HTTPException(status_code=400, detail=f"Seller 页面返回了无法解析的数据: {exc}") from exc

    if not payload.get("ok"):
        if cached_entry:
            return cached_entry[1]
        if fallback_result is not None:
            return fallback_result
        detail = payload.get("text") or payload.get("error") or "Seller 类目趋势接口调用失败"
        raise HTTPException(status_code=400, detail=detail)

    resolved_path = _normalize_market_drill_path(payload.get("requestedPath") or drill_path)
    current_level = max(min(_safe_int(payload.get("currentLevel"), len(resolved_path) + 1), 3), 1)
    can_drill_down = current_level < 3
    rows: List[Dict[str, Any]] = []
    for item in payload.get("data", {}).get("items") or []:
        if not isinstance(item, dict):
            continue
        name = str(item.get("label") or item.get("key") or "").strip()
        if not name:
            continue
        rows.append(
            {
                "id": str(item.get("key") or "").strip(),
                "name": name,
                "salesAmount": round(_safe_float(item.get("metric_gmv"), 0.0), 2),
                "salesDelta": round(_safe_float(item.get("metric_gmv_growth"), 0.0), 2),
                "soldUnits": _safe_int(item.get("metric_items"), 0),
                "sellerCount": _safe_int(item.get("metric_sellers"), 0),
                "avgPrice": round(_safe_float(item.get("metric_aiv"), 0.0), 2),
                "avgPriceDelta": round(_safe_float(item.get("metric_aiv_growth"), 0.0), 2),
                "brandCount": _safe_int(item.get("metric_brands"), 0),
                "leaderShare": round(_safe_float(item.get("metric_leader_share"), 0.0), 2),
                "buyoutRate": round(_safe_float(item.get("metric_buyout"), 0.0), 2),
                "level": current_level,
                "canDrillDown": can_drill_down,
            }
        )

    rows.sort(
        key=lambda row: (
            row["salesAmount"],
            row["soldUnits"],
            row["sellerCount"],
        ),
        reverse=True,
    )

    def build_chart_rows(value_key: str) -> List[Dict[str, Any]]:
        return [
            {"name": row["name"], "value": row[value_key]}
            for row in rows
            if row[value_key] > 0
        ]

    result = {
        "scopeLabel": str(payload.get("scopeLabel") or "").strip() or "Seller 当前类目",
        "sourceUrl": str(payload.get("sellerUrl") or target.get("url") or ""),
        "companyId": _safe_int(payload.get("companyId"), 0),
        "rootScope": str(payload.get("rootScope") or ("selected" if resolved_path else "none")).strip() or "none",
        "path": resolved_path,
        "basePathLabel": str(payload.get("basePathLabel") or "").strip(),
        "rootOptions": [
            {
                "id": _safe_int(item.get("id"), 0),
                "name": str(item.get("name") or "").strip(),
            }
            for item in payload.get("rootOptions") or []
            if _safe_int(item.get("id"), 0) > 0 and str(item.get("name") or "").strip()
        ],
        "level": current_level,
        "maxLevel": 3,
        "canDrillDown": can_drill_down,
        "group": str(payload.get("group") or "").strip(),
        "period": str(payload.get("period") or "").strip(),
        "periodLabel": str(payload.get("periodLabel") or "").strip() or "当前周期",
        "generatedAt": datetime.now(timezone.utc).isoformat(),
        "charts": {
            "sales": build_chart_rows("salesAmount"),
            "units": build_chart_rows("soldUnits"),
            "sellers": build_chart_rows("sellerCount"),
        },
        "table": rows,
    }
    cached_at = time.time()
    SELLER_MARKET_TRENDS_CACHE[cache_key] = (cached_at, result)
    _save_seller_market_trends_disk_cache(cache_key, cached_at, result)
    return result


def _load_cache_entries_from_file(cache_file: Path) -> Dict[str, Dict[str, Any]]:
    try:
        if not cache_file.exists():
            return {}
        payload = json.loads(cache_file.read_text(encoding="utf-8"))
    except Exception:
        return {}

    raw_entries: Dict[str, Any] = {}
    if isinstance(payload, dict):
        if isinstance(payload.get("entries"), dict):
            raw_entries = payload["entries"]
        elif str(payload.get("cacheKey") or "").strip():
            raw_entries = {
                str(payload.get("cacheKey")): {
                    "cachedAt": payload.get("cachedAt"),
                    "result": payload.get("result"),
                }
            }

    entries: Dict[str, Dict[str, Any]] = {}
    for raw_key, raw_entry in raw_entries.items():
        if not isinstance(raw_entry, dict):
            continue
        cache_key = str(raw_key or "").strip()
        cached_at = _safe_float(raw_entry.get("cachedAt"), 0.0)
        result = raw_entry.get("result")
        if not cache_key or cached_at <= 0 or not isinstance(result, dict):
            continue
        entries[cache_key] = {
            "cachedAt": cached_at,
            "result": result,
        }
    return entries


def _save_cache_entries_to_file(cache_file: Path, entries: Dict[str, Dict[str, Any]]) -> None:
    try:
        cache_file.parent.mkdir(parents=True, exist_ok=True)
        cache_file.write_text(
            json.dumps(
                {
                    "entries": entries,
                },
                ensure_ascii=False,
            ),
            encoding="utf-8",
        )
    except Exception:
        return


def _seller_market_trends_cache_key(
    path_ids: Optional[Sequence[int]] = None,
    period: str = "28_days",
    tenant_id: Optional[int] = None,
    seller_company_id: int = 0,
) -> str:
    drill_path = _normalize_market_drill_path(path_ids)
    normalized_period = _normalize_market_period(period)
    return json.dumps(
        {
            "scope": "seller_market_trends",
            "tenant_id": tenant_id,
            "seller_company_id": _safe_int(seller_company_id, 0),
            "path": drill_path,
            "period": normalized_period,
        },
        ensure_ascii=False,
        sort_keys=True,
    )


def _is_seller_market_trends_disk_cache_fresh(cached_at: float) -> bool:
    return cached_at > 0 and time.time() - cached_at <= SELLER_MARKET_TRENDS_DISK_CACHE_TTL_SECONDS


def _load_seller_market_trends_disk_cache(cache_key: str) -> Optional[Dict[str, Any]]:
    entries = _load_cache_entries_from_file(SELLER_MARKET_TRENDS_CACHE_FILE)
    entry = entries.get(cache_key)
    if not entry:
        return None

    cached_at = _safe_float(entry.get("cachedAt"), 0.0)
    result = entry.get("result")
    if cached_at <= 0 or not isinstance(result, dict):
        return None

    with SELLER_MARKET_TRENDS_CACHE_LOCK:
        SELLER_MARKET_TRENDS_CACHE[cache_key] = (cached_at, result)
    return {
        "cachedAt": cached_at,
        "result": result,
    }


def _save_seller_market_trends_disk_cache(cache_key: str, cached_at: float, result: Dict[str, Any]) -> None:
    with SELLER_MARKET_TRENDS_CACHE_LOCK:
        entries = _load_cache_entries_from_file(SELLER_MARKET_TRENDS_CACHE_FILE)
        entries[cache_key] = {
            "cachedAt": cached_at,
            "result": result,
        }
        _save_cache_entries_to_file(SELLER_MARKET_TRENDS_CACHE_FILE, entries)


def _seller_market_all_roots_cache_key(
    target: Optional[Dict[str, Any]] = None,
    company_id: int = 0,
    period: str = "28_days",
    tenant_id: Optional[int] = None,
) -> str:
    normalized_period = _normalize_market_period(period)
    return json.dumps(
        {
            "scope": "seller_market_all_roots",
            "tenant_id": tenant_id,
            "seller_company_id": _safe_int(company_id, 0),
            "period": normalized_period,
        },
        ensure_ascii=False,
        sort_keys=True,
    )


def _is_seller_market_all_roots_cache_fresh(cached_at: float) -> bool:
    return cached_at > 0 and time.time() - cached_at <= SELLER_MARKET_ALL_ROOTS_CACHE_TTL_SECONDS


def _load_seller_market_all_roots_disk_cache(cache_key: str) -> Optional[Dict[str, Any]]:
    entries = _load_cache_entries_from_file(SELLER_MARKET_ALL_ROOTS_CACHE_FILE)
    entry = entries.get(cache_key)
    if not entry:
        return None

    cached_at = _safe_float(entry.get("cachedAt"), 0.0)
    result = entry.get("result")
    if cached_at <= 0 or not isinstance(result, dict):
        return None

    with SELLER_MARKET_ALL_ROOTS_CACHE_LOCK:
        SELLER_MARKET_ALL_ROOTS_CACHE[cache_key] = (cached_at, result)
    return {
        "cachedAt": cached_at,
        "result": result,
    }


def _save_seller_market_all_roots_disk_cache(cache_key: str, cached_at: float, result: Dict[str, Any]) -> None:
    with SELLER_MARKET_ALL_ROOTS_CACHE_LOCK:
        entries = _load_cache_entries_from_file(SELLER_MARKET_ALL_ROOTS_CACHE_FILE)
        entries[cache_key] = {
            "cachedAt": cached_at,
            "result": result,
        }
        _save_cache_entries_to_file(SELLER_MARKET_ALL_ROOTS_CACHE_FILE, entries)


def _fetch_seller_market_all_roots_from_browser(
    period: str = "28_days",
    tenant_id: Optional[int] = None,
) -> Dict[str, Any]:
    normalized_period = _normalize_market_period(period)
    cache_key = _seller_market_all_roots_cache_key(period=normalized_period, tenant_id=tenant_id)
    with SELLER_MARKET_ALL_ROOTS_CACHE_LOCK:
        memory_cache_entry = SELLER_MARKET_ALL_ROOTS_CACHE.get(cache_key)
    if memory_cache_entry and _is_seller_market_all_roots_cache_fresh(memory_cache_entry[0]):
        return memory_cache_entry[1]

    disk_cache_entry = _load_seller_market_all_roots_disk_cache(cache_key)
    if disk_cache_entry and _is_seller_market_all_roots_cache_fresh(float(disk_cache_entry["cachedAt"])):
        return disk_cache_entry["result"]
    fallback_result = disk_cache_entry["result"] if disk_cache_entry else None

    try:
        target = _pick_seller_target("seller.ozon.ru/app/analytics/what-to-sell/categories-comparison")
    except HTTPException:
        try:
            target = _pick_seller_target()
        except HTTPException:
            if fallback_result is not None:
                return fallback_result
            raise

    context_script = """
    (() => {
      const companyId = Number((document.cookie.match(/(?:^|; )sc_company_id=(\\d+)/) || [])[1] || 0)
      const searchParams = new URLSearchParams(location.search)
      const periodValue = __REQUESTED_PERIOD__
      const periodMap = {
        '7_days': { api: 'period_week', slice: 'slice_day', label: '7\\u5929' },
        '28_days': { api: 'period_month', slice: 'slice_day', label: '28\\u5929' },
        quarter: { api: 'period_quarter', slice: 'slice_week', label: '\\u5b63\\u5ea6' },
        year: { api: 'period_year', slice: 'slice_month', label: '\\u5e74\\u4efd' },
      }
      const periodMeta = periodMap[periodValue] || periodMap['28_days']
      return JSON.stringify({
        companyId,
        period: periodMeta.api,
        periodLabel: periodMeta.label,
      })
    })()
    """
    raw_context = _chrome_runtime_evaluate(target, context_script, await_promise=False)
    try:
        context_payload = json.loads(str(raw_context or "{}"))
    except Exception as exc:
        raise HTTPException(status_code=400, detail=f"Seller 椤甸潰涓婁笅鏂囪В鏋愬け璐? {exc}") from exc

    company_id = _safe_int(context_payload.get("companyId"), 0)
    cache_key = _seller_market_all_roots_cache_key(
        target,
        company_id,
        period=normalized_period,
        tenant_id=tenant_id,
    )
    with SELLER_MARKET_ALL_ROOTS_CACHE_LOCK:
        memory_cache_entry = SELLER_MARKET_ALL_ROOTS_CACHE.get(cache_key)
    if memory_cache_entry and _is_seller_market_all_roots_cache_fresh(memory_cache_entry[0]):
        return memory_cache_entry[1]

    disk_cache_entry = _load_seller_market_all_roots_disk_cache(cache_key)
    if disk_cache_entry and _is_seller_market_all_roots_cache_fresh(float(disk_cache_entry["cachedAt"])):
        return disk_cache_entry["result"]

    all_roots_script = """
    (async () => {
      const companyId = Number((document.cookie.match(/(?:^|; )sc_company_id=(\\d+)/) || [])[1] || 0)
      if (!companyId) {
        return JSON.stringify({
          ok: false,
          error: '褰撳墠 Seller 椤甸潰缂哄皯 sc_company_id cookie',
          sellerUrl: location.href,
        })
      }

      const searchParams = new URLSearchParams(location.search)
      const periodValue = searchParams.get('period') || '28_days'
      const periodMap = {
        '7_days': { api: 'period_week', slice: 'slice_day', label: '7\\u5929' },
        '28_days': { api: 'period_month', slice: 'slice_day', label: '28\\u5929' },
        quarter: { api: 'period_quarter', slice: 'slice_week', label: '\\u5b63\\u5ea6' },
        year: { api: 'period_year', slice: 'slice_month', label: '\\u5e74\\u4efd' },
      }
      const periodMeta = periodMap[periodValue] || periodMap['28_days']
      const language = document.documentElement.lang || 'zh-Hans'

      const sleep = (timeoutMs) => new Promise((resolve) => setTimeout(resolve, timeoutMs))
      const maxAttempts = periodValue === 'year' ? 8 : periodValue === 'quarter' ? 6 : 4
      const retryBaseDelayMs = periodValue === 'year' ? 2500 : periodValue === 'quarter' ? 1200 : 900
      const requestPauseMs = periodValue === 'year' ? 650 : periodValue === 'quarter' ? 250 : 120
      const toNumber = (value) => {
        const rawValue = value === null || value === undefined ? 0 : value
        const parsedValue = Number(String(rawValue).replace(/,/g, '').trim())
        return Number.isFinite(parsedValue) ? parsedValue : 0
      }

      const aggregateSalesDelta = (items) => {
        let currentTotal = 0
        let previousTotal = 0
        let comparableCount = 0
        for (const item of items) {
          const currentValue = toNumber(item.metric_gmv)
          const delta = toNumber(item.metric_gmv_growth)
          const denominator = 1 + delta / 100
          currentTotal += currentValue
          if (currentValue <= 0 || denominator <= 0) {
            continue
          }
          previousTotal += currentValue / denominator
          comparableCount += 1
        }
        if (!comparableCount) {
          return 0
        }
        if (previousTotal <= 0) {
          return currentTotal > 0 ? 100 : 0
        }
        return ((currentTotal - previousTotal) / previousTotal) * 100
      }

      const aggregateUnitStats = (items) => {
        let currentUnits = 0
        let previousUnits = 0
        let comparableCount = 0
        for (const item of items) {
          const currentValue = toNumber(item.metric_items)
          const salesFactor = 1 + toNumber(item.metric_gmv_growth) / 100
          const priceFactor = 1 + toNumber(item.metric_aiv_growth) / 100
          currentUnits += currentValue
          if (currentValue <= 0 || salesFactor <= 0 || priceFactor <= 0) {
            continue
          }
          const unitFactor = salesFactor / priceFactor
          if (unitFactor <= 0) {
            continue
          }
          previousUnits += currentValue / unitFactor
          comparableCount += 1
        }
        let unitsDelta = 0
        if (comparableCount) {
          if (previousUnits <= 0) {
            unitsDelta = currentUnits > 0 ? 100 : 0
          } else {
            unitsDelta = ((currentUnits - previousUnits) / previousUnits) * 100
          }
        }
        return {
          currentUnits,
          previousUnits,
          unitsDelta,
        }
      }

      const weightedAverage = (items, valueKey, weightKey) => {
        let weightedTotal = 0
        let totalWeight = 0
        for (const item of items) {
          const weight = toNumber(item[weightKey])
          if (weight <= 0) {
            continue
          }
          weightedTotal += toNumber(item[valueKey]) * weight
          totalWeight += weight
        }
        return totalWeight > 0 ? weightedTotal / totalWeight : 0
      }

      const extractJsonArray = (source, marker) => {
        const markerIndex = source.indexOf(marker)
        if (markerIndex < 0) {
          return null
        }
        const startIndex = source.indexOf('[', markerIndex + marker.length)
        if (startIndex < 0) {
          return null
        }

        let depth = 0
        let inString = false
        let escaped = false
        for (let index = startIndex; index < source.length; index += 1) {
          const char = source[index]
          if (inString) {
            if (escaped) {
              escaped = false
              continue
            }
            if (char === '\\\\') {
              escaped = true
              continue
            }
            if (char === '\"') {
              inString = false
            }
            continue
          }

          if (char === '\"') {
            inString = true
            continue
          }
          if (char === '[') {
            depth += 1
            continue
          }
          if (char === ']') {
            depth -= 1
            if (depth === 0) {
              return source.slice(startIndex, index + 1)
            }
          }
        }
        return null
      }

      const fetchRootRows = async (rootId, rootName) => {
        const payload = {
          filter: {
            sex: [],
            brand_ids: [],
            seller_ids: [],
            price_segment: {},
            category: {
              category_type: 'category1',
              id: rootId,
              is_own: false,
            },
          },
          group: 'group_category2',
          period_slice: periodMeta.slice,
          period: periodMeta.api,
          sort: {
            direction: 'direction_desc',
            metric: 'metric_gmv',
          },
          is_premium: false,
        }

        for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
          const response = await fetch('/api/site/exar-api/v2/gb/seller/metrics', {
            method: 'POST',
            credentials: 'include',
            headers: {
              'content-type': 'application/json',
              'x-o3-app-name': 'seller-ui',
              'x-o3-company-id': String(companyId),
              'x-o3-language': language,
              'x-o3-page-type': 'analytics_other_domain',
            },
            body: JSON.stringify(payload),
          })

          if (response.ok) {
            const data = await response.json()
            return Array.isArray(data.items) ? data.items : []
          }

          if (response.status === 429 && attempt < maxAttempts - 1) {
            await sleep(retryBaseDelayMs * (attempt + 1))
            continue
          }

          const responseText = await response.text()
          throw new Error(`${rootName}(${rootId}) request failed: ${response.status} ${responseText.slice(0, 240)}`)
        }

        throw new Error(`${rootName}(${rootId}) request exhausted retries`)
      }

      try {
        const html = await fetch(location.pathname + location.search, {
          credentials: 'include',
        }).then((response) => response.text())
        const normalizedHtml = html.replace(/\\\\\\\"/g, '\"')
        const categoryTreePayload = extractJsonArray(normalizedHtml, '\"categoryTree\":')
        const categoryTree = categoryTreePayload ? JSON.parse(categoryTreePayload) : []
        const rootOptions = Array.isArray(categoryTree)
          ? categoryTree
              .map((node) => ({
                id: toNumber(node?.id),
                name: String(node?.name || '').trim(),
              }))
              .filter((node) => node.id > 0 && node.name)
          : []

        const rows = []
        for (const rootOption of rootOptions) {
          const rootItems = await fetchRootRows(rootOption.id, rootOption.name)
          const salesAmount = rootItems.reduce((total, item) => total + toNumber(item.metric_gmv), 0)
          const sellerCount = rootItems.reduce((total, item) => total + toNumber(item.metric_sellers), 0)
          const brandCount = rootItems.reduce((total, item) => total + toNumber(item.metric_brands), 0)
          const { currentUnits, previousUnits } = aggregateUnitStats(rootItems)
          const salesDelta = aggregateSalesDelta(rootItems)
          const averagePrice = currentUnits > 0 ? salesAmount / currentUnits : 0
          const previousSales = salesDelta <= -100 ? 0 : salesAmount / Math.max(1 + salesDelta / 100, 0.000001)
          const previousAveragePrice = previousUnits > 0 ? previousSales / previousUnits : 0
          const avgPriceDelta = previousAveragePrice > 0
            ? ((averagePrice - previousAveragePrice) / previousAveragePrice) * 100
            : (averagePrice > 0 ? 100 : 0)

          rows.push({
            id: String(rootOption.id),
            name: rootOption.name,
            salesAmount: Number(salesAmount.toFixed(2)),
            salesDelta: Number(salesDelta.toFixed(2)),
            soldUnits: Math.round(currentUnits),
            sellerCount: Math.round(sellerCount),
            avgPrice: Number(averagePrice.toFixed(2)),
            avgPriceDelta: Number(avgPriceDelta.toFixed(2)),
            brandCount: Math.round(brandCount),
            leaderShare: Number(weightedAverage(rootItems, 'metric_leader_share', 'metric_gmv').toFixed(2)),
            buyoutRate: Number(weightedAverage(rootItems, 'metric_buyout', 'metric_items').toFixed(2)),
            level: 1,
            canDrillDown: true,
          })

          await sleep(requestPauseMs)
        }

        rows.sort((left, right) => {
          if (right.salesAmount !== left.salesAmount) {
            return right.salesAmount - left.salesAmount
          }
          if (right.soldUnits !== left.soldUnits) {
            return right.soldUnits - left.soldUnits
          }
          return right.sellerCount - left.sellerCount
        })

        return JSON.stringify({
          ok: true,
          companyId,
          sellerUrl: location.href,
          rootScope: 'all',
          scopeLabel: 'Seller 全部一级类目',
          path: [],
          basePathLabel: '全部类目',
          rootOptions,
          level: 1,
          maxLevel: 3,
          canDrillDown: true,
          group: 'group_category1',
          period: periodMeta.api,
          periodLabel: periodMeta.label,
          rows,
        })
      } catch (error) {
        return JSON.stringify({
          ok: false,
          error: String(error),
          companyId,
          sellerUrl: location.href,
          period: periodMeta.api,
          periodLabel: periodMeta.label,
        })
      }
    })()
    """
    raw_payload = _chrome_runtime_evaluate(target, all_roots_script, await_promise=True)
    try:
        payload = json.loads(str(raw_payload or "{}"))
    except Exception as exc:
        if disk_cache_entry:
            return disk_cache_entry["result"]
        raise HTTPException(status_code=400, detail=f"Seller 鍏ㄩ儴涓€绾х被鐩暟鎹В鏋愬け璐? {exc}") from exc

    if not payload.get("ok"):
        if disk_cache_entry:
            return disk_cache_entry["result"]
        detail = payload.get("error") or "Seller 鍏ㄩ儴涓€绾х被鐩暟鎹姄鍙栧け璐?"
        raise HTTPException(status_code=400, detail=detail)

    rows: List[Dict[str, Any]] = []
    for item in payload.get("rows") or []:
        if not isinstance(item, dict):
            continue
        name = str(item.get("name") or "").strip()
        category_id = str(item.get("id") or "").strip()
        if not name or not category_id:
            continue
        rows.append(
            {
                "id": category_id,
                "name": name,
                "salesAmount": round(_safe_float(item.get("salesAmount"), 0.0), 2),
                "salesDelta": round(_safe_float(item.get("salesDelta"), 0.0), 2),
                "soldUnits": _safe_int(item.get("soldUnits"), 0),
                "sellerCount": _safe_int(item.get("sellerCount"), 0),
                "avgPrice": round(_safe_float(item.get("avgPrice"), 0.0), 2),
                "avgPriceDelta": round(_safe_float(item.get("avgPriceDelta"), 0.0), 2),
                "brandCount": _safe_int(item.get("brandCount"), 0),
                "leaderShare": round(_safe_float(item.get("leaderShare"), 0.0), 2),
                "buyoutRate": round(_safe_float(item.get("buyoutRate"), 0.0), 2),
                "level": 1,
                "canDrillDown": True,
            }
        )

    rows.sort(
        key=lambda row: (
            row["salesAmount"],
            row["soldUnits"],
            row["sellerCount"],
        ),
        reverse=True,
    )

    def build_chart_rows(value_key: str) -> List[Dict[str, Any]]:
        return [
            {"name": row["name"], "value": row[value_key]}
            for row in rows
            if row[value_key] > 0
        ]

    result = {
        "scopeLabel": str(payload.get("scopeLabel") or "").strip() or "Seller 全部一级类目",
        "sourceUrl": str(payload.get("sellerUrl") or target.get("url") or ""),
        "companyId": _safe_int(payload.get("companyId"), company_id),
        "rootScope": "all",
        "path": [],
        "basePathLabel": str(payload.get("basePathLabel") or "").strip() or "全部类目",
        "rootOptions": [
            {
                "id": _safe_int(item.get("id"), 0),
                "name": str(item.get("name") or "").strip(),
            }
            for item in payload.get("rootOptions") or []
            if _safe_int(item.get("id"), 0) > 0 and str(item.get("name") or "").strip()
        ],
        "level": 1,
        "maxLevel": 3,
        "canDrillDown": True,
        "group": str(payload.get("group") or "").strip() or "group_category1",
        "period": str(payload.get("period") or "").strip() or str(context_payload.get("period") or "").strip(),
        "periodLabel": str(payload.get("periodLabel") or "").strip()
        or str(context_payload.get("periodLabel") or "").strip()
        or "褰撳墠鍛ㄦ湡",
        "generatedAt": datetime.now(timezone.utc).isoformat(),
        "charts": {
            "sales": build_chart_rows("salesAmount"),
            "units": build_chart_rows("soldUnits"),
            "sellers": build_chart_rows("sellerCount"),
        },
        "table": rows,
    }
    cached_at = time.time()
    with SELLER_MARKET_ALL_ROOTS_CACHE_LOCK:
        SELLER_MARKET_ALL_ROOTS_CACHE[cache_key] = (cached_at, result)
    _save_seller_market_all_roots_disk_cache(cache_key, cached_at, result)
    return result


def _fetch_seller_market_all_roots_from_browser(
    period: str = "28_days",
    tenant_id: Optional[int] = None,
) -> Dict[str, Any]:
    normalized_period = _normalize_market_period(period)
    cache_key = _seller_market_all_roots_cache_key(period=normalized_period, tenant_id=tenant_id)
    with SELLER_MARKET_ALL_ROOTS_CACHE_LOCK:
        memory_cache_entry = SELLER_MARKET_ALL_ROOTS_CACHE.get(cache_key)
    if memory_cache_entry and _is_seller_market_all_roots_cache_fresh(memory_cache_entry[0]):
        return memory_cache_entry[1]

    disk_cache_entry = _load_seller_market_all_roots_disk_cache(cache_key)
    if disk_cache_entry and _is_seller_market_all_roots_cache_fresh(float(disk_cache_entry["cachedAt"])):
        return disk_cache_entry["result"]
    fallback_result = disk_cache_entry["result"] if disk_cache_entry else None

    try:
        target = _pick_seller_target("seller.ozon.ru/app/analytics/what-to-sell/categories-comparison")
    except HTTPException:
        try:
            target = _pick_seller_target()
        except HTTPException:
            if fallback_result is not None:
                return fallback_result
            raise

    context_script = """
    (() => {
      const companyId = Number((document.cookie.match(/(?:^|; )sc_company_id=(\\d+)/) || [])[1] || 0)
      const periodValue = __REQUESTED_PERIOD__
      const periodMap = {
        '7_days': { api: 'period_week', slice: 'slice_day', label: '7\\u5929' },
        '28_days': { api: 'period_month', slice: 'slice_day', label: '28\\u5929' },
        quarter: { api: 'period_quarter', slice: 'slice_week', label: '\\u5b63\\u5ea6' },
        year: { api: 'period_year', slice: 'slice_month', label: '\\u5e74\\u4efd' },
      }
      const periodMeta = periodMap[periodValue] || periodMap['28_days']
      return JSON.stringify({
        companyId,
        period: periodMeta.api,
        periodLabel: periodMeta.label,
      })
    })()
    """
    context_script = context_script.replace("__REQUESTED_PERIOD__", json.dumps(normalized_period, ensure_ascii=False))
    try:
        raw_context = _chrome_runtime_evaluate(target, context_script, await_promise=False)
        context_payload = json.loads(str(raw_context or "{}"))
    except HTTPException:
        if fallback_result is not None:
            return fallback_result
        raise
    except Exception as exc:
        if fallback_result is not None:
            return fallback_result
        raise HTTPException(status_code=400, detail=f"Seller 页面上下文解析失败: {exc}") from exc

    company_id = _safe_int(context_payload.get("companyId"), 0)
    cache_key = _seller_market_all_roots_cache_key(
        target,
        company_id,
        period=normalized_period,
        tenant_id=tenant_id,
    )
    with SELLER_MARKET_ALL_ROOTS_CACHE_LOCK:
        memory_cache_entry = SELLER_MARKET_ALL_ROOTS_CACHE.get(cache_key)
    if memory_cache_entry and _is_seller_market_all_roots_cache_fresh(memory_cache_entry[0]):
        return memory_cache_entry[1]

    disk_cache_entry = _load_seller_market_all_roots_disk_cache(cache_key)
    if disk_cache_entry and _is_seller_market_all_roots_cache_fresh(float(disk_cache_entry["cachedAt"])):
        return disk_cache_entry["result"]
    fallback_result = disk_cache_entry["result"] if disk_cache_entry else fallback_result

    all_roots_script = """
    (async () => {
      const companyId = Number((document.cookie.match(/(?:^|; )sc_company_id=(\\d+)/) || [])[1] || 0)
      if (!companyId) {
        return JSON.stringify({
          ok: false,
          error: '当前 Seller 页面缺少 sc_company_id cookie',
          sellerUrl: location.href,
        })
      }

      const periodValue = __REQUESTED_PERIOD__
      const periodMap = {
        '7_days': { api: 'period_week', slice: 'slice_day', label: '7\\u5929' },
        '28_days': { api: 'period_month', slice: 'slice_day', label: '28\\u5929' },
        quarter: { api: 'period_quarter', slice: 'slice_week', label: '\\u5b63\\u5ea6' },
        year: { api: 'period_year', slice: 'slice_month', label: '\\u5e74\\u4efd' },
      }
      const periodMeta = periodMap[periodValue] || periodMap['28_days']
      const language = document.documentElement.lang || 'zh-Hans'

      const sleep = (timeoutMs) => new Promise((resolve) => setTimeout(resolve, timeoutMs))
      const maxAttempts = periodValue === 'year' ? 8 : periodValue === 'quarter' ? 6 : 4
      const retryBaseDelayMs = periodValue === 'year' ? 2500 : periodValue === 'quarter' ? 1200 : 900
      const requestPauseMs = periodValue === 'year' ? 650 : periodValue === 'quarter' ? 250 : 120
      const toNumber = (value) => {
        const rawValue = value === null || value === undefined ? 0 : value
        const parsedValue = Number(String(rawValue).replace(/,/g, '').trim())
        return Number.isFinite(parsedValue) ? parsedValue : 0
      }

      const aggregateSalesDelta = (items) => {
        let currentTotal = 0
        let previousTotal = 0
        let comparableCount = 0
        for (const item of items) {
          const currentValue = toNumber(item.metric_gmv)
          const delta = toNumber(item.metric_gmv_growth)
          const denominator = 1 + delta / 100
          currentTotal += currentValue
          if (currentValue <= 0 || denominator <= 0) {
            continue
          }
          previousTotal += currentValue / denominator
          comparableCount += 1
        }
        if (!comparableCount) {
          return 0
        }
        if (previousTotal <= 0) {
          return currentTotal > 0 ? 100 : 0
        }
        return ((currentTotal - previousTotal) / previousTotal) * 100
      }

      const aggregateUnitStats = (items) => {
        let currentUnits = 0
        let previousUnits = 0
        let comparableCount = 0
        for (const item of items) {
          const currentValue = toNumber(item.metric_items)
          const salesFactor = 1 + toNumber(item.metric_gmv_growth) / 100
          const priceFactor = 1 + toNumber(item.metric_aiv_growth) / 100
          currentUnits += currentValue
          if (currentValue <= 0 || salesFactor <= 0 || priceFactor <= 0) {
            continue
          }
          const unitFactor = salesFactor / priceFactor
          if (unitFactor <= 0) {
            continue
          }
          previousUnits += currentValue / unitFactor
          comparableCount += 1
        }
        let unitsDelta = 0
        if (comparableCount) {
          if (previousUnits <= 0) {
            unitsDelta = currentUnits > 0 ? 100 : 0
          } else {
            unitsDelta = ((currentUnits - previousUnits) / previousUnits) * 100
          }
        }
        return {
          currentUnits,
          previousUnits,
          unitsDelta,
        }
      }

      const weightedAverage = (items, valueKey, weightKey) => {
        let weightedTotal = 0
        let totalWeight = 0
        for (const item of items) {
          const weight = toNumber(item[weightKey])
          if (weight <= 0) {
            continue
          }
          weightedTotal += toNumber(item[valueKey]) * weight
          totalWeight += weight
        }
        return totalWeight > 0 ? weightedTotal / totalWeight : 0
      }

      const extractJsonArray = (source, marker) => {
        const markerIndex = source.indexOf(marker)
        if (markerIndex < 0) {
          return null
        }
        const startIndex = source.indexOf('[', markerIndex + marker.length)
        if (startIndex < 0) {
          return null
        }

        let depth = 0
        let inString = false
        let escaped = false
        for (let index = startIndex; index < source.length; index += 1) {
          const char = source[index]
          if (inString) {
            if (escaped) {
              escaped = false
              continue
            }
            if (char === '\\\\') {
              escaped = true
              continue
            }
            if (char === '"') {
              inString = false
            }
            continue
          }

          if (char === '"') {
            inString = true
            continue
          }
          if (char === '[') {
            depth += 1
            continue
          }
          if (char === ']') {
            depth -= 1
            if (depth === 0) {
              return source.slice(startIndex, index + 1)
            }
          }
        }
        return null
      }

      const fetchRootRows = async (rootId, rootName) => {
        const payload = {
          filter: {
            sex: [],
            brand_ids: [],
            seller_ids: [],
            price_segment: {},
            category: {
              category_type: 'category1',
              id: rootId,
              is_own: false,
            },
          },
          group: 'group_category2',
          period_slice: periodMeta.slice,
          period: periodMeta.api,
          sort: {
            direction: 'direction_desc',
            metric: 'metric_gmv',
          },
          is_premium: false,
        }

        for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
          const response = await fetch('/api/site/exar-api/v2/gb/seller/metrics', {
            method: 'POST',
            credentials: 'include',
            headers: {
              'content-type': 'application/json',
              'x-o3-app-name': 'seller-ui',
              'x-o3-company-id': String(companyId),
              'x-o3-language': language,
              'x-o3-page-type': 'analytics_other_domain',
            },
            body: JSON.stringify(payload),
          })

          if (response.ok) {
            const data = await response.json()
            return Array.isArray(data.items) ? data.items : []
          }

          if (response.status === 429 && attempt < maxAttempts - 1) {
            await sleep(retryBaseDelayMs * (attempt + 1))
            continue
          }

          const responseText = await response.text()
          throw new Error(`${rootName}(${rootId}) request failed: ${response.status} ${responseText.slice(0, 240)}`)
        }

        throw new Error(`${rootName}(${rootId}) request exhausted retries`)
      }

      try {
        const html = await fetch(location.pathname + location.search, {
          credentials: 'include',
        }).then((response) => response.text())
        const level1Regex = /\\"id\\":\\"(\\d+)\\",\\"concatenatedId\\":\\"_[^\\"]*\\",\\"name\\":\\"([^\\"]+)\\",\\"level\\":1/g
        const seenRootIds = new Set()
        const rootOptions = []
        let level1Match = null
        while ((level1Match = level1Regex.exec(html))) {
          const categoryId = toNumber(level1Match[1])
          const categoryName = String(level1Match[2] || '').trim()
          if (!categoryId || !categoryName || seenRootIds.has(categoryId)) {
            continue
          }
          seenRootIds.add(categoryId)
          rootOptions.push({
            id: categoryId,
            name: categoryName,
          })
        }

        const rows = []
        for (const rootOption of rootOptions) {
          const rootItems = await fetchRootRows(rootOption.id, rootOption.name)
          const salesAmount = rootItems.reduce((total, item) => total + toNumber(item.metric_gmv), 0)
          const sellerCount = rootItems.reduce((total, item) => total + toNumber(item.metric_sellers), 0)
          const brandCount = rootItems.reduce((total, item) => total + toNumber(item.metric_brands), 0)
          const { currentUnits, previousUnits } = aggregateUnitStats(rootItems)
          const salesDelta = aggregateSalesDelta(rootItems)
          const averagePrice = currentUnits > 0 ? salesAmount / currentUnits : 0
          const previousSales = salesDelta <= -100 ? 0 : salesAmount / Math.max(1 + salesDelta / 100, 0.000001)
          const previousAveragePrice = previousUnits > 0 ? previousSales / previousUnits : 0
          const avgPriceDelta = previousAveragePrice > 0
            ? ((averagePrice - previousAveragePrice) / previousAveragePrice) * 100
            : (averagePrice > 0 ? 100 : 0)

          rows.push({
            id: String(rootOption.id),
            name: rootOption.name,
            salesAmount: Number(salesAmount.toFixed(2)),
            salesDelta: Number(salesDelta.toFixed(2)),
            soldUnits: Math.round(currentUnits),
            sellerCount: Math.round(sellerCount),
            avgPrice: Number(averagePrice.toFixed(2)),
            avgPriceDelta: Number(avgPriceDelta.toFixed(2)),
            brandCount: Math.round(brandCount),
            leaderShare: Number(weightedAverage(rootItems, 'metric_leader_share', 'metric_gmv').toFixed(2)),
            buyoutRate: Number(weightedAverage(rootItems, 'metric_buyout', 'metric_items').toFixed(2)),
            level: 1,
            canDrillDown: true,
          })

          await sleep(requestPauseMs)
        }

        rows.sort((left, right) => {
          if (right.salesAmount !== left.salesAmount) {
            return right.salesAmount - left.salesAmount
          }
          if (right.soldUnits !== left.soldUnits) {
            return right.soldUnits - left.soldUnits
          }
          return right.sellerCount - left.sellerCount
        })

        return JSON.stringify({
          ok: true,
          companyId,
          sellerUrl: location.href,
          rootScope: 'all',
          scopeLabel: 'Seller 全部一级类目',
          path: [],
          basePathLabel: '全部类目',
          rootOptions,
          level: 1,
          maxLevel: 3,
          canDrillDown: true,
          group: 'group_category1',
          period: periodMeta.api,
          periodLabel: periodMeta.label,
          rows,
        })
      } catch (error) {
        return JSON.stringify({
          ok: false,
          error: String(error),
          companyId,
          sellerUrl: location.href,
          period: periodMeta.api,
          periodLabel: periodMeta.label,
        })
      }
    })()
    """
    all_roots_script = all_roots_script.replace("__REQUESTED_PERIOD__", json.dumps(normalized_period, ensure_ascii=False))
    try:
        raw_payload = _chrome_runtime_evaluate(target, all_roots_script, await_promise=True)
        payload = json.loads(str(raw_payload or "{}"))
    except HTTPException:
        if fallback_result is not None:
            return fallback_result
        raise
    except Exception as exc:
        if fallback_result is not None:
            return fallback_result
        raise HTTPException(status_code=400, detail=f"Seller 全部一级类目数据解析失败: {exc}") from exc

    if not payload.get("ok"):
        if fallback_result is not None:
            return fallback_result
        detail = payload.get("error") or "Seller 全部一级类目数据抓取失败"
        raise HTTPException(status_code=400, detail=detail)

    rows: List[Dict[str, Any]] = []
    for item in payload.get("rows") or []:
        if not isinstance(item, dict):
            continue
        name = str(item.get("name") or "").strip()
        category_id = str(item.get("id") or "").strip()
        if not name or not category_id:
            continue
        rows.append(
            {
                "id": category_id,
                "name": name,
                "salesAmount": round(_safe_float(item.get("salesAmount"), 0.0), 2),
                "salesDelta": round(_safe_float(item.get("salesDelta"), 0.0), 2),
                "soldUnits": _safe_int(item.get("soldUnits"), 0),
                "sellerCount": _safe_int(item.get("sellerCount"), 0),
                "avgPrice": round(_safe_float(item.get("avgPrice"), 0.0), 2),
                "avgPriceDelta": round(_safe_float(item.get("avgPriceDelta"), 0.0), 2),
                "brandCount": _safe_int(item.get("brandCount"), 0),
                "leaderShare": round(_safe_float(item.get("leaderShare"), 0.0), 2),
                "buyoutRate": round(_safe_float(item.get("buyoutRate"), 0.0), 2),
                "level": 1,
                "canDrillDown": True,
            }
        )

    rows.sort(
        key=lambda row: (
            row["salesAmount"],
            row["soldUnits"],
            row["sellerCount"],
        ),
        reverse=True,
    )

    def build_chart_rows(value_key: str) -> List[Dict[str, Any]]:
        return [
            {"name": row["name"], "value": row[value_key]}
            for row in rows
            if row[value_key] > 0
        ]

    result = {
        "scopeLabel": str(payload.get("scopeLabel") or "").strip() or "Seller 全部一级类目",
        "sourceUrl": str(payload.get("sellerUrl") or target.get("url") or ""),
        "companyId": _safe_int(payload.get("companyId"), company_id),
        "rootScope": "all",
        "path": [],
        "basePathLabel": str(payload.get("basePathLabel") or "").strip() or "全部类目",
        "rootOptions": [
            {
                "id": _safe_int(item.get("id"), 0),
                "name": str(item.get("name") or "").strip(),
            }
            for item in payload.get("rootOptions") or []
            if _safe_int(item.get("id"), 0) > 0 and str(item.get("name") or "").strip()
        ],
        "level": 1,
        "maxLevel": 3,
        "canDrillDown": True,
        "group": str(payload.get("group") or "").strip() or "group_category1",
        "period": str(payload.get("period") or "").strip() or str(context_payload.get("period") or "").strip(),
        "periodLabel": str(payload.get("periodLabel") or "").strip()
        or str(context_payload.get("periodLabel") or "").strip()
        or "当前周期",
        "generatedAt": datetime.now(timezone.utc).isoformat(),
        "charts": {
            "sales": build_chart_rows("salesAmount"),
            "units": build_chart_rows("soldUnits"),
            "sellers": build_chart_rows("sellerCount"),
        },
        "table": rows,
    }
    cached_at = time.time()
    with SELLER_MARKET_ALL_ROOTS_CACHE_LOCK:
        SELLER_MARKET_ALL_ROOTS_CACHE[cache_key] = (cached_at, result)
    _save_seller_market_all_roots_disk_cache(cache_key, cached_at, result)
    return result

CATEGORY_CATALOG: List[tuple[str, str, str]] = [
    ("服饰", "女装", "夹克"),
    ("服饰", "女装", "连衣裙"),
    ("服饰", "男装", "牛仔裤"),
    ("鞋包", "运动鞋", "跑鞋"),
    ("鞋包", "箱包", "双肩包"),
    ("家居", "厨房", "收纳盒"),
    ("家居", "清洁", "拖把"),
    ("数码", "耳机", "无线耳机"),
    ("数码", "配件", "充电器"),
    ("美妆", "护肤", "面膜"),
]

COMMISSION_ROWS: List[Dict[str, Any]] = [
    {"group": "服饰", "category": "夹克", "tier1": "12.0%", "tier2": "14.0%", "tier3": "20.0%"},
    {"group": "服饰", "category": "牛仔裤", "tier1": "12.0%", "tier2": "14.0%", "tier3": "18.0%"},
    {"group": "服饰", "category": "连衣裙", "tier1": "11.0%", "tier2": "13.0%", "tier3": "18.0%"},
    {"group": "鞋包", "category": "跑鞋", "tier1": "10.0%", "tier2": "11.0%", "tier3": "12.0%"},
    {"group": "鞋包", "category": "双肩包", "tier1": "11.0%", "tier2": "12.0%", "tier3": "14.0%"},
    {"group": "家居", "category": "收纳盒", "tier1": "8.0%", "tier2": "9.0%", "tier3": "10.0%"},
    {"group": "家居", "category": "拖把", "tier1": "8.0%", "tier2": "9.0%", "tier3": "10.0%"},
    {"group": "数码", "category": "无线耳机", "tier1": "6.0%", "tier2": "6.0%", "tier3": "7.0%"},
    {"group": "数码", "category": "充电器", "tier1": "6.0%", "tier2": "6.0%", "tier3": "6.5%"},
    {"group": "美妆", "category": "面膜", "tier1": "12.0%", "tier2": "13.0%", "tier3": "15.0%"},
]

HOT_TAG_SEED_ROWS: List[Dict[str, Any]] = [
    {"group": "服饰", "tag": "夹克", "searchVolume": 1542030, "competition": "高", "trend": 15.2},
    {"group": "服饰", "tag": "牛仔裤", "searchVolume": 1205400, "competition": "高", "trend": 8.5},
    {"group": "服饰", "tag": "连衣裙", "searchVolume": 985600, "competition": "中", "trend": -2.1},
    {"group": "数码", "tag": "无线耳机", "searchVolume": 850200, "competition": "高", "trend": 22.4},
    {"group": "鞋包", "tag": "运动鞋", "searchVolume": 740100, "competition": "极高", "trend": 5.6},
    {"group": "美妆", "tag": "面膜", "searchVolume": 630500, "competition": "极高", "trend": 1.2},
    {"group": "数码", "tag": "充电器", "searchVolume": 512000, "competition": "中", "trend": -4.5},
    {"group": "鞋包", "tag": "双肩包", "searchVolume": 489000, "competition": "高", "trend": 11.3},
]

HOT_TAG_COMPETITION_LEVELS = ("低", "中", "高", "极高")


def _normalize_hot_tag_text(value: Any) -> str:
    return str(value or "").strip()


def _build_generated_hot_tag(group: str, category: str, rank: int) -> Dict[str, Any]:
    seed_key = f"{group}|{category}"
    signal = sum((index + 1) * ord(char) for index, char in enumerate(seed_key))
    base_volume = max(180000, 1480000 - rank * 9800)
    search_volume = max(120000, base_volume + (signal % 90000) - 45000)
    trend = round(((signal % 360) - 180) / 10, 1)
    competition = HOT_TAG_COMPETITION_LEVELS[(signal + rank) % len(HOT_TAG_COMPETITION_LEVELS)]
    return {
        "group": group,
        "tag": category,
        "searchVolume": int(search_volume),
        "competition": competition,
        "trend": trend,
        "source": "full-category-catalog",
    }


def _build_hot_tags() -> List[Dict[str, Any]]:
    rows: List[Dict[str, Any]] = []
    seen_tags: set[str] = set()

    for row in HOT_TAG_SEED_ROWS:
        tag = _normalize_hot_tag_text(row.get("tag"))
        if not tag:
            continue
        rows.append(
            {
                "group": _normalize_hot_tag_text(row.get("group")),
                "tag": tag,
                "searchVolume": int(row.get("searchVolume") or 0),
                "competition": _normalize_hot_tag_text(row.get("competition")) or "中",
                "trend": float(row.get("trend") or 0.0),
                "source": "seed",
            }
        )
        seen_tags.add(tag.casefold())

    for raw_row in commission_data.COMMISSION_ROWS:
        group = _normalize_hot_tag_text(raw_row.get("group"))
        category = _normalize_hot_tag_text(raw_row.get("category"))
        if not category:
            continue
        category_key = category.casefold()
        if category_key in seen_tags:
            continue
        rows.append(_build_generated_hot_tag(group, category, len(rows)))
        seen_tags.add(category_key)

    rows.sort(key=lambda item: (-int(item.get("searchVolume") or 0), item.get("tag") or ""))
    return rows


HOT_TAGS: List[Dict[str, Any]] = _build_hot_tags()


def _pick_seller_target_for_search_queries() -> Dict[str, Any]:
    try:
        return _pick_seller_target("seller.ozon.ru/app/analytics/what-to-sell/all-queries")
    except HTTPException:
        return _pick_seller_target()


def _seller_company_id_from_target(target: Dict[str, Any]) -> int:
    try:
        raw_payload = _chrome_runtime_evaluate(
            target,
            """
            (() => JSON.stringify({
              companyId: Number((document.cookie.match(/(?:^|; )sc_company_id=(\\d+)/) || [])[1] || 0),
              sellerUrl: location.href,
            }))()
            """,
            await_promise=False,
        )
        payload = json.loads(str(raw_payload or "{}"))
    except Exception:
        return 0
    return _safe_int(payload.get("companyId"), 0)


def _hot_tag_query_key(value: Any) -> str:
    return _normalize_hot_tag_text(value).casefold()


def _is_seller_hot_tags_cache_fresh(cached_at: float) -> bool:
    return cached_at > 0 and time.time() - cached_at <= SELLER_HOT_TAGS_CACHE_TTL_SECONDS


def _seller_hot_tags_cache_result_is_current(result: Optional[Dict[str, Any]]) -> bool:
    if not isinstance(result, dict):
        return False
    meta = result.get("meta")
    if not isinstance(meta, dict):
        return False
    if str(meta.get("scope") or "") != "seller_all_queries" or not bool(meta.get("generatedAt")):
        return False
    rows = result.get("result")
    if not isinstance(rows, list):
        return False
    first_row = next((row for row in rows if isinstance(row, dict)), None)
    if first_row is None:
        return True
    return "trend7d" in first_row and "trend28d" in first_row


def _seller_hot_tags_result_dynamic_count(result: Optional[Dict[str, Any]]) -> int:
    if not isinstance(result, dict):
        return 0
    meta = result.get("meta")
    if isinstance(meta, dict):
        meta_count = _safe_int(meta.get("visibleDynamicsAvailableCount"), -1)
        if meta_count >= 0:
            return meta_count
    rows = result.get("result")
    if not isinstance(rows, list):
        return 0
    count = 0
    for row in rows:
        if not isinstance(row, dict):
            continue
        if _normalize_hot_tag_dynamic_value(row.get("trend7d")) is not None or _normalize_hot_tag_dynamic_value(
            row.get("trend28d")
        ) is not None:
            count += 1
    return count


def _seller_hot_tags_cache_key(
    tenant_id: Optional[int] = None,
    seller_company_id: int = 0,
) -> str:
    return json.dumps(
        {
            "scope": "seller_hot_tags",
            "tenant_id": tenant_id,
            "seller_company_id": _safe_int(seller_company_id, 0),
            "max_rows": SELLER_HOT_TAGS_MAX_ROWS,
            "group_sample_limit": SELLER_HOT_TAGS_GROUP_SAMPLE_LIMIT,
        },
        ensure_ascii=False,
        sort_keys=True,
    )


def _merge_seller_hot_tags_cached_dynamics(
    result: Dict[str, Any],
    fallback_result: Optional[Dict[str, Any]],
) -> Dict[str, Any]:
    if _seller_hot_tags_result_dynamic_count(result) > 0 or not isinstance(fallback_result, dict):
        return result

    fallback_rows = fallback_result.get("result")
    if not isinstance(fallback_rows, list):
        return result

    fallback_by_query = {}
    for row in fallback_rows:
        if not isinstance(row, dict):
            continue
        query_key = _hot_tag_query_key(row.get("tag"))
        if not query_key:
            continue
        trend7d = _normalize_hot_tag_dynamic_value(row.get("trend7d"))
        trend28d = _normalize_hot_tag_dynamic_value(row.get("trend28d"))
        if trend7d is None and trend28d is None:
            continue
        fallback_by_query[query_key] = {
            "trend7d": trend7d,
            "trend28d": trend28d,
        }

    if not fallback_by_query:
        return result

    merged = copy.deepcopy(result)
    rows = merged.get("result")
    if not isinstance(rows, list):
        return result

    available_count = 0
    for row in rows:
        if not isinstance(row, dict):
            continue
        query_key = _hot_tag_query_key(row.get("tag"))
        fallback_row = fallback_by_query.get(query_key)
        if not fallback_row:
            continue
        if _normalize_hot_tag_dynamic_value(row.get("trend7d")) is None:
            row["trend7d"] = fallback_row.get("trend7d")
        if _normalize_hot_tag_dynamic_value(row.get("trend28d")) is None:
            row["trend28d"] = fallback_row.get("trend28d")
        if _normalize_hot_tag_dynamic_value(row.get("trend7d")) is not None or _normalize_hot_tag_dynamic_value(
            row.get("trend28d")
        ) is not None:
            available_count += 1

    meta = dict(merged.get("meta") or {})
    meta["visibleDynamicsAvailableCount"] = available_count
    meta["usedCachedDynamics"] = available_count > 0
    merged["meta"] = meta
    return merged


def _seller_hot_tags_history_snapshot_from_result(
    result: Optional[Dict[str, Any]],
    cached_at: float,
) -> Optional[Dict[str, Any]]:
    if cached_at <= 0 or not isinstance(result, dict):
        return None
    source_rows = result.get("result")
    if not isinstance(source_rows, list):
        return None

    rows: List[Dict[str, Any]] = []
    for row in source_rows:
        if not isinstance(row, dict):
            continue
        tag = _normalize_hot_tag_text(row.get("tag"))
        if not tag:
            continue
        rows.append(
            {
                "tag": tag,
                "searchVolume": _safe_int(row.get("searchVolume"), 0),
                "trend7d": _normalize_hot_tag_dynamic_value(row.get("trend7d")),
                "trend28d": _normalize_hot_tag_dynamic_value(row.get("trend28d")),
            }
        )
    if not rows:
        return None
    return {"cachedAt": cached_at, "rows": rows}


def _normalize_seller_hot_tags_history(
    payload: Optional[Dict[str, Any]],
    fallback_result: Optional[Dict[str, Any]] = None,
    fallback_cached_at: float = 0.0,
) -> List[Dict[str, Any]]:
    history_rows = payload.get("history") if isinstance(payload, dict) else None
    snapshots: List[Dict[str, Any]] = []

    if isinstance(history_rows, list):
        for snapshot in history_rows:
            if not isinstance(snapshot, dict):
                continue
            cached_at = _safe_float(snapshot.get("cachedAt"), 0.0)
            if cached_at <= 0:
                continue
            raw_rows = snapshot.get("rows")
            if not isinstance(raw_rows, list):
                continue
            rows: List[Dict[str, Any]] = []
            for row in raw_rows:
                if not isinstance(row, dict):
                    continue
                tag = _normalize_hot_tag_text(row.get("tag"))
                if not tag:
                    continue
                rows.append(
                    {
                        "tag": tag,
                        "searchVolume": _safe_int(row.get("searchVolume"), 0),
                        "trend7d": _normalize_hot_tag_dynamic_value(row.get("trend7d")),
                        "trend28d": _normalize_hot_tag_dynamic_value(row.get("trend28d")),
                    }
                )
            if rows:
                snapshots.append({"cachedAt": cached_at, "rows": rows})

    fallback_snapshot = _seller_hot_tags_history_snapshot_from_result(fallback_result, fallback_cached_at)
    if fallback_snapshot:
        snapshots.append(fallback_snapshot)

    deduped: Dict[int, Dict[str, Any]] = {}
    for snapshot in snapshots:
        deduped[int(round(_safe_float(snapshot.get("cachedAt"), 0.0)))] = snapshot

    return sorted(deduped.values(), key=lambda item: _safe_float(item.get("cachedAt"), 0.0))[
        -SELLER_HOT_TAGS_HISTORY_LIMIT :
    ]


def _load_seller_hot_tags_disk_cache(cache_key: str) -> Optional[Dict[str, Any]]:
    try:
        if not SELLER_HOT_TAGS_CACHE_FILE.exists():
            return None
        payload = json.loads(SELLER_HOT_TAGS_CACHE_FILE.read_text(encoding="utf-8"))
    except Exception:
        return None

    if not isinstance(payload, dict):
        return None
    stored_cache_key = str(payload.get("cacheKey") or "")
    if stored_cache_key != cache_key and not _seller_hot_tags_cache_key_allows_tenant_fallback(
        cache_key,
        stored_cache_key,
    ):
        return None

    cached_at = _safe_float(payload.get("cachedAt"), 0.0)
    result = payload.get("result")
    if cached_at <= 0 or not isinstance(result, dict):
        return None

    history = _normalize_seller_hot_tags_history(payload, result, cached_at)
    cache_entry = {"cachedAt": cached_at, "result": result, "history": history}

    with SELLER_HOT_TAGS_CACHE_LOCK:
        SELLER_HOT_TAGS_CACHE[cache_key] = (cached_at, result)
    return cache_entry


def _seller_hot_tags_cache_key_allows_tenant_fallback(
    requested_cache_key: str,
    stored_cache_key: str,
) -> bool:
    try:
        requested = json.loads(requested_cache_key)
        stored = json.loads(stored_cache_key)
    except Exception:
        return False
    if not isinstance(requested, dict) or not isinstance(stored, dict):
        return False
    return (
        requested.get("scope") == "seller_hot_tags"
        and stored.get("scope") == "seller_hot_tags"
        and _safe_int(requested.get("seller_company_id"), 0) == 0
        and requested.get("tenant_id") == stored.get("tenant_id")
        and requested.get("max_rows") == stored.get("max_rows")
        and requested.get("group_sample_limit") == stored.get("group_sample_limit")
    )


def _save_seller_hot_tags_disk_cache(
    cache_key: str,
    cached_at: float,
    result: Dict[str, Any],
    history: Optional[Sequence[Dict[str, Any]]] = None,
) -> None:
    try:
        SELLER_HOT_TAGS_CACHE_FILE.parent.mkdir(parents=True, exist_ok=True)
        history_rows = _normalize_seller_hot_tags_history({"history": list(history or [])}, result, cached_at)
        SELLER_HOT_TAGS_CACHE_FILE.write_text(
            json.dumps(
                {
                    "cacheKey": cache_key,
                    "cachedAt": cached_at,
                    "result": result,
                    "history": history_rows,
                },
                ensure_ascii=False,
            ),
            encoding="utf-8",
        )
    except Exception:
        return


def _percentile(sorted_values: Sequence[int], ratio: float) -> float:
    if not sorted_values:
        return 0.0
    if len(sorted_values) == 1:
        return float(sorted_values[0])
    position = max(0.0, min(1.0, ratio)) * (len(sorted_values) - 1)
    lower_index = int(position)
    upper_index = min(lower_index + 1, len(sorted_values) - 1)
    if lower_index == upper_index:
        return float(sorted_values[lower_index])
    weight = position - lower_index
    lower_value = float(sorted_values[lower_index])
    upper_value = float(sorted_values[upper_index])
    return lower_value + (upper_value - lower_value) * weight


def _hot_tag_competition_label(seller_count: int, thresholds: Sequence[float]) -> str:
    q1, q2, q3 = (list(thresholds) + [0.0, 0.0, 0.0])[:3]
    if seller_count <= q1:
        return "低"
    if seller_count <= q2:
        return "中"
    if seller_count <= q3:
        return "高"
    return "极高"


def _normalize_hot_tag_dynamic_value(value: Any) -> Optional[float]:
    if value is None:
        return None
    if isinstance(value, str):
        normalized = value.strip()
        if not normalized or normalized in {"-", "--", "—"}:
            return None
        if normalized == "=":
            return 0.0
    numeric_value = _safe_float(value, float("nan"))
    if numeric_value != numeric_value:
        return None
    return round(max(min(numeric_value, 999.9), -99.9), 1)


def _normalize_seller_hot_tags_trend_window_days(trend_window_days: int) -> int:
    return 28 if int(trend_window_days or 0) == 28 else 7


def _seller_hot_tags_dynamic_field(trend_window_days: int) -> str:
    return "trend28d" if _normalize_seller_hot_tags_trend_window_days(trend_window_days) == 28 else "trend7d"


def _seller_hot_tags_dynamic_value(row: Dict[str, Any], trend_window_days: int) -> Optional[float]:
    if not isinstance(row, dict):
        return None
    return _normalize_hot_tag_dynamic_value(row.get(_seller_hot_tags_dynamic_field(trend_window_days)))


def _seller_hot_tags_legacy_trend_value(row: Dict[str, Any]) -> Optional[float]:
    if not isinstance(row, dict):
        return None
    if str(row.get("source") or "") == "seller-search-queries":
        return None
    return _normalize_hot_tag_dynamic_value(row.get("trend"))


def _apply_seller_hot_tags_trend_window(
    result: Dict[str, Any],
    history: Sequence[Dict[str, Any]],
    current_cached_at: float,
    trend_window_days: int,
) -> Dict[str, Any]:
    del history
    del current_cached_at
    trend_window_days = _normalize_seller_hot_tags_trend_window_days(trend_window_days)
    dataset = copy.deepcopy(result)
    rows = dataset.get("result")
    if not isinstance(rows, list):
        return dataset

    available_count = 0
    for row in rows:
        if not isinstance(row, dict):
            continue
        dynamic_value = _seller_hot_tags_dynamic_value(row, trend_window_days)
        if dynamic_value is not None:
            available_count += 1
            row["trend"] = dynamic_value
            continue
        row["trend"] = _seller_hot_tags_legacy_trend_value(row)

    meta = dict(dataset.get("meta") or {})
    meta["trendSource"] = "seller_query_dynamics" if available_count > 0 else "unavailable"
    meta["trendBaselineAt"] = ""
    meta["trendWindowActualDays"] = trend_window_days
    meta["trendAvailableCount"] = available_count
    meta["trendWindowDays"] = trend_window_days
    meta["trendAvailableWindows"] = list(SELLER_HOT_TAGS_ALLOWED_TREND_WINDOW_DAYS)
    dataset["meta"] = meta
    return dataset


def _build_seller_hot_tag_rows(
    payload: Dict[str, Any],
) -> List[Dict[str, Any]]:
    primary_group_by_query = {
        _hot_tag_query_key(row.get("query")): _normalize_hot_tag_text(row.get("group"))
        for row in payload.get("queryGroups") or []
        if _hot_tag_query_key(row.get("query"))
    }

    seller_counts = sorted(
        _safe_int(row.get("sellers"), 0)
        for row in payload.get("rows") or []
        if _safe_int(row.get("sellers"), 0) > 0
    )
    thresholds = (
        _percentile(seller_counts, 0.25),
        _percentile(seller_counts, 0.5),
        _percentile(seller_counts, 0.75),
    )

    rows: List[Dict[str, Any]] = []
    for row in payload.get("rows") or []:
        query = _normalize_hot_tag_text(row.get("query"))
        if not query:
            continue

        query_key = _hot_tag_query_key(query)
        search_volume = _safe_int(row.get("count"), 0)
        seller_count = _safe_int(row.get("sellers"), 0)
        rows.append(
            {
                "group": primary_group_by_query.get(query_key) or "",
                "tag": query,
                "searchVolume": search_volume,
                "competition": _hot_tag_competition_label(seller_count, thresholds),
                "trend": None,
                "trend7d": _normalize_hot_tag_dynamic_value(row.get("dynamicsIn7")),
                "trend28d": _normalize_hot_tag_dynamic_value(row.get("dynamicsIn28")),
                "addToCart": _safe_int(row.get("addToCart"), 0),
                "addToCartRate": round(_safe_float(row.get("addToCartRate"), 0.0), 2),
                "orders": _safe_int(row.get("orders"), 0),
                "orderRate": round(_safe_float(row.get("orderRate"), 0.0), 2),
                "noActionCount": _safe_int(row.get("noActionCount"), 0),
                "noActionShare": round(_safe_float(row.get("noActionShare"), 0.0), 2),
                "sellerCount": seller_count,
                "source": "seller-search-queries",
            }
        )

    rows.sort(key=lambda item: (-int(item.get("searchVolume") or 0), item.get("tag") or ""))
    return rows


def _fetch_seller_hot_tags_from_browser(tenant_id: Optional[int] = None) -> Dict[str, Any]:
    target = _pick_seller_target_for_search_queries()
    seller_company_id = _seller_company_id_from_target(target)
    cache_key = _seller_hot_tags_cache_key(tenant_id, seller_company_id)
    with SELLER_HOT_TAGS_CACHE_LOCK:
        cached_entry = SELLER_HOT_TAGS_CACHE.get(cache_key)
    if (
        cached_entry
        and _is_seller_hot_tags_cache_fresh(cached_entry[0])
        and _seller_hot_tags_cache_result_is_current(cached_entry[1])
        and _seller_hot_tags_result_dynamic_count(cached_entry[1]) > 0
    ):
        return cached_entry[1]

    disk_cache_entry = _load_seller_hot_tags_disk_cache(cache_key)
    if (
        disk_cache_entry
        and _is_seller_hot_tags_cache_fresh(float(disk_cache_entry["cachedAt"]))
        and _seller_hot_tags_cache_result_is_current(disk_cache_entry.get("result"))
        and _seller_hot_tags_result_dynamic_count(disk_cache_entry.get("result")) > 0
    ):
        return disk_cache_entry["result"]

    previous_result_with_dynamics: Optional[Dict[str, Any]] = None
    if cached_entry and _seller_hot_tags_result_dynamic_count(cached_entry[1]) > 0:
        previous_result_with_dynamics = cached_entry[1]
    elif disk_cache_entry and _seller_hot_tags_result_dynamic_count(disk_cache_entry.get("result")) > 0:
        previous_result_with_dynamics = disk_cache_entry.get("result")

    history = _normalize_seller_hot_tags_history(
        disk_cache_entry,
        disk_cache_entry.get("result") if disk_cache_entry else None,
        _safe_float(disk_cache_entry.get("cachedAt"), 0.0) if disk_cache_entry else 0.0,
    )

    script = """
    (async () => {
      const maxRows = __MAX_ROWS__
      const groupSampleLimit = __GROUP_SAMPLE_LIMIT__
      const batchSize = __BATCH_SIZE__
      const requestLimit = 50
      const companyId = Number((document.cookie.match(/(?:^|; )sc_company_id=(\\d+)/) || [])[1] || 0)
      if (!companyId) {
        return JSON.stringify({
          ok: false,
          error: '当前 Seller 页面缺少 sc_company_id cookie',
          sellerUrl: location.href,
        })
      }

      const headers = {
        'content-type': 'application/json',
        'x-o3-app-name': 'seller-ui',
        'x-o3-company-id': String(companyId),
        'x-o3-language': document.documentElement.lang || 'zh-Hans',
        'x-o3-page-type': 'analytics_seller',
      }

      const requestJson = async (url, body) => {
        try {
          const response = await fetch(url, {
            method: 'POST',
            credentials: 'include',
            headers,
            body: JSON.stringify(body),
          })
          const text = await response.text()
          let data = null
          try {
            data = JSON.parse(text)
          } catch (error) {
            data = null
          }
          return {
            ok: response.ok,
            status: response.status,
            data,
            text: response.ok ? '' : text.slice(0, 1200),
          }
        } catch (error) {
          return {
            ok: false,
            status: 0,
            data: null,
            text: String(error),
          }
        }
      }

      const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

      const parsePercentText = (value) => {
        const normalized = String(value || '')
          .replace(/[%+\\s]/g, '')
          .replace('−', '-')
          .trim()
        if (!normalized || normalized === '—' || normalized === '--') {
          return null
        }
        if (normalized === '=') {
          return 0
        }
        const numericValue = Number(normalized)
        return Number.isFinite(numericValue) ? numericValue : null
      }

      const parseVisibleRangeText = (value) => {
        const match = String(value || '').trim().match(/^(\\d+)中的(\\d+)-(\\d+)$/)
        if (!match) {
          return null
        }
        return {
          total: Number(match[1]),
          start: Number(match[2]),
          end: Number(match[3]),
        }
      }

      const getVisibleRangeText = () => {
        const matchedTexts = Array.from(document.querySelectorAll('body *'))
          .filter((element) => element.childElementCount === 0)
          .map((element) => String(element.textContent || '').trim())
          .filter((text) => /^\\d+中的\\d+-\\d+$/.test(text))
          .sort((left, right) => left.length - right.length)
        return matchedTexts[0] || ''
      }

      const getVisiblePageRows = () =>
        Array.from(document.querySelectorAll('table tbody tr'))
          .map((row) => {
            const cells = Array.from(row.cells || []).map((cell) => String(cell.innerText || '').trim())
            return {
              query: cells[0] || '',
              trend28d: parsePercentText(cells[2]),
              trend7d: parsePercentText(cells[3]),
            }
          })
          .filter((row) => row.query)

      const getPaginationButtons = () =>
        Array.from(document.querySelectorAll('button')).filter((button) =>
          String(button.className || '').includes('t0c80-a1')
        )

      const getPageButton = (label) =>
        Array.from(document.querySelectorAll('button')).find(
          (button) => String(button.innerText || '').trim() === String(label)
        ) || null

      const getNextPageButton = () => {
        const buttons = getPaginationButtons()
        return buttons.length ? buttons[buttons.length - 1] : null
      }

      const getPreviousPageButton = () => {
        const arrowButtons = getPaginationButtons().filter((button) => !String(button.innerText || '').trim())
        return arrowButtons.length ? arrowButtons[0] : null
      }

      const waitForVisiblePageChange = async (previousRangeText) => {
        const startedAt = Date.now()
        while (Date.now() - startedAt < 20000) {
          await sleep(200)
          const currentRangeText = getVisibleRangeText()
          const currentRows = getVisiblePageRows()
          if (currentRangeText && currentRangeText !== previousRangeText && currentRows.length > 0) {
            return {
              changed: true,
              rangeText: currentRangeText,
              rows: currentRows,
            }
          }
        }
        return {
          changed: false,
          rangeText: getVisibleRangeText(),
          rows: getVisiblePageRows(),
        }
      }

      const goToFirstVisiblePage = async () => {
        const currentRangeText = getVisibleRangeText()
        if (parseVisibleRangeText(currentRangeText)?.start === 1) {
          return true
        }

        const firstPageButton = getPageButton(1)
        if (firstPageButton && !firstPageButton.disabled) {
          firstPageButton.click()
          const result = await waitForVisiblePageChange(currentRangeText)
          return parseVisibleRangeText(result.rangeText)?.start === 1
        }

        const previousPageButton = getPreviousPageButton()
        let guard = 0
        while (previousPageButton && !previousPageButton.disabled && guard < 25) {
          const beforeRangeText = getVisibleRangeText()
          const result = await (async () => {
            previousPageButton.click()
            return waitForVisiblePageChange(beforeRangeText)
          })()
          if (!result.changed) {
            break
          }
          if (parseVisibleRangeText(result.rangeText)?.start === 1) {
            return true
          }
          guard += 1
        }
        return parseVisibleRangeText(getVisibleRangeText())?.start === 1
      }

      const collectVisibleDynamics = async (requestedMaxRows) => {
        const safeMaxRows = Math.max(0, Number(requestedMaxRows || 0))
        const byQuery = Object.create(null)
        if (!safeMaxRows) {
          return { byQuery, availableCount: 0 }
        }

        await goToFirstVisiblePage()

        let pagesVisited = 0
        while (pagesVisited < 250) {
          const currentRangeText = getVisibleRangeText()
          const currentRows = getVisiblePageRows()
          if (!currentRows.length) {
            break
          }

          currentRows.forEach((row) => {
            const queryKey = row.query.toLocaleLowerCase()
            if (!queryKey) {
              return
            }
            byQuery[queryKey] = {
              trend28d: row.trend28d,
              trend7d: row.trend7d,
            }
          })

          pagesVisited += 1

          const currentRange = parseVisibleRangeText(currentRangeText)
          if (currentRange && currentRange.end >= safeMaxRows) {
            break
          }

          const nextPageButton = getNextPageButton()
          if (!nextPageButton || nextPageButton.disabled) {
            break
          }

          nextPageButton.click()
          const nextPage = await waitForVisiblePageChange(currentRangeText)
          if (!nextPage.changed) {
            break
          }
        }

        const availableCount = Object.values(byQuery).filter(
          (row) => row && (row.trend7d !== null || row.trend28d !== null)
        ).length
        return {
          byQuery,
          availableCount,
          collectedCount: Object.keys(byQuery).length,
        }
      }

      const normalizeRow = (row) => ({
        query: String(row?.query || '').trim(),
        count: Number(row?.count || 0),
        dynamicsIn28: null,
        dynamicsIn7: null,
        addToCart: Number(row?.uniqQueriesWCa || 0),
        addToCartRate: Number(row?.ca || 0),
        orders: Number(row?.ord || 0),
        orderRate: Number(row?.searchUsersToOrdUsers || 0),
        noActionCount: Number(row?.usersWithoutInterectionCount || 0),
        noActionShare: Number(row?.usersWithoutInterectionShare || 0),
        sellers: Number(row?.uniqSellers || 0),
      })

      const fetchSearchCollection = async (params, requestedMaxRows) => {
        const safeMaxRows = Math.max(0, Number(requestedMaxRows || 0))
        if (!safeMaxRows) {
          return { ok: true, total: 0, rows: [] }
        }

        const baseBody = {
          text: params.text || '',
          limit: String(requestLimit),
          offset: '0',
          sort_by: 'count',
          sort_dir: 'desc',
          period: params.period || 'days_7',
        }
        if (params.groupName) {
          baseBody.group_name = params.groupName
        }

        const firstPage = await requestJson('/api/site/searchteam/Stats/queries/search/v2', baseBody)
        if (!firstPage.ok) {
          return {
            ok: false,
            status: firstPage.status,
            error: firstPage.text || 'Seller 搜索查询接口调用失败',
          }
        }

        const total = Math.max(0, Number(firstPage.data?.total || 0))
        const cappedTotal = Math.min(total, safeMaxRows)
        let rows = Array.isArray(firstPage.data?.data)
          ? firstPage.data.data.map(normalizeRow).filter((row) => row.query).slice(0, cappedTotal)
          : []

        const offsets = []
        for (let offset = requestLimit; offset < cappedTotal; offset += requestLimit) {
          offsets.push(offset)
        }

        for (let index = 0; index < offsets.length; index += batchSize) {
          const batchOffsets = offsets.slice(index, index + batchSize)
          const batchResults = await Promise.all(
            batchOffsets.map((offset) =>
              requestJson('/api/site/searchteam/Stats/queries/search/v2', {
                ...baseBody,
                offset: String(offset),
              })
            )
          )

          for (const batchResult of batchResults) {
            if (!batchResult.ok) {
              return {
                ok: false,
                status: batchResult.status,
                error: batchResult.text || 'Seller 搜索查询分页调用失败',
              }
            }
          }

          for (const batchResult of batchResults) {
            const batchRows = Array.isArray(batchResult.data?.data)
              ? batchResult.data.data.map(normalizeRow).filter((row) => row.query)
              : []
            rows = rows.concat(batchRows)
            if (rows.length >= cappedTotal) {
              break
            }
          }

          if (rows.length >= cappedTotal) {
            break
          }
        }

        return {
          ok: true,
          total,
          rows: rows.slice(0, cappedTotal),
        }
      }

      const groupResponse = await requestJson('/api/site/searchstat/Stats/queries/groups', {})
      const groupNames = groupResponse.ok && Array.isArray(groupResponse.data?.groups)
        ? groupResponse.data.groups
            .map((row) => String(row?.name || '').trim())
            .filter(Boolean)
        : []

      const mainRowsResponse = await fetchSearchCollection({ period: 'days_7' }, maxRows)
      if (!mainRowsResponse.ok) {
        return JSON.stringify({
          ok: false,
          error: mainRowsResponse.error || 'Seller 搜索查询接口调用失败',
          sellerUrl: location.href,
          companyId,
        })
      }

      const visibleDynamics = await collectVisibleDynamics(maxRows)
      const mainRows = mainRowsResponse.rows.map((row) => {
        const dynamicRow = visibleDynamics.byQuery[row.query.toLocaleLowerCase()] || null
        return {
          ...row,
          dynamicsIn28: dynamicRow ? dynamicRow.trend28d : null,
          dynamicsIn7: dynamicRow ? dynamicRow.trend7d : null,
        }
      })

      const queryGroups = Object.create(null)

      for (let index = 0; index < groupNames.length; index += batchSize) {
        const batchGroupNames = groupNames.slice(index, index + batchSize)
        const batchResponses = await Promise.all(
          batchGroupNames.map((groupName) =>
            fetchSearchCollection({ period: 'days_7', groupName }, groupSampleLimit)
          )
        )

        batchResponses.forEach((response, responseIndex) => {
          if (!response.ok) {
            return
          }
          const groupName = batchGroupNames[responseIndex]
          response.rows.forEach((row) => {
            const key = row.query.toLocaleLowerCase()
            if (!queryGroups[key]) {
              queryGroups[key] = {
                query: row.query,
                bestGroup: groupName,
                bestCount: row.count,
                groups: [groupName],
              }
              return
            }

            if (!queryGroups[key].groups.includes(groupName)) {
              queryGroups[key].groups.push(groupName)
            }
            if (row.count > queryGroups[key].bestCount) {
              queryGroups[key].bestGroup = groupName
              queryGroups[key].bestCount = row.count
            }
          })
        })
      }

      return JSON.stringify({
        ok: true,
        sellerUrl: location.href,
        companyId,
        overallTotal: mainRowsResponse.total,
        fetchedTotal: mainRows.length,
        rows: mainRows,
        visibleDynamicsAvailableCount: Number(visibleDynamics.availableCount || 0),
        queryGroups: Object.values(queryGroups).map((row) => ({
          query: row.query,
          group: row.groups.length === 1 ? row.bestGroup : '',
        })),
        groups: groupNames,
        generatedAt: new Date().toISOString(),
      })
    })()
    """
    script = script.replace("__MAX_ROWS__", str(SELLER_HOT_TAGS_MAX_ROWS))
    script = script.replace("__GROUP_SAMPLE_LIMIT__", str(SELLER_HOT_TAGS_GROUP_SAMPLE_LIMIT))
    script = script.replace("__BATCH_SIZE__", str(SELLER_HOT_TAGS_BATCH_SIZE))

    raw_payload = _chrome_runtime_evaluate(target, script, await_promise=True)
    try:
        payload = json.loads(str(raw_payload or "{}"))
    except Exception as exc:
        raise HTTPException(status_code=400, detail=f"Seller 页面返回了无法解析的数据: {exc}") from exc

    if not payload.get("ok"):
        detail = payload.get("error") or "Seller 搜索查询接口调用失败"
        raise HTTPException(status_code=400, detail=detail)

    cached_at = time.time()
    result = {
        "result": _build_seller_hot_tag_rows(payload),
        "meta": {
            "scope": "seller_all_queries",
            "source": "seller_search_queries",
            "total": _safe_int(payload.get("fetchedTotal"), 0),
            "availableTotal": _safe_int(payload.get("overallTotal"), 0),
            "fetchedTotal": _safe_int(payload.get("fetchedTotal"), 0),
            "groupCount": len(payload.get("groups") or []),
            "period": "days_7",
            "sourceUrl": str(payload.get("sellerUrl") or target.get("url") or ""),
            "companyId": _safe_int(payload.get("companyId"), 0),
            "visibleDynamicsAvailableCount": _safe_int(payload.get("visibleDynamicsAvailableCount"), 0),
            "generatedAt": str(payload.get("generatedAt") or datetime.now(timezone.utc).isoformat()),
            "cacheTtlSeconds": int(SELLER_HOT_TAGS_CACHE_TTL_SECONDS),
            "trendSource": "",
            "trendAvailableWindows": list(SELLER_HOT_TAGS_ALLOWED_TREND_WINDOW_DAYS),
            "isFallback": False,
        },
    }
    result = _merge_seller_hot_tags_cached_dynamics(result, previous_result_with_dynamics)
    history = _normalize_seller_hot_tags_history(
        {"history": history},
        result,
        cached_at,
    )
    with SELLER_HOT_TAGS_CACHE_LOCK:
        SELLER_HOT_TAGS_CACHE[cache_key] = (cached_at, result)
    _save_seller_hot_tags_disk_cache(cache_key, cached_at, result, history)
    return result


def _get_hot_tags_dataset(
    trend_window_days: int = SELLER_HOT_TAGS_DEFAULT_TREND_WINDOW_DAYS,
    tenant_id: Optional[int] = None,
) -> Dict[str, Any]:
    trend_window_days = _normalize_seller_hot_tags_trend_window_days(trend_window_days)
    cache_key = _seller_hot_tags_cache_key(tenant_id)
    try:
        dataset = _fetch_seller_hot_tags_from_browser(tenant_id)
        seller_company_id = _safe_int((dataset.get("meta") or {}).get("companyId"), 0)
        if seller_company_id:
            cache_key = _seller_hot_tags_cache_key(tenant_id, seller_company_id)
        disk_cache_entry = _load_seller_hot_tags_disk_cache(cache_key)
        if disk_cache_entry:
            return _apply_seller_hot_tags_trend_window(
                dataset,
                disk_cache_entry.get("history") or [],
                _safe_float(disk_cache_entry.get("cachedAt"), 0.0),
                trend_window_days,
            )
        return dataset
    except HTTPException as exc:
        disk_cache_entry = _load_seller_hot_tags_disk_cache(cache_key)
        if disk_cache_entry:
            cached_result = _apply_seller_hot_tags_trend_window(
                disk_cache_entry["result"],
                disk_cache_entry.get("history") or [],
                _safe_float(disk_cache_entry.get("cachedAt"), 0.0),
                trend_window_days,
            )
            meta = dict(cached_result.get("meta") or {})
            meta["source"] = "seller_search_queries_cache"
            meta["isFallback"] = True
            meta["cacheStale"] = not _is_seller_hot_tags_cache_fresh(float(disk_cache_entry["cachedAt"]))
            meta["cachedAt"] = datetime.fromtimestamp(
                float(disk_cache_entry["cachedAt"]), timezone.utc
            ).isoformat()
            meta["fallbackReason"] = str(exc.detail)
            cached_result["meta"] = meta
            return cached_result
        return {
            "result": HOT_TAGS,
            "meta": {
                "scope": "all_categories",
                "source": "fallback_full_category_catalog",
                "total": len(HOT_TAGS),
                "availableTotal": len(HOT_TAGS),
                "fetchedTotal": len(HOT_TAGS),
                "generatedAt": datetime.now(timezone.utc).isoformat(),
                "cacheTtlSeconds": int(SELLER_HOT_TAGS_CACHE_TTL_SECONDS),
                "isFallback": True,
                "fallbackReason": str(exc.detail),
            },
        }

MARKET_CATEGORY_BASELINES: Dict[tuple[str, str, str], Dict[str, float]] = {
    ("服饰", "女装", "夹克"): {"sales": 4_280_000.0, "volume": 58_200, "sellers": 1_840},
    ("服饰", "女装", "连衣裙"): {"sales": 5_360_000.0, "volume": 71_600, "sellers": 2_120},
    ("服饰", "男装", "牛仔裤"): {"sales": 3_980_000.0, "volume": 49_300, "sellers": 1_560},
    ("鞋包", "运动鞋", "跑鞋"): {"sales": 4_860_000.0, "volume": 42_800, "sellers": 1_430},
    ("鞋包", "箱包", "双肩包"): {"sales": 2_940_000.0, "volume": 31_500, "sellers": 1_180},
    ("家居", "厨房", "收纳盒"): {"sales": 2_260_000.0, "volume": 64_200, "sellers": 1_760},
    ("家居", "清洁", "拖把"): {"sales": 1_880_000.0, "volume": 47_900, "sellers": 1_340},
    ("数码", "耳机", "无线耳机"): {"sales": 6_420_000.0, "volume": 36_800, "sellers": 1_020},
    ("数码", "配件", "充电器"): {"sales": 3_360_000.0, "volume": 73_200, "sellers": 1_950},
    ("美妆", "护肤", "面膜"): {"sales": 2_780_000.0, "volume": 88_600, "sellers": 2_340},
}

SHIPPING_OPTIONS: List[Dict[str, Any]] = [
    {"short_name": "ECO", "logistics_name": "Economy Line", "delivery_days": "10-16天", "base_fee": 18.0, "per_kg_fee": 22.0},
    {"short_name": "STD", "logistics_name": "Standard Line", "delivery_days": "6-10天", "base_fee": 25.0, "per_kg_fee": 28.0},
    {"short_name": "EXP", "logistics_name": "Express Line", "delivery_days": "3-6天", "base_fee": 36.0, "per_kg_fee": 42.0},
]

PENDING_ORDER_STATUSES = {"awaiting_packaging", "awaiting_deliver"}
COMPLETED_UPLOAD_STATUSES = {"completed", "completed_with_errors"}
FAILED_UPLOAD_STATUSES = {"failed", "submit_failed"}
SUCCESSFUL_UPLOAD_ITEM_STATUSES = {"imported", "processed", "success", "completed", "done"}
FAILED_UPLOAD_ITEM_STATUSES = {"failed", "error", "rejected", "cancelled"}
PENDING_UPLOAD_ITEM_STATUSES = {"pending", "processing", "created", "running"}
ORDER_STATUS_LABELS = {
    "awaiting_packaging": "待备货",
    "awaiting_deliver": "待发货",
    "delivering": "配送中",
    "delivered": "已送达",
    "cancelled": "已取消",
    "driver_pickup": "等待揽收",
}


app = FastAPI(
    title=settings.PROJECT_NAME,
    openapi_url=f"{settings.API_V1_STR}/openapi.json",
)

cors_origins = settings.cors_origins_list or ["*"]

app.add_middleware(
    CORSMiddleware,
    allow_origins=cors_origins,
    allow_credentials="*" not in cors_origins,
    allow_methods=["*"],
    allow_headers=["*"],
)

AUTH_EXCLUDED_PATHS = {
    f"{settings.API_V1_STR}/auth/login",
    f"{settings.API_V1_STR}/auth/register",
    f"{settings.API_V1_STR}/health",
}


def _create_access_token(user: models.User, db: Session) -> str:
    expires_at = datetime.now(timezone.utc) + timedelta(
        minutes=settings.ACCESS_TOKEN_EXPIRE_MINUTES
    )
    user_payload = _serialize_auth_user(user, db)
    return jwt.encode(
        {
            "sub": user.username,
            "uid": user.id,
            "tenant_id": user_payload.get("tenant_id"),
            "roles": user_payload.get("roles", []),
            "is_admin": bool(user_payload.get("is_super_admin")),
            "exp": expires_at,
        },
        settings.SECRET_KEY,
        algorithm="HS256",
    )


def _decode_access_token(token: str) -> Dict[str, Any]:
    try:
        payload = jwt.decode(token, settings.SECRET_KEY, algorithms=["HS256"])
    except JWTError as exc:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Invalid or expired token",
        ) from exc

    username = payload.get("sub")
    if not username or not isinstance(username, str):
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Invalid token subject",
        )
    roles = payload.get("roles") or []
    if not isinstance(roles, list):
        roles = []
    return {
        "username": username,
        "user_id": payload.get("uid"),
        "tenant_id": payload.get("tenant_id"),
        "roles": roles,
        "is_admin": bool(payload.get("is_admin")),
    }


@app.middleware("http")
async def require_api_auth(request: Request, call_next):
    path = request.url.path
    if path.startswith(settings.API_V1_STR):
        if path not in AUTH_EXCLUDED_PATHS:
            authorization = request.headers.get("Authorization", "")
            scheme, _, token = authorization.partition(" ")
            if scheme.lower() != "bearer" or not token:
                return JSONResponse(
                    status_code=status.HTTP_401_UNAUTHORIZED,
                    content={"detail": "Authentication required"},
                )
            try:
                token_payload = _decode_access_token(token)
                request.state.current_user = token_payload["username"]
                request.state.current_user_id = token_payload.get("user_id")
                request.state.current_tenant_id = token_payload.get("tenant_id")
                request.state.current_roles = token_payload.get("roles", [])
                request.state.current_is_admin = token_payload.get("is_admin", False)
            except HTTPException as exc:
                return JSONResponse(
                    status_code=exc.status_code,
                    content={"detail": exc.detail},
                )
    return await call_next(request)


def _require_super_admin(request: Request, db: Session = Depends(get_db)) -> models.User:
    username = _current_username(request)
    user = _find_user_by_username(db, username)
    if not user or not user.is_active:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="User not found or disabled",
        )
    roles = set(_request_role_codes(request)) | set(
        _user_role_codes(db, user, user.primary_tenant_id)
    )
    if not user.is_admin and "super_admin" not in roles:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Super admin permission required",
        )
    return user


def _client_ip(request: Request) -> Optional[str]:
    forwarded_for = request.headers.get("x-forwarded-for")
    if forwarded_for:
        return forwarded_for.split(",", 1)[0].strip()
    return request.client.host if request.client else None


def _write_audit_log(
    db: Session,
    request: Request,
    action: str,
    resource_type: Optional[str] = None,
    resource_id: Optional[str] = None,
    details: Optional[Dict[str, Any]] = None,
    tenant_id: Optional[int] = None,
) -> None:
    db.add(
        models.AuditLog(
            tenant_id=tenant_id if tenant_id is not None else _current_tenant_id(request),
            user_id=_current_user_id(request),
            actor_username=_current_username(request),
            action=action,
            resource_type=resource_type,
            resource_id=resource_id,
            details=json.dumps(details, ensure_ascii=False) if details else None,
            ip_address=_client_ip(request),
            user_agent=request.headers.get("user-agent"),
        )
    )


def _database_health() -> Dict[str, Any]:
    try:
        with engine.connect() as connection:
            connection.execute(text("SELECT 1"))
        return {
            "status": "ok",
            "dialect": engine.url.get_backend_name(),
        }
    except Exception as exc:
        return {
            "status": "error",
            "dialect": engine.url.get_backend_name(),
            "detail": str(exc),
        }


def _browser_assist_health() -> Dict[str, Any]:
    try:
        with httpx.Client(timeout=3.0, trust_env=False) as client:
            response = client.get(f"{CHROME_DEVTOOLS_BASE}/json/version")
            response.raise_for_status()
            payload = response.json()
    except Exception as exc:
        return {
            "status": "error",
            "base_url": CHROME_DEVTOOLS_BASE,
            "detail": str(exc),
        }

    return {
        "status": "ok",
        "base_url": CHROME_DEVTOOLS_BASE,
        "browser": payload.get("Browser"),
        "user_agent": payload.get("User-Agent"),
    }


def _build_health_payload(*, include_browser: bool = False) -> Dict[str, Any]:
    database = _database_health()
    payload: Dict[str, Any] = {
        "status": "ok" if database["status"] == "ok" else "degraded",
        "service": "oumaitong-management-api",
        "environment": settings.APP_ENV,
        "started_at": SERVICE_STARTED_AT.isoformat(),
        "api_prefix": settings.API_V1_STR,
        "database": database,
    }

    if include_browser:
        browser_assist = _browser_assist_health()
        if browser_assist["status"] != "ok" and payload["status"] == "ok":
            payload["status"] = "degraded"
        payload["browser_assist"] = browser_assist

    return payload


def _health_status_code(payload: Dict[str, Any]) -> int:
    return 200 if payload.get("database", {}).get("status") == "ok" else 503


def _redis_client():
    try:
        from redis import Redis

        return Redis.from_url(
            settings.REDIS_URL,
            decode_responses=True,
            socket_connect_timeout=0.8,
            socket_timeout=0.8,
        )
    except Exception:
        return None


def _enforce_redis_rate_limit(key: str, *, limit: int, window_seconds: int, detail: str) -> None:
    redis_client = _redis_client()
    if redis_client is None:
        return
    try:
        count = int(redis_client.incr(key))
        if count == 1:
            redis_client.expire(key, int(window_seconds))
    except Exception:
        return
    if count > int(limit):
        raise HTTPException(status_code=429, detail=detail)


def _submit_async_task(
    task_name: str,
    *,
    queue: Optional[str] = None,
    countdown: Optional[int] = None,
    **kwargs: Any,
) -> Dict[str, Any]:
    if not CELERY_AVAILABLE or celery_app is None:
        raise HTTPException(
            status_code=503,
            detail="Async task worker is unavailable because Celery is not installed.",
        )

    broker_url = str(getattr(settings, "CELERY_BROKER_URL", "") or "")
    parsed_broker = urlparse(broker_url)
    if parsed_broker.scheme.startswith("redis"):
        broker_host = parsed_broker.hostname or "localhost"
        broker_port = int(parsed_broker.port or 6379)
        try:
            with socket.create_connection((broker_host, broker_port), timeout=0.8):
                pass
        except OSError:
            raise HTTPException(
                status_code=503,
                detail=(
                    f"Async task broker is unavailable at {broker_host}:{broker_port}. "
                    "Please start Redis worker first."
                ),
            )

    filtered_kwargs = {key: value for key, value in kwargs.items() if value is not None}
    task_options: Dict[str, Any] = {}
    if queue:
        task_options["queue"] = queue
    if countdown is not None:
        task_options["countdown"] = max(0, int(countdown))
    try:
        async_result = celery_app.send_task(
            task_name,
            kwargs=filtered_kwargs,
            **task_options,
        )
    except Exception as exc:
        raise HTTPException(
            status_code=503,
            detail=f"Failed to submit async task {task_name}: {exc}",
        ) from exc

    return {
        "message": f"Submitted async task {task_name}",
        "mode": "async",
        "task_id": async_result.id,
        "task_name": task_name,
        "queue": queue or "default",
        "status": async_result.status,
    }


def _serialize_async_result(task_id: str) -> Dict[str, Any]:
    if not CELERY_AVAILABLE or celery_app is None or AsyncResult is None:
        raise HTTPException(
            status_code=503,
            detail="Async task worker is unavailable because Celery is not installed.",
        )

    try:
        result = AsyncResult(task_id, app=celery_app)
        payload: Dict[str, Any] = {
            "task_id": task_id,
            "task_name": getattr(result, "name", None),
            "status": result.status,
            "ready": result.ready(),
            "successful": result.successful(),
            "failed": result.failed(),
            "result": None,
            "error": None,
        }

        if result.successful():
            payload["result"] = result.result
        elif result.failed():
            payload["error"] = str(result.result)
        elif result.info not in (None, {}):
            if isinstance(result.info, Exception):
                payload["error"] = str(result.info)
            else:
                payload["result"] = result.info
        return payload
    except Exception as exc:
        raise HTTPException(
            status_code=503,
            detail=f"Failed to query task status {task_id}: {exc}",
        ) from exc


def _load_json(raw_value: Optional[str]) -> Optional[Dict[str, Any]]:
    if not raw_value:
        return None
    try:
        return json.loads(raw_value)
    except json.JSONDecodeError:
        return {"raw": raw_value}


def _safe_float(value: Any, default: float = 0.0) -> float:
    try:
        if value is None or value == "":
            return default
        if isinstance(value, bool):
            return float(value)
        return float(str(value).replace(",", "").strip())
    except (TypeError, ValueError):
        return default


def _safe_int(value: Any, default: int = 0) -> int:
    return int(round(_safe_float(value, float(default))))


def _format_datetime(value: Optional[datetime]) -> Optional[datetime]:
    return value


def _as_utc(value: Optional[datetime]) -> Optional[datetime]:
    if value is None:
        return None
    if value.tzinfo is None:
        return value.replace(tzinfo=timezone.utc)
    return value.astimezone(timezone.utc)


def _parse_datetime(value: Any) -> Optional[datetime]:
    if not value:
        return None
    if isinstance(value, datetime):
        return _as_utc(value)
    if not isinstance(value, str):
        return None

    normalized = value.strip().replace("Z", "+00:00")
    try:
        return _as_utc(datetime.fromisoformat(normalized))
    except ValueError:
        pass

    for fmt in ("%Y-%m-%d %H:%M:%S", "%Y-%m-%dT%H:%M:%S"):
        try:
            return _as_utc(datetime.strptime(value, fmt))
        except ValueError:
            continue
    return None


def _format_order_status(status: str) -> str:
    return ORDER_STATUS_LABELS.get(status, status or "unknown")


def _demo_order_query(db: Session, store_id: Optional[int] = None):
    query = db.query(models.OrderRecord).filter(models.OrderRecord.sender_name == "系统初始化")
    if store_id is not None:
        query = query.filter(models.OrderRecord.store_id == store_id)
    return query


def _extract_upload_item_offer_id(item: Dict[str, Any], index: int, store_id: int) -> str:
    offer_id = str(item.get("offer_id") or item.get("sku") or "").strip()
    return offer_id or f"offer-{store_id}-{index}"


def _extract_upload_item_sku(item: Dict[str, Any], offer_id: str) -> Optional[str]:
    sku = str(item.get("sku") or item.get("barcode") or offer_id or "").strip()
    return sku or None


def _upload_job_items_for_job(db: Session, job_id: int) -> List[models.UploadJobItem]:
    return (
        db.query(models.UploadJobItem)
        .filter(models.UploadJobItem.upload_job_id == job_id)
        .order_by(models.UploadJobItem.id.asc())
        .all()
    )


def _upload_job_items_by_job_ids(
    db: Session,
    job_ids: Iterable[int],
) -> Dict[int, List[models.UploadJobItem]]:
    unique_job_ids = [job_id for job_id in {int(job_id) for job_id in job_ids if job_id is not None}]
    if not unique_job_ids:
        return {}
    rows = (
        db.query(models.UploadJobItem)
        .filter(models.UploadJobItem.upload_job_id.in_(unique_job_ids))
        .order_by(models.UploadJobItem.upload_job_id.asc(), models.UploadJobItem.id.asc())
        .all()
    )
    grouped: Dict[int, List[models.UploadJobItem]] = {job_id: [] for job_id in unique_job_ids}
    for row in rows:
        grouped.setdefault(row.upload_job_id, []).append(row)
    return grouped


def _serialize_upload_job_item(item: models.UploadJobItem) -> Dict[str, Any]:
    return {
        "id": item.id,
        "upload_job_id": item.upload_job_id,
        "store_id": item.store_id,
        "offer_id": item.offer_id,
        "sku": item.sku,
        "status": item.status,
        "request_payload": _load_json(item.request_payload) or {},
        "result_payload": _load_json(item.result_payload),
        "error": item.error,
        "ozon_product_id": item.ozon_product_id,
        "attempt_count": item.attempt_count or 0,
        "created_at": _format_datetime(item.created_at),
        "updated_at": _format_datetime(item.updated_at),
    }


def _serialize_upload_job(
    job: models.UploadJob,
    store_name: Optional[str],
    items: Optional[List[models.UploadJobItem]] = None,
) -> Dict[str, Any]:
    return {
        "id": job.id,
        "store_id": job.store_id,
        "store_name": store_name,
        "status": job.status,
        "item_count": job.item_count,
        "source": job.source,
        "local_task_id": job.local_task_id,
        "ozon_task_id": job.ozon_task_id,
        "attempt_count": int(job.attempt_count or 0),
        "max_attempts": int(job.max_attempts or UPLOAD_MAX_ATTEMPTS),
        "celery_task_id": job.celery_task_id,
        "locked_at": _format_datetime(job.locked_at),
        "started_at": _format_datetime(job.started_at),
        "finished_at": _format_datetime(job.finished_at),
        "next_attempt_at": _format_datetime(job.next_attempt_at),
        "last_refreshed_at": _format_datetime(job.last_refreshed_at),
        "next_refresh_at": _format_datetime(job.next_refresh_at),
        "cancel_requested": bool(job.cancel_requested),
        "canceled_at": _format_datetime(job.canceled_at),
        "timeout_seconds": int(job.timeout_seconds or UPLOAD_TIMEOUT_SECONDS),
        "request_payload": _load_json(job.request_payload) or {},
        "result_payload": _load_json(job.result_payload),
        "error": job.error,
        "items": [_serialize_upload_job_item(item) for item in items] if items is not None else [],
        "created_at": _format_datetime(job.created_at),
        "updated_at": _format_datetime(job.updated_at),
    }


def _extract_upload_result_items(result_payload: Optional[Dict[str, Any]]) -> List[Dict[str, Any]]:
    if not isinstance(result_payload, dict):
        return []

    containers: List[Dict[str, Any]] = [result_payload]
    data = result_payload.get("data")
    if isinstance(data, dict):
        containers.append(data)
        task_result = data.get("result")
        if isinstance(task_result, dict):
            containers.append(task_result)
    result = result_payload.get("result")
    if isinstance(result, dict):
        containers.append(result)

    items: Optional[List[Any]] = None
    for container in containers:
        candidate = container.get("items")
        if isinstance(candidate, list):
            items = candidate
            break

    if items is None:
        return []

    return [item for item in items if isinstance(item, dict)]


def _normalize_upload_item_status(value: Any) -> str:
    return str(value or "").strip().lower()


def _count_successful_upload_skus(result_payload: Optional[Dict[str, Any]]) -> int:
    return sum(
        1
        for item in _extract_upload_result_items(result_payload)
        if _normalize_upload_item_status(item.get("status")) in SUCCESSFUL_UPLOAD_ITEM_STATUSES
    )


def _serialize_product(product: models.Product, store_name: Optional[str]) -> Dict[str, Any]:
    return {
        "id": product.id,
        "store_id": product.store_id,
        "store_name": store_name,
        "upload_job_id": product.upload_job_id,
        "offer_id": product.offer_id,
        "sku": product.sku,
        "article_no": product.article_no,
        "product_name": product.product_name,
        "primary_image": product.primary_image,
        "info": product.info,
        "source": product.source,
        "category_level_1": product.category_level_1,
        "category_level_2": product.category_level_2,
        "category_level_3": product.category_level_3,
        "status": "archived" if product.archived else product.status,
        "archived": product.archived,
        "auto_restock": product.auto_restock,
        "scheduled_shelf": product.scheduled_shelf,
        "warehouse_name": product.warehouse_name,
        "price": round(product.price or 0.0, 2),
        "display_price": round(product.display_price or 0.0, 2),
        "profit": round(product.profit or 0.0, 2),
        "stock": product.stock or 0,
        "backup_stock": product.backup_stock or 0,
        "weight_g": round(product.weight_g or 0.0, 2),
        "length_mm": round(product.length_mm or 0.0, 2),
        "width_mm": round(product.width_mm or 0.0, 2),
        "height_mm": round(product.height_mm or 0.0, 2),
        "dimensions": f"{int(product.length_mm or 0)}/{int(product.width_mm or 0)}/{int(product.height_mm or 0)}",
        "remark": product.remark,
        "country": product.country,
        "created_at": _format_datetime(product.created_at),
        "updated_at": _format_datetime(product.updated_at),
    }


def _extract_store_warehouse_name(store: Optional[models.Store], fallback: Optional[str] = None) -> str:
    if fallback and str(fallback).strip():
        return str(fallback).strip()
    if store and store.warehouse_info:
        for line in str(store.warehouse_info).splitlines():
            candidate = line.strip()
            if candidate:
                return candidate
    if store and store.store_name:
        return f"{store.store_name} 默认仓库"
    return "默认仓库"


def _serialize_order(order: models.OrderRecord, store_name: Optional[str]) -> Dict[str, Any]:
    deadline_at = _as_utc(order.deadline_at)
    created_at = _as_utc(order.created_at)
    deadline_label = (
        deadline_at.strftime("%Y-%m-%d %H:%M")
        if deadline_at
        else "-"
    )
    created_label = (
        created_at.strftime("%Y-%m-%d %H:%M")
        if created_at
        else "-"
    )
    return {
        "id": order.id,
        "store_id": order.store_id,
        "store_name": store_name,
        "posting_number": order.posting_number,
        "scheme": order.scheme,
        "status": order.status,
        "status_label": order.status_label,
        "deadline_at": _format_datetime(deadline_at),
        "deadline_label": deadline_label,
        "amount": round(order.amount or 0.0, 2),
        "amount_label": f"{round(order.amount or 0.0, 2)} {order.currency}",
        "currency": order.currency,
        "all_waybills": order.all_waybills,
        "domestic_waybill": order.domestic_waybill,
        "tracking_no": order.tracking_no,
        "sender_name": order.sender_name,
        "product_name": order.product_name,
        "product_image": order.product_image,
        "total_pieces": order.total_pieces,
        "warehouse_status": order.warehouse_status,
        "responsible_person": order.responsible_person,
        "length_mm": round(order.length_mm or 0.0, 2),
        "width_mm": round(order.width_mm or 0.0, 2),
        "height_mm": round(order.height_mm or 0.0, 2),
        "dimensions": f"{int(order.length_mm or 0)}/{int(order.width_mm or 0)}/{int(order.height_mm or 0)}",
        "weight_g": round(order.weight_g or 0.0, 2),
        "estimated_price": round(order.estimated_price or 0.0, 2),
        "total_purchase_price": round(order.total_purchase_price or 0.0, 2),
        "labeling_fee": round(order.labeling_fee or 0.0, 2),
        "warehouse_name": order.warehouse_name,
        "logistics_type": order.logistics_type,
        "inbound_status": order.inbound_status,
        "printed": order.printed,
        "downloaded": order.downloaded,
        "closed": order.closed,
        "created_at": _format_datetime(created_at),
        "created_at_label": created_label,
        "updated_at": _format_datetime(order.updated_at),
    }


def _resolve_store(
    db: Session,
    store_id: Optional[int] = None,
    store_name: Optional[str] = None,
    username: Optional[str] = None,
) -> models.Store:
    query = db.query(models.Store)
    if username:
        user = _find_user_by_username(db, username)
        tenant_id = user.primary_tenant_id if user else None
        if tenant_id is not None:
            query = query.filter(models.Store.tenant_id == tenant_id)
        else:
            query = query.filter(models.Store.user_owner == username)

    if store_id is not None:
        store = query.filter(models.Store.id == store_id).first()
    elif store_name:
        store = (
            query
            .filter(models.Store.store_name == store_name)
            .order_by(models.Store.id.asc())
            .first()
        )
    else:
        store = query.order_by(models.Store.id.asc()).first()

    if not store:
        raise HTTPException(
            status_code=400,
            detail="No store configured. Please add a store first.",
        )
    return store


def _resolve_store_credentials(
    db: Session, store_id: Optional[int] = None, username: Optional[str] = None
) -> tuple[str, str, int]:
    store = _resolve_store(db, store_id, username=username)
    return store.client_id, store.api_key, store.id


def _validate_upload_items(items: List[Dict[str, Any]]) -> None:
    if not items:
        raise HTTPException(status_code=400, detail="items cannot be empty")
    if len(items) > 100:
        raise HTTPException(status_code=400, detail="items cannot exceed 100 per job")

    required_fields = ("offer_id", "description_category_id", "type_id", "primary_image")
    seen_offer_ids: set[str] = set()
    for index, item in enumerate(items, start=1):
        if not isinstance(item, dict):
            raise HTTPException(
                status_code=400,
                detail=f"item #{index} must be an object",
            )

        missing_fields = [field for field in required_fields if not item.get(field)]
        if missing_fields:
            raise HTTPException(
                status_code=400,
                detail=f"item #{index} is missing required fields: {', '.join(missing_fields)}",
            )

        offer_id = str(item.get("offer_id") or "").strip()
        if offer_id in seen_offer_ids:
            raise HTTPException(
                status_code=400,
                detail=f"item #{index} has duplicate offer_id: {offer_id}",
            )
        seen_offer_ids.add(offer_id)

        images = item.get("images")
        if images is not None and not isinstance(images, list):
            raise HTTPException(
                status_code=400,
                detail=f"item #{index} field 'images' must be a list when provided",
            )


RAW_LOCAL_ARTIFACT_KEYS = {
    "raw_html",
    "rawHtml",
    "html",
    "page_html",
    "pageHtml",
    "har",
    "har_entries",
    "harEntries",
    "network_log",
    "networkLog",
    "screenshots",
    "screenshot",
    "image_package",
    "imagePackage",
    "raw_images",
    "rawImages",
}


def _strip_raw_local_artifacts(value: Any) -> Any:
    if isinstance(value, dict):
        return {
            key: _strip_raw_local_artifacts(item)
            for key, item in value.items()
            if key not in RAW_LOCAL_ARTIFACT_KEYS
        }
    if isinstance(value, list):
        return [_strip_raw_local_artifacts(item) for item in value]
    return value


def _sanitize_upload_items_for_cloud(items: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
    return [
        cleaned
        for cleaned in (
            _strip_raw_local_artifacts(copy.deepcopy(item))
            for item in items
            if isinstance(item, dict)
        )
        if isinstance(cleaned, dict)
    ]


def _create_upload_job_items(
    db: Session,
    *,
    job: models.UploadJob,
    items: List[Dict[str, Any]],
) -> List[models.UploadJobItem]:
    rows: List[models.UploadJobItem] = []
    for index, item in enumerate(items, start=1):
        offer_id = _extract_upload_item_offer_id(item, index, job.store_id)
        row = models.UploadJobItem(
            tenant_id=job.tenant_id,
            upload_job_id=job.id,
            store_id=job.store_id,
            offer_id=offer_id,
            sku=_extract_upload_item_sku(item, offer_id),
            status="queued",
            request_payload=json.dumps(item, ensure_ascii=False),
        )
        db.add(row)
        rows.append(row)
    db.flush()
    return rows


def _json_dumps_or_none(value: Optional[Dict[str, Any]]) -> Optional[str]:
    if value is None:
        return None
    return json.dumps(value, ensure_ascii=False)


def _extract_upload_result_error(item: Dict[str, Any]) -> Optional[str]:
    for key in ("error", "errors", "message", "messages", "status_message", "fail_reason"):
        value = item.get(key)
        if value in (None, "", [], {}):
            continue
        if isinstance(value, (dict, list)):
            return json.dumps(value, ensure_ascii=False)
        return str(value)
    return None


def _extract_upload_result_product_id(item: Dict[str, Any]) -> Optional[str]:
    for key in ("product_id", "productId", "ozon_product_id", "ozonProductId"):
        value = item.get(key)
        if value not in (None, ""):
            return str(value)
    return None


def _upload_item_status_from_result(item: Dict[str, Any], default_status: str = "processing") -> str:
    normalized = _normalize_upload_item_status(
        item.get("status") or item.get("state") or item.get("status_code")
    )
    if normalized in SUCCESSFUL_UPLOAD_ITEM_STATUSES:
        return "completed"
    if normalized in FAILED_UPLOAD_ITEM_STATUSES:
        return "failed"
    if normalized in PENDING_UPLOAD_ITEM_STATUSES:
        return "processing"
    return normalized or default_status


def _upload_result_item_keys(item: Dict[str, Any]) -> List[str]:
    keys: List[str] = []
    for key in ("offer_id", "offerId", "offerID", "sku", "product_id", "productId"):
        value = item.get(key)
        if value in (None, ""):
            continue
        keys.append(str(value).strip())
    return [key for key in keys if key]


def _update_upload_job_items_from_result(
    db: Session,
    *,
    job: models.UploadJob,
    result_payload: Optional[Dict[str, Any]],
    default_status: str,
    default_error: Optional[str] = None,
) -> None:
    rows = _upload_job_items_for_job(db, job.id)
    if not rows:
        return

    result_items = _extract_upload_result_items(result_payload)
    if not result_items:
        result_json = _json_dumps_or_none(result_payload)
        for row in rows:
            row.status = default_status
            row.result_payload = result_json
            row.error = default_error
        return

    by_key: Dict[str, Dict[str, Any]] = {}
    for result_item in result_items:
        for key in _upload_result_item_keys(result_item):
            by_key[key] = result_item

    for index, row in enumerate(rows):
        result_item = by_key.get(row.offer_id)
        if result_item is None and row.sku:
            result_item = by_key.get(row.sku)
        if result_item is None and len(result_items) == len(rows):
            result_item = result_items[index]
        if result_item is None:
            row.status = default_status
            row.error = default_error
            continue

        row.status = _upload_item_status_from_result(result_item, default_status)
        row.result_payload = json.dumps(result_item, ensure_ascii=False)
        row.error = _extract_upload_result_error(result_item)
        row.ozon_product_id = _extract_upload_result_product_id(result_item)


def _set_upload_job_items_status(
    db: Session,
    job: models.UploadJob,
    status_value: str,
    error: Optional[str] = None,
) -> None:
    for row in _upload_job_items_for_job(db, job.id):
        row.status = status_value
        row.error = error


def _upload_retry_delay_seconds(attempt_count: int) -> int:
    return min(900, 60 * (2 ** max(int(attempt_count or 1) - 1, 0)))


def _mark_upload_job_for_retry_or_failed(
    db: Session,
    job: models.UploadJob,
    error: str,
) -> None:
    now = datetime.now(timezone.utc)
    job.locked_at = None
    job.celery_task_id = None
    job.error = error
    if job.cancel_requested:
        job.status = "canceled"
        job.canceled_at = now
        job.finished_at = now
        _set_upload_job_items_status(db, job, "canceled", error)
        return

    if int(job.attempt_count or 0) < int(job.max_attempts or UPLOAD_MAX_ATTEMPTS):
        job.status = "retrying"
        job.next_attempt_at = now + timedelta(seconds=_upload_retry_delay_seconds(job.attempt_count or 1))
        _set_upload_job_items_status(db, job, "retrying", error)
        return

    job.status = "failed"
    job.finished_at = now
    _set_upload_job_items_status(db, job, "failed", error)


def _active_upload_store_count(db: Session, tenant_id: Optional[int] = None) -> int:
    query = db.query(func.count(func.distinct(models.UploadJob.store_id))).filter(
        models.UploadJob.status.in_(UPLOAD_ACTIVE_STATUSES)
    )
    if tenant_id is None:
        query = query.filter(models.UploadJob.tenant_id.is_(None))
    else:
        query = query.filter(models.UploadJob.tenant_id == tenant_id)
    return int(query.scalar() or 0)


def _global_active_upload_store_count(db: Session) -> int:
    return int(
        db.query(func.count(func.distinct(models.UploadJob.store_id)))
        .filter(models.UploadJob.status.in_(UPLOAD_ACTIVE_STATUSES))
        .scalar()
        or 0
    )


def _store_has_active_upload(db: Session, store_id: int, exclude_job_id: Optional[int] = None) -> bool:
    query = db.query(models.UploadJob.id).filter(
        models.UploadJob.store_id == store_id,
        models.UploadJob.status.in_(UPLOAD_ACTIVE_STATUSES),
    )
    if exclude_job_id is not None:
        query = query.filter(models.UploadJob.id != exclude_job_id)
    return query.first() is not None


def _upload_job_can_dispatch(db: Session, job: models.UploadJob) -> tuple[bool, str]:
    if job.cancel_requested:
        return False, "cancel_requested"
    if _store_has_active_upload(db, job.store_id, exclude_job_id=job.id):
        return False, "store_upload_active"
    if _active_upload_store_count(db, job.tenant_id) >= int(settings.UPLOAD_MAX_ACTIVE_STORES_PER_TENANT):
        return False, "tenant_upload_store_limit"
    if _global_active_upload_store_count(db) >= int(settings.UPLOAD_MAX_GLOBAL_ACTIVE_STORES):
        return False, "global_upload_store_limit"
    return True, "ready"


def _acquire_redis_lock(name: str, ttl_seconds: int = 30) -> Optional[str]:
    redis_client = _redis_client()
    if redis_client is None:
        return None
    token = secrets.token_hex(12)
    try:
        acquired = redis_client.set(f"lock:{name}", token, nx=True, ex=int(ttl_seconds))
    except Exception:
        return None
    return token if acquired else ""


def _release_redis_lock(name: str, token: Optional[str]) -> None:
    if not token:
        return
    redis_client = _redis_client()
    if redis_client is None:
        return
    lock_key = f"lock:{name}"
    try:
        if redis_client.get(lock_key) == token:
            redis_client.delete(lock_key)
    except Exception:
        return


def _recover_expired_upload_jobs(db: Session, now: datetime) -> int:
    candidates = (
        db.query(models.UploadJob)
        .filter(models.UploadJob.status.in_({"dispatching", "uploading"}))
        .filter(models.UploadJob.locked_at.isnot(None))
        .all()
    )
    recovered = 0
    for job in candidates:
        locked_at = _as_utc(job.locked_at)
        timeout_seconds = int(job.timeout_seconds or UPLOAD_TIMEOUT_SECONDS)
        if locked_at and locked_at + timedelta(seconds=timeout_seconds) > now:
            continue
        _mark_upload_job_for_retry_or_failed(db, job, "upload_timeout")
        recovered += 1
    if recovered:
        db.commit()
    return recovered


def dispatch_upload_jobs(limit: int = UPLOAD_DISPATCH_LIMIT) -> Dict[str, Any]:
    lock_token = _acquire_redis_lock("upload_dispatch", ttl_seconds=30)
    if lock_token == "":
        return {"ok": True, "message": "Upload dispatcher already running", "dispatched": 0}

    db = SessionLocal()
    now = datetime.now(timezone.utc)
    dispatched = 0
    skipped: Dict[str, int] = {}
    recovered = 0
    try:
        recovered = _recover_expired_upload_jobs(db, now)
        candidates = (
            db.query(models.UploadJob)
            .filter(models.UploadJob.status.in_(UPLOAD_RETRYABLE_STATUSES))
            .filter(
                or_(
                    models.UploadJob.next_attempt_at.is_(None),
                    models.UploadJob.next_attempt_at <= now,
                )
            )
            .order_by(models.UploadJob.id.asc())
            .limit(max(int(limit or 1) * 3, 1))
            .all()
        )

        for job in candidates:
            if dispatched >= int(limit or 1):
                break
            can_dispatch, reason = _upload_job_can_dispatch(db, job)
            if not can_dispatch:
                if reason == "cancel_requested":
                    job.status = "canceled"
                    job.canceled_at = now
                    job.finished_at = now
                    _set_upload_job_items_status(db, job, "canceled", "cancel_requested")
                    db.commit()
                skipped[reason] = skipped.get(reason, 0) + 1
                continue

            job.status = "dispatching"
            job.locked_at = now
            job.started_at = job.started_at or now
            job.error = None
            _set_upload_job_items_status(db, job, "dispatching")
            db.commit()

            try:
                queue_result = _submit_async_task(
                    "ozon.upload_job",
                    queue="upload",
                    job_id=job.id,
                )
            except HTTPException as exc:
                job.status = "queue_failed"
                job.locked_at = None
                job.error = str(exc.detail or "queue_failed")
                _set_upload_job_items_status(db, job, "queue_failed", job.error)
                db.commit()
                skipped["queue_failed"] = skipped.get("queue_failed", 0) + 1
                continue

            queue_payload = _load_json(job.result_payload) or {}
            queue_payload["upload_queue"] = queue_result
            job.celery_task_id = queue_result.get("task_id")
            job.result_payload = json.dumps(queue_payload, ensure_ascii=False)
            db.commit()
            dispatched += 1

        return {
            "ok": True,
            "message": f"Dispatched {dispatched} upload job(s)",
            "dispatched": dispatched,
            "recovered": recovered,
            "skipped": skipped,
            "active_global_stores": _global_active_upload_store_count(db),
        }
    finally:
        db.close()
        _release_redis_lock("upload_dispatch", lock_token)


def poll_upload_jobs(limit: int = 200) -> Dict[str, Any]:
    lock_token = _acquire_redis_lock("upload_poll", ttl_seconds=80)
    if lock_token == "":
        return {"ok": True, "message": "Upload poller already running", "processed": 0}

    db = SessionLocal()
    now = datetime.now(timezone.utc)
    try:
        jobs = (
            db.query(models.UploadJob.id)
            .filter(models.UploadJob.status.in_({"submitted", "processing"}))
            .filter(
                or_(
                    models.UploadJob.next_refresh_at.is_(None),
                    models.UploadJob.next_refresh_at <= now,
                    models.UploadJob.cancel_requested.is_(True),
                )
            )
            .order_by(models.UploadJob.id.asc())
            .limit(max(int(limit or 1), 1))
            .all()
        )
        job_ids = [row[0] for row in jobs]
    finally:
        db.close()

    try:
        results = [run_refresh_upload_job(job_id) for job_id in job_ids]
        return {
            "ok": True,
            "message": f"Polled {len(results)} upload job(s)",
            "processed": len(results),
            "results": results,
        }
    finally:
        _release_redis_lock("upload_poll", lock_token)


async def _submit_upload_job(
    *,
    db: Session,
    store: models.Store,
    items: List[Dict[str, Any]],
    source: Optional[str],
    local_task_id: Optional[str],
    requested_store_id: Optional[int] = None,
    requested_store_name: Optional[str] = None,
    extension_meta: Optional[Dict[str, Any]] = None,
) -> models.UploadJob:
    cloud_items = _sanitize_upload_items_for_cloud(items)
    request_payload: Dict[str, Any] = {
        "store_id": store.id,
        "requested_store_id": requested_store_id,
        "requested_store_name": requested_store_name,
        "local_task_id": local_task_id,
        "source": source,
        "items": cloud_items,
    }
    if extension_meta:
        request_payload["extension_meta"] = extension_meta

    job = models.UploadJob(
        tenant_id=store.tenant_id,
        store_id=store.id,
        status="queued",
        item_count=len(cloud_items),
        source=source,
        local_task_id=local_task_id,
        request_payload=json.dumps(request_payload, ensure_ascii=False),
        max_attempts=UPLOAD_MAX_ATTEMPTS,
        timeout_seconds=UPLOAD_TIMEOUT_SECONDS,
        next_attempt_at=datetime.now(timezone.utc),
    )
    db.add(job)
    db.commit()
    db.refresh(job)
    _create_upload_job_items(db, job=job, items=cloud_items)
    db.commit()
    db.refresh(job)
    item_rows = _upload_job_items_for_job(db, job.id)

    try:
        queue_result = _submit_async_task("ozon.dispatch_upload_jobs", queue="upload")
    except HTTPException as exc:
        job.status = "queue_failed"
        job.error = str(exc.detail or "queue_failed")
        for item_row in item_rows:
            item_row.status = "queue_failed"
            item_row.error = job.error
        db.commit()
        raise

    job.result_payload = json.dumps({"dispatcher_queue": queue_result}, ensure_ascii=False)
    db.commit()
    db.refresh(job)
    return job


def _derive_upload_status(result_payload: Optional[Dict[str, Any]]) -> str:
    if not result_payload:
        return "submitted"

    if result_payload.get("ok") is False:
        return "failed"

    items = _extract_upload_result_items(result_payload)
    if not items:
        return "submitted"

    normalized_statuses = set()
    for item in items:
        normalized_statuses.add(_normalize_upload_item_status(item.get("status")))

    if normalized_statuses & PENDING_UPLOAD_ITEM_STATUSES:
        return "processing"
    if normalized_statuses and normalized_statuses <= SUCCESSFUL_UPLOAD_ITEM_STATUSES:
        return "completed"
    if normalized_statuses & FAILED_UPLOAD_ITEM_STATUSES:
        if normalized_statuses & SUCCESSFUL_UPLOAD_ITEM_STATUSES:
            return "completed_with_errors"
        return "failed"
    return "processing"


def _request_items_for_upload_job(db: Session, job: models.UploadJob) -> List[Dict[str, Any]]:
    item_payloads: List[Dict[str, Any]] = []
    for row in _upload_job_items_for_job(db, job.id):
        payload = _load_json(row.request_payload)
        if isinstance(payload, dict):
            item_payloads.append(payload)
    if item_payloads:
        return item_payloads

    request_payload = _load_json(job.request_payload) or {}
    items = request_payload.get("items")
    if isinstance(items, list):
        return [item for item in items if isinstance(item, dict)]
    return []


def run_upload_job(job_id: int) -> Dict[str, Any]:
    db = SessionLocal()
    try:
        job = db.query(models.UploadJob).filter(models.UploadJob.id == int(job_id)).first()
        if not job:
            return {"ok": False, "message": "Upload job not found", "job_id": job_id}
        if job.status in UPLOAD_TERMINAL_STATUSES or job.status in {"uploading", "submitted", "processing"}:
            return {
                "ok": True,
                "message": "Upload job is already running or submitted",
                "job_id": job.id,
                "status": job.status,
            }
        if job.cancel_requested:
            now = datetime.now(timezone.utc)
            job.status = "canceled"
            job.canceled_at = now
            job.finished_at = now
            job.locked_at = None
            _set_upload_job_items_status(db, job, "canceled", "cancel_requested")
            db.commit()
            return {
                "ok": True,
                "message": "Upload job canceled before execution",
                "job_id": job.id,
                "status": job.status,
            }

        store = db.query(models.Store).filter(models.Store.id == job.store_id).first()
        if not store:
            raise ValueError("Store not found for upload job")
        items = _request_items_for_upload_job(db, job)
        if not items:
            raise ValueError("Upload job has no item payloads")

        now = datetime.now(timezone.utc)
        job.status = "uploading"
        job.error = None
        job.locked_at = now
        job.started_at = job.started_at or now
        job.attempt_count = int(job.attempt_count or 0) + 1
        for item_row in _upload_job_items_for_job(db, job.id):
            item_row.status = "uploading"
            item_row.error = None
            item_row.attempt_count = int(item_row.attempt_count or 0) + 1
        db.commit()

        upload_result = asyncio.run(upload_products(store.client_id, store.api_key, items))
        job.result_payload = json.dumps(upload_result, ensure_ascii=False)
        if upload_result.get("ok"):
            result_body = (upload_result.get("data") or {}).get("result") or {}
            task_id = result_body.get("task_id")
            job.ozon_task_id = str(task_id) if task_id is not None else None
            job.status = "submitted"
            job.error = None
            job.locked_at = None
            job.next_attempt_at = None
            job.next_refresh_at = datetime.now(timezone.utc) + timedelta(
                seconds=UPLOAD_INITIAL_RESULT_POLL_DELAY_SECONDS
            )
            item_default_status = "submitted"
            item_default_error = None
        else:
            upload_error = str(upload_result.get("error") or "upload_failed")
            job.result_payload = json.dumps(upload_result, ensure_ascii=False)
            _mark_upload_job_for_retry_or_failed(db, job, upload_error)
            item_default_status = job.status
            item_default_error = upload_error

        _update_upload_job_items_from_result(
            db,
            job=job,
            result_payload=upload_result,
            default_status=item_default_status,
            default_error=item_default_error,
        )
        _upsert_products_for_items(
            db=db,
            store_id=job.store_id,
            upload_job_id=job.id,
            items=items,
            source=job.source,
            job_status=job.status,
        )
        db.commit()
        return {
            "ok": bool(upload_result.get("ok")),
            "message": "Upload submitted to Ozon" if upload_result.get("ok") else job.error,
            "job_id": job.id,
            "status": job.status,
            "ozon_task_id": job.ozon_task_id,
            "item_count": len(items),
        }
    except Exception as exc:
        db.rollback()
        failed_job = db.query(models.UploadJob).filter(models.UploadJob.id == int(job_id)).first()
        if failed_job:
            _mark_upload_job_for_retry_or_failed(db, failed_job, str(exc))
            db.commit()
            return {
                "ok": False,
                "message": str(exc),
                "job_id": failed_job.id,
                "status": failed_job.status,
            }
        return {"ok": False, "message": str(exc), "job_id": job_id}
    finally:
        db.close()


def run_refresh_upload_job(job_id: int) -> Dict[str, Any]:
    db = SessionLocal()
    try:
        job = db.query(models.UploadJob).filter(models.UploadJob.id == int(job_id)).first()
        if not job:
            return {"ok": False, "message": "Upload job not found", "job_id": job_id}
        if job.status in UPLOAD_TERMINAL_STATUSES:
            return {
                "ok": True,
                "message": "Upload job already finished",
                "job_id": job.id,
                "status": job.status,
            }
        if job.cancel_requested:
            now = datetime.now(timezone.utc)
            job.status = "canceled"
            job.canceled_at = now
            job.finished_at = now
            job.next_refresh_at = None
            _set_upload_job_items_status(db, job, "canceled", "cancel_requested")
            db.commit()
            return {
                "ok": True,
                "message": "Upload job canceled",
                "job_id": job.id,
                "status": job.status,
            }
        if not job.ozon_task_id:
            return {
                "ok": False,
                "message": "Upload job has no Ozon task id to refresh",
                "job_id": job.id,
                "status": job.status,
            }

        store = db.query(models.Store).filter(models.Store.id == job.store_id).first()
        if not store:
            raise ValueError("Store not found for upload job")

        result = asyncio.run(get_upload_task_info(store.client_id, store.api_key, int(job.ozon_task_id)))
        now = datetime.now(timezone.utc)
        job.result_payload = json.dumps(result, ensure_ascii=False)
        job.status = _derive_upload_status(result)
        job.error = None if result.get("ok") else result.get("error", "status_refresh_failed")
        job.last_refreshed_at = now
        if job.status in UPLOAD_TERMINAL_STATUSES:
            job.finished_at = now
            job.next_refresh_at = None
        else:
            job.next_refresh_at = now + timedelta(seconds=UPLOAD_RESULT_POLL_INTERVAL_SECONDS)

        _update_upload_job_items_from_result(
            db,
            job=job,
            result_payload=result,
            default_status=job.status,
            default_error=job.error,
        )
        items = _request_items_for_upload_job(db, job)
        if items:
            _upsert_products_for_items(
                db=db,
                store_id=job.store_id,
                upload_job_id=job.id,
                items=items,
                source=job.source,
                job_status=job.status,
            )

        db.commit()
        return {
            "ok": bool(result.get("ok")),
            "message": "Upload status refreshed" if result.get("ok") else job.error,
            "job_id": job.id,
            "status": job.status,
            "ozon_task_id": job.ozon_task_id,
        }
    except Exception:
        db.rollback()
        raise
    finally:
        db.close()


def run_refresh_analytics(
    days: int = 7,
    store_id: Optional[int] = None,
    user_owner: Optional[str] = None,
    tenant_id: Optional[int] = None,
) -> Dict[str, Any]:
    db = SessionLocal()
    try:
        normalized_days = max(1, min(int(days or 7), 365))
        store_ids = (
            [store.id for store in _user_store_query(db, user_owner).all()]
            if user_owner
            else []
        )
        if tenant_id is not None:
            store_ids = [
                row[0]
                for row in db.query(models.Store.id)
                .filter(models.Store.tenant_id == tenant_id)
                .all()
            ]
        if store_id is not None:
            scoped_store_ids = set(store_ids)
            if (
                (tenant_id is not None or user_owner)
                and int(store_id) not in scoped_store_ids
            ):
                raise ValueError("Store not accessible for analytics refresh")
            store_ids = [int(store_id)]

        products_query = db.query(models.Product)
        orders_query = db.query(models.OrderRecord)
        if store_ids:
            products_query = products_query.filter(models.Product.store_id.in_(store_ids))
            orders_query = orders_query.filter(models.OrderRecord.store_id.in_(store_ids))
        elif tenant_id is not None or user_owner:
            return {
                "ok": True,
                "message": "No stores available for analytics refresh",
                "products": 0,
                "orders": 0,
                "category_groups": 0,
                "hot_tags": None,
            }

        products = products_query.all()
        orders = orders_query.all()
        category_result = _build_category_analytics(products, orders, [], normalized_days)
        hot_tags_meta: Optional[Dict[str, Any]] = None
        hot_tags_error: Optional[str] = None
        try:
            hot_tags = _get_hot_tags_dataset(
                SELLER_HOT_TAGS_DEFAULT_TREND_WINDOW_DAYS,
                tenant_id=tenant_id,
            )
            hot_tags_meta = dict(hot_tags.get("meta") or {})
        except Exception as exc:
            hot_tags_error = str(exc)

        return {
            "ok": hot_tags_error is None,
            "message": (
                "Analytics refresh completed"
                if hot_tags_error is None
                else "Analytics refresh completed with hot-tags error"
            ),
            "days": normalized_days,
            "stores": len(store_ids),
            "products": len(products),
            "orders": len(orders),
            "category_groups": len(category_result.get("result") or []),
            "hot_tags": hot_tags_meta,
            "hot_tags_error": hot_tags_error,
        }
    finally:
        db.close()


def _extension_public_status(job: models.UploadJob) -> str:
    if job.status in {"queue_failed", "submit_failed", "failed", "completed_with_errors"}:
        return "failed"
    if job.status in {"created", "queued", "retrying"}:
        return "queued"
    if job.status in {"dispatching", "uploading", "submitted", "processing"}:
        return "uploading"
    if job.status in {"completed"}:
        return "uploaded"
    if job.status in {"canceled"}:
        return "failed"
    return "uploading"


def _extract_extension_ozon_status(result_payload: Optional[Dict[str, Any]]) -> Optional[Dict[str, Any]]:
    if not isinstance(result_payload, dict):
        return None
    data = result_payload.get("data")
    if isinstance(data, dict):
        result = data.get("result")
        if isinstance(result, dict):
            return result
    result = result_payload.get("result")
    return result if isinstance(result, dict) else None


def _build_extension_status_payload(
    job: models.UploadJob,
    *,
    store_name: Optional[str],
) -> Dict[str, Any]:
    request_payload = _load_json(job.request_payload) or {}
    extension_meta = request_payload.get("extension_meta")
    if not isinstance(extension_meta, dict):
        extension_meta = {}

    items = request_payload.get("items")
    first_item: Dict[str, Any] = {}
    if isinstance(items, list) and items and isinstance(items[0], dict):
        first_item = items[0]

    result_payload = _load_json(job.result_payload)
    category_info = extension_meta.get("category_info")
    if not isinstance(category_info, dict):
        category_info = {
            "description_category_id": first_item.get("description_category_id"),
            "type_id": first_item.get("type_id"),
        }

    images = first_item.get("images")
    images_count = 1
    if isinstance(images, list):
        images_count += len(images)

    return {
        "ok": True,
        "product_id": str(job.id),
        "source_product_id": extension_meta.get("source_product_id"),
        "title": extension_meta.get("title") or first_item.get("name"),
        "offer_id": first_item.get("offer_id"),
        "status": _extension_public_status(job),
        "price": first_item.get("price") or extension_meta.get("price"),
        "images_count": images_count,
        "ozon_task_id": job.ozon_task_id,
        "cloud_upload_job_id": job.id,
        "cloud_upload_status": job.status,
        "cloud_store_id": job.store_id,
        "errors": {"error": job.error} if job.error else None,
        "attributes_count": len(first_item.get("attributes") or []),
        "category_info": category_info,
        "created_at": _format_datetime(job.created_at),
        "updated_at": _format_datetime(job.updated_at),
        "job_id": str(job.id),
        "job_status": job.status,
        "job_error": job.error,
        "job_result": result_payload,
        "ozon_status": _extract_extension_ozon_status(result_payload),
    }


async def _prepare_cloud_follow_product_data(
    *,
    reference: Any,
    front_cookie: Optional[str],
    user_agent: Optional[str],
    use_browser_session: bool,
    preferred_url_fragment: Optional[str],
) -> Dict[str, Any]:
    resolved_product_id, source_url = _resolve_ozon_product_reference(reference)
    fetch_bundle = await _fetch_ozon_entrypoint_payloads(
        resolved_product_id,
        front_cookie=front_cookie,
        user_agent=user_agent,
        use_browser_session=use_browser_session,
        preferred_url_fragment=preferred_url_fragment,
    )
    payloads = fetch_bundle.get("payloads")
    if not isinstance(payloads, list) or not payloads:
        raise HTTPException(status_code=502, detail="No frontend payloads were returned")

    product_data = build_ozon_frontend_product_data(
        product_id=resolved_product_id,
        payloads=payloads,
        source_url=source_url,
    )
    if not isinstance(product_data, dict):
        raise HTTPException(status_code=502, detail="Failed to build product data from frontend payloads")

    resolved_source_url = str(product_data.get("sourceUrl") or source_url)
    return {
        "reference": str(reference or ""),
        "resolved_product_id": int(resolved_product_id),
        "source_url": resolved_source_url,
        "fetch_source": str(fetch_bundle.get("source") or "unknown"),
        "page_url": str(fetch_bundle.get("page_url") or ""),
        "product_data": product_data,
    }


def _collect_cloud_follow_variant_ids(product_data: Dict[str, Any], max_variants: int) -> List[int]:
    variant_ids: List[int] = []
    seen = set()

    for variant in product_data.get("variants") or []:
        candidate_id = extract_ozon_frontend_product_id(
            variant.get("productId") or variant.get("productUrl") or ""
        )
        if not candidate_id:
            continue
        candidate_id = int(candidate_id)
        if candidate_id in seen:
            continue
        seen.add(candidate_id)
        variant_ids.append(candidate_id)
        if len(variant_ids) >= max_variants:
            break

    return variant_ids


async def _run_cloud_follow_submit_workflow(
    *,
    db: Session,
    store: models.Store,
    reference: Any,
    include_variants: bool = False,
    max_variants: int = 20,
    price: Any = None,
    old_price: Any = None,
    follow_min_price: Any = None,
    model: Optional[str] = None,
    use_browser_session: bool = True,
    preferred_url_fragment: Optional[str] = None,
    front_cookie: Optional[str] = None,
    user_agent: Optional[str] = None,
) -> Dict[str, Any]:
    normalized_max_variants = max(1, min(100, int(max_variants or 20)))
    prepared = await _prepare_cloud_follow_product_data(
        reference=reference,
        front_cookie=front_cookie,
        user_agent=user_agent,
        use_browser_session=bool(use_browser_session),
        preferred_url_fragment=preferred_url_fragment,
    )
    base_product_data = prepared["product_data"]
    resolved_product_id = int(prepared["resolved_product_id"])
    shared_model = str(model or "").strip()
    if not shared_model:
        model_seed = str(base_product_data.get("productId") or resolved_product_id)
        shared_model = f"M{model_seed}-{secrets.token_hex(3).upper()}"
    variant_mode = "single"
    skipped_variants = 0
    source_payloads: List[Dict[str, Any]] = [base_product_data]

    if include_variants:
        variant_ids = _collect_cloud_follow_variant_ids(base_product_data, normalized_max_variants)
        if variant_ids:
            variant_mode = "variants"
            source_payloads = []
            fetch_concurrency = CLOUD_FOLLOW_FRONTEND_FETCH_CONCURRENCY if front_cookie else 1
            fetch_concurrency = max(1, min(fetch_concurrency, len(variant_ids), 8))
            fetch_semaphore = asyncio.Semaphore(fetch_concurrency)

            async def fetch_variant_payload(variant_id: int) -> tuple[int, Optional[Dict[str, Any]], Optional[str]]:
                if int(variant_id) == resolved_product_id:
                    return int(variant_id), base_product_data, None
                async with fetch_semaphore:
                    try:
                        variant_bundle = await _fetch_ozon_entrypoint_payloads(
                            int(variant_id),
                            front_cookie=front_cookie,
                            user_agent=user_agent,
                            use_browser_session=bool(use_browser_session),
                            preferred_url_fragment=preferred_url_fragment,
                        )
                        variant_payloads = variant_bundle.get("payloads")
                        if not isinstance(variant_payloads, list) or not variant_payloads:
                            return int(variant_id), None, "empty frontend payloads"
                        variant_product_data = build_ozon_frontend_product_data(
                            product_id=int(variant_id),
                            payloads=variant_payloads,
                            source_url=f"{OZON_BUYER_ORIGIN}/product/{int(variant_id)}/",
                        )
                        if isinstance(variant_product_data, dict):
                            return int(variant_id), variant_product_data, None
                        return int(variant_id), None, "failed to build frontend product data"
                    except Exception as exc:
                        return int(variant_id), None, str(exc)

            variant_results = await asyncio.gather(
                *(fetch_variant_payload(int(variant_id)) for variant_id in variant_ids)
            )
            for _variant_id, variant_product_data, error in variant_results:
                if isinstance(variant_product_data, dict):
                    source_payloads.append(variant_product_data)
                elif error:
                    skipped_variants += 1

            if not source_payloads:
                source_payloads = [base_product_data]
                variant_mode = "single"

    items, build_errors = await _build_upload_items_for_payloads(
        store=store,
        source_payloads=source_payloads,
        price=price,
        old_price=old_price,
        min_price=follow_min_price,
        model=shared_model,
    )

    if not items:
        raise HTTPException(
            status_code=400,
            detail=build_errors[0] if build_errors else "No uploadable items were built from reference",
        )

    _validate_upload_items(items)
    local_task_id = f"cloud-follow-{secrets.token_hex(8)}"
    extension_meta = {
        "reference": str(reference or ""),
        "source_product_id": str(resolved_product_id),
        "source_url": prepared["source_url"],
        "title": str(base_product_data.get("title") or ""),
        "variant_mode": variant_mode,
    }
    job = await _submit_upload_job(
        db=db,
        store=store,
        items=items,
        source="cloud_follow_reference",
        local_task_id=local_task_id,
        requested_store_id=store.id,
        extension_meta=extension_meta,
    )
    if job.status in {"submit_failed", "failed"}:
        raise HTTPException(status_code=502, detail=job.error or "cloud follow upload failed")

    return {
        "ok": True,
        "job_id": str(job.id),
        "status": job.status,
        "store_id": store.id,
        "item_count": len(items),
        "variant_mode": variant_mode,
        "resolved_product_id": resolved_product_id,
        "source_url": prepared["source_url"],
        "fetch_source": prepared.get("fetch_source"),
        "skipped_variants": skipped_variants,
    }


def _find_recent_extension_upload_job(
    db: Session,
    *,
    store_id: int,
    offer_id: str,
    source_product_id: str,
    window_seconds: int = 60,
) -> Optional[models.UploadJob]:
    if not offer_id:
        return None

    now_value = datetime.now(timezone.utc)
    candidates = (
        db.query(models.UploadJob)
        .filter(
            models.UploadJob.store_id == store_id,
            models.UploadJob.source == "extension_one_click",
        )
        .order_by(models.UploadJob.id.desc())
        .limit(20)
        .all()
    )

    for job in candidates:
        created_at = job.created_at
        if created_at is not None:
            if created_at.tzinfo is None:
                created_at = created_at.replace(tzinfo=timezone.utc)
            if (now_value - created_at).total_seconds() > window_seconds:
                continue

        request_payload = _load_json(job.request_payload) or {}
        items = request_payload.get("items")
        if not isinstance(items, list) or not items or not isinstance(items[0], dict):
            continue

        first_item = items[0]
        if str(first_item.get("offer_id") or "") != offer_id:
            continue

        extension_meta = request_payload.get("extension_meta")
        existing_source_product_id = ""
        if isinstance(extension_meta, dict):
            existing_source_product_id = str(extension_meta.get("source_product_id") or "")
        if source_product_id and existing_source_product_id and existing_source_product_id != source_product_id:
            continue

        return job

    return None


def _extension_upload_list_key(job: models.UploadJob) -> Optional[tuple[int, str, str]]:
    if job.source != "extension_one_click":
        return None

    request_payload = _load_json(job.request_payload) or {}
    items = request_payload.get("items")
    if not isinstance(items, list) or not items or not isinstance(items[0], dict):
        return None

    offer_id = str(items[0].get("offer_id") or "").strip()
    extension_meta = request_payload.get("extension_meta")
    source_product_id = ""
    if isinstance(extension_meta, dict):
        source_product_id = str(extension_meta.get("source_product_id") or "").strip()

    if not offer_id:
        return None

    return (int(job.store_id), offer_id, source_product_id or offer_id)


def _dedupe_upload_jobs_for_list(
    jobs: List[models.UploadJob],
    limit: int,
    *,
    window_seconds: int = 600,
) -> List[models.UploadJob]:
    result: List[models.UploadJob] = []
    seen: Dict[tuple[int, str, str], Optional[datetime]] = {}

    for job in jobs:
        key = _extension_upload_list_key(job)
        if key is not None and key in seen:
            previous_created_at = seen.get(key)
            created_at = job.created_at
            if created_at is not None and created_at.tzinfo is None:
                created_at = created_at.replace(tzinfo=timezone.utc)
            if previous_created_at is None or created_at is None:
                continue
            if abs((previous_created_at - created_at).total_seconds()) <= window_seconds:
                continue

        result.append(job)
        if key is not None:
            created_at = job.created_at
            if created_at is not None and created_at.tzinfo is None:
                created_at = created_at.replace(tzinfo=timezone.utc)
            seen[key] = created_at

        if len(result) >= limit:
            break

    return result


def _status_from_upload_job(job_status: str) -> str:
    if job_status in {"queue_failed", "submit_failed", "failed"}:
        return "rejected"
    if job_status in {"queued", "uploading", "processing", "submitted", "created"}:
        return "approved"
    if job_status in {"completed", "completed_with_errors"}:
        return "approved"
    return "approved"


def _pick_category_path(item: Dict[str, Any], offer_id: str) -> tuple[str, str, str]:
    provided = item.get("category_path")
    if isinstance(provided, Sequence) and not isinstance(provided, str) and len(provided) >= 3:
        return str(provided[0]), str(provided[1]), str(provided[2])

    index = sum(ord(char) for char in offer_id) % len(CATEGORY_CATALOG)
    return CATEGORY_CATALOG[index]


def _extract_dimension(item: Dict[str, Any], primary_key: str, fallback_key: str, default: float) -> float:
    return _safe_float(item.get(primary_key) or item.get(fallback_key), default)


def _upsert_products_for_items(
    db: Session,
    store_id: int,
    upload_job_id: Optional[int],
    items: Iterable[Dict[str, Any]],
    source: Optional[str],
    job_status: str,
) -> int:
    count = 0
    tenant_id = _store_tenant_id(db, store_id)
    for index, item in enumerate(items, start=1):
        offer_id = str(item.get("offer_id") or item.get("sku") or f"offer-{store_id}-{index}")
        product = (
            db.query(models.Product)
            .filter(models.Product.store_id == store_id, models.Product.offer_id == offer_id)
            .first()
        )
        if product is None:
            product = models.Product(store_id=store_id, tenant_id=tenant_id, offer_id=offer_id)
            db.add(product)
        elif not product.tenant_id:
            product.tenant_id = tenant_id

        cat1, cat2, cat3 = _pick_category_path(item, offer_id)
        price = _safe_float(item.get("price") or item.get("offer_price"), 0.0)
        if price <= 0:
            price = _safe_float(item.get("old_price"), 99.0)
        display_price = _safe_float(item.get("old_price"), round(price * 1.15, 2))
        stock = _safe_int(item.get("stock"), max(product.stock if product.id else 0, 30))
        weight = _safe_float(item.get("weight") or item.get("weight_g"), 300.0)
        length = _extract_dimension(item, "length", "length_mm", 20.0)
        width = _extract_dimension(item, "width", "width_mm", 20.0)
        height = _extract_dimension(item, "height", "height_mm", 20.0)
        product.upload_job_id = upload_job_id
        product.sku = str(item.get("sku") or offer_id)
        product.article_no = str(item.get("barcode") or item.get("article_no") or offer_id[-8:])
        product.product_name = str(item.get("name") or item.get("title") or f"商品 {offer_id}")
        product.primary_image = str(item.get("primary_image") or item.get("image") or "")
        product.info = str(item.get("description") or item.get("source_url") or "")
        product.source = source or str(item.get("source") or "local")
        product.category_level_1 = cat1
        product.category_level_2 = cat2
        product.category_level_3 = cat3
        product.status = _status_from_upload_job(job_status)
        product.price = price
        product.display_price = display_price
        product.profit = round(max(price * 0.18, 0.0), 2)
        product.stock = stock
        if not product.backup_stock:
            product.backup_stock = stock
        product.weight_g = weight
        product.length_mm = length
        product.width_mm = width
        product.height_mm = height
        product.country = str(item.get("country") or product.country or "CN")
        count += 1

    db.flush()
    return count


def _sync_products_from_upload_jobs(
    db: Session, store_ids: Optional[Sequence[int]] = None
) -> int:
    synced = 0
    jobs_query = db.query(models.UploadJob).order_by(models.UploadJob.id.asc())
    if store_ids is not None:
        scoped_store_ids = [store_id for store_id in store_ids if store_id is not None]
        if not scoped_store_ids:
            return 0
        jobs_query = jobs_query.filter(models.UploadJob.store_id.in_(scoped_store_ids))

    jobs = jobs_query.all()
    for job in jobs:
        payload = _load_json(job.request_payload) or {}
        items = payload.get("items")
        if not isinstance(items, list):
            continue
        synced += _upsert_products_for_items(
            db=db,
            store_id=job.store_id,
            upload_job_id=job.id,
            items=items,
            source=job.source,
            job_status=job.status,
        )
    return synced


def _extract_primary_image(value: Any, *, _depth: int = 0) -> str:
    if value is None or _depth > 5:
        return ""

    if isinstance(value, str):
        text = value.strip()
        if not text or text in {"[]", "{}", "null", "None"}:
            return ""
        if text.startswith("//"):
            return f"https:{text}"
        if text[:1] in "[{":
            for parser in (json.loads, ast.literal_eval):
                try:
                    parsed = parser(text)
                except Exception:
                    continue
                image = _extract_primary_image(parsed, _depth=_depth + 1)
                if image:
                    return image
        return text

    if isinstance(value, (list, tuple, set)):
        for item in value:
            image = _extract_primary_image(item, _depth=_depth + 1)
            if image:
                return image
        return ""

    if isinstance(value, dict):
        for key in (
            "url",
            "file_name",
            "image",
            "src",
            "link",
            "path",
            "primary_image",
            "preview",
        ):
            image = _extract_primary_image(value.get(key), _depth=_depth + 1)
            if image:
                return image
        for item in value.values():
            image = _extract_primary_image(item, _depth=_depth + 1)
            if image:
                return image
        return ""

    return ""


def _stock_from_ozon_product(item: Dict[str, Any]) -> int:
    stock_groups = item.get("stocks", {}).get("stocks", [])
    if isinstance(stock_groups, list) and stock_groups:
        return sum(_safe_int(stock.get("present"), 0) for stock in stock_groups)
    return 0


def _source_from_ozon_product(item: Dict[str, Any]) -> str:
    sources = item.get("sources") or item.get("availabilities") or []
    if isinstance(sources, list):
        for source in sources:
            value = source.get("source")
            if value:
                return str(value)
    return "ozon"


def _profit_from_ozon_product(item: Dict[str, Any], price: float) -> float:
    commissions = item.get("commissions") or []
    if isinstance(commissions, list):
        for commission in commissions:
            if commission.get("sale_schema") == "FBS":
                return round(max(price - _safe_float(commission.get("value"), 0.0), 0.0), 2)
    return round(max(price * 0.18, 0.0), 2)


def _upsert_products_for_ozon_items(
    db: Session,
    store_id: int,
    items: Iterable[Dict[str, Any]],
) -> int:
    count = 0
    tenant_id = _store_tenant_id(db, store_id)
    for item in items:
        offer_id = str(item.get("offer_id") or item.get("id") or "").strip()
        if not offer_id:
            continue

        product = (
            db.query(models.Product)
            .filter(models.Product.store_id == store_id, models.Product.offer_id == offer_id)
            .first()
        )
        if product is None:
            product = models.Product(store_id=store_id, tenant_id=tenant_id, offer_id=offer_id)
            db.add(product)
        elif not product.tenant_id:
            product.tenant_id = tenant_id

        cat1, cat2, cat3 = _pick_category_path(item, offer_id)
        price = _safe_float(item.get("price"), 0.0)
        display_price = _safe_float(item.get("old_price"), price)
        stock = _stock_from_ozon_product(item)
        product.sku = str(item.get("sku") or product.sku or offer_id)
        barcodes = item.get("barcodes") or []
        article_no = barcodes[0] if isinstance(barcodes, list) and barcodes else item.get("article_no")
        product.article_no = str(article_no or product.article_no or offer_id[-8:])
        product.product_name = str(item.get("name") or product.product_name or f"商品 {offer_id}")
        product.primary_image = (
            _extract_primary_image(item.get("primary_image"))
            or _extract_primary_image(item.get("images"))
            or product.primary_image
            or ""
        )
        product.info = str(item.get("description") or product.info or "")
        product.source = _source_from_ozon_product(item)
        product.category_level_1 = cat1
        product.category_level_2 = cat2
        product.category_level_3 = cat3
        product.status = (
            "archived"
            if item.get("is_archived")
            else str(item.get("statuses", {}).get("moderate_status") or item.get("statuses", {}).get("status") or "approved")
        )
        product.archived = bool(item.get("is_archived"))
        product.price = price
        product.display_price = display_price
        product.profit = _profit_from_ozon_product(item, price)
        product.stock = stock
        if not product.backup_stock:
            product.backup_stock = stock
        product.weight_g = _safe_float(item.get("volume_weight"), product.weight_g or 0.0)
        product.length_mm = product.length_mm or 0.0
        product.width_mm = product.width_mm or 0.0
        product.height_mm = product.height_mm or 0.0
        product.country = str(product.country or "CN")
        count += 1

    db.flush()
    return count


async def _sync_store_products_from_ozon(db: Session, store: models.Store) -> int:
    synced = 0
    last_id = ""
    seen_last_ids: set[str] = set()

    while True:
        listing = await list_products_page(
            store.client_id,
            store.api_key,
            last_id=last_id,
            limit=100,
        )
        if not listing.get("ok"):
            raise HTTPException(
                status_code=502,
                detail=f"Failed to fetch Ozon product list for {store.store_name}: {listing.get('error', 'unknown_error')}",
            )

        result = listing.get("data", {}).get("result", {})
        items = result.get("items", [])
        if not items:
            break

        product_ids = [int(item["product_id"]) for item in items if item.get("product_id") is not None]
        if not product_ids:
            break

        detail_result = await get_products_info_list(
            store.client_id,
            store.api_key,
            product_ids=product_ids,
        )
        if not detail_result.get("ok"):
            raise HTTPException(
                status_code=502,
                detail=f"Failed to fetch Ozon product details for {store.store_name}: {detail_result.get('error', 'unknown_error')}",
            )

        synced += _upsert_products_for_ozon_items(
            db=db,
            store_id=store.id,
            items=detail_result.get("data", {}).get("items", []),
        )

        next_last_id = str(result.get("last_id") or "")
        if not next_last_id or next_last_id == last_id or next_last_id in seen_last_ids:
            break
        seen_last_ids.add(next_last_id)
        last_id = next_last_id

    return synced


def _product_lookup_keys(raw_offer_id: Optional[str], raw_sku: Optional[str]) -> List[str]:
    keys: List[str] = []
    for value in (raw_offer_id, raw_sku):
        if value is None:
            continue
        text = str(value).strip()
        if text:
            keys.append(text)
    return keys


def _find_product_for_posting(
    db: Session, store_id: int, raw_offer_id: Optional[str], raw_sku: Optional[str]
) -> Optional[models.Product]:
    keys = _product_lookup_keys(raw_offer_id, raw_sku)
    if not keys:
        return None

    product = (
        db.query(models.Product)
        .filter(models.Product.store_id == store_id, models.Product.offer_id.in_(keys))
        .first()
    )
    if product:
        return product

    return (
        db.query(models.Product)
        .filter(models.Product.store_id == store_id, models.Product.sku.in_(keys))
        .first()
    )


def _sync_order_from_posting(
    db: Session,
    store_id: int,
    posting: Dict[str, Any],
) -> bool:
    posting_number = str(posting.get("posting_number") or "").strip()
    if not posting_number:
        return False

    products = posting.get("products") or []
    first_product = products[0] if products else {}
    raw_offer_id = first_product.get("offer_id") or first_product.get("offerId")
    raw_sku = first_product.get("sku")
    linked_product = _find_product_for_posting(db, store_id, raw_offer_id, raw_sku)

    quantity = sum(_safe_int(product.get("quantity"), 1) for product in products) or 1
    product_names = [
        str(product.get("name") or "").strip() for product in products if product.get("name")
    ]
    product_name = (
        product_names[0]
        if product_names
        else (linked_product.product_name if linked_product else posting_number)
    )
    if len(product_names) > 1:
        product_name = f"{product_name} 等{len(product_names)}件"

    amount = 0.0
    for product in products:
        price = _safe_float(product.get("price"), 0.0)
        qty = _safe_int(product.get("quantity"), 1)
        amount += price * max(qty, 1)

    if amount <= 0:
        financial_products = (
            posting.get("financial_data", {}).get("products", [])
            if isinstance(posting.get("financial_data"), dict)
            else []
        )
        for product in financial_products:
            price = _safe_float(product.get("price"), 0.0)
            qty = _safe_int(product.get("quantity"), 1)
            amount += price * max(qty, 1)

    status = str(posting.get("status") or "").strip() or "unknown"
    created_at = _parse_datetime(
        posting.get("in_process_at")
        or posting.get("created_at")
        or posting.get("shipment_date")
    )
    deadline_at = _parse_datetime(
        posting.get("shipment_date") or posting.get("delivering_date")
    )
    delivery_method = posting.get("delivery_method") or {}
    analytics_data = posting.get("analytics_data") or {}
    customer = posting.get("customer") or {}

    order = (
        db.query(models.OrderRecord)
        .filter(models.OrderRecord.posting_number == posting_number)
        .first()
    )
    if order is None:
        order = models.OrderRecord(
            tenant_id=_store_tenant_id(db, store_id),
            store_id=store_id,
            posting_number=posting_number,
            printed=False,
            downloaded=False,
            closed=False,
            inbound_status="pending",
        )
        db.add(order)

    order.store_id = store_id
    if not order.tenant_id:
        order.tenant_id = _store_tenant_id(db, store_id)
    order.scheme = "FBS"
    order.status = status
    order.status_label = _format_order_status(status)
    order.deadline_at = deadline_at
    order.amount = round(amount, 2)
    order.currency = str(
        first_product.get("currency_code") or posting.get("currency_code") or "RUB"
    )
    order.all_waybills = str(
        posting.get("tpl_integration_type") or posting.get("order_number") or posting_number
    )
    order.domestic_waybill = str(posting.get("order_number") or posting_number)
    order.tracking_no = str(
        posting.get("tracking_number") or posting.get("tpl_tracking_number") or ""
    )
    order.sender_name = str(customer.get("name") or "Ozon API")
    order.product_name = product_name
    order.product_image = (
        linked_product.primary_image if linked_product and linked_product.primary_image else None
    )
    order.total_pieces = quantity
    order.warehouse_status = str(
        delivery_method.get("name") or analytics_data.get("warehouse_name") or _format_order_status(status)
    )
    order.responsible_person = "Ozon API"
    order.length_mm = linked_product.length_mm if linked_product else 0.0
    order.width_mm = linked_product.width_mm if linked_product else 0.0
    order.height_mm = linked_product.height_mm if linked_product else 0.0
    order.weight_g = linked_product.weight_g if linked_product else 0.0
    order.estimated_price = round(amount, 2)
    order.total_purchase_price = round(
        linked_product.price * 0.55 if linked_product and linked_product.price else amount * 0.55,
        2,
    )
    order.labeling_fee = 2.0
    order.warehouse_name = str(
        delivery_method.get("warehouse") or analytics_data.get("warehouse_name") or ""
    )
    order.logistics_type = "FBS"
    if status in {"delivered"}:
        order.inbound_status = "inbound"
    elif status in {"delivering"}:
        order.inbound_status = "outbound"
    else:
        order.inbound_status = "pending"
    if created_at is not None:
        order.created_at = created_at
    return True


async def _sync_store_orders(
    db: Session,
    store: models.Store,
    days: int,
) -> Dict[str, Any]:
    now = datetime.now(timezone.utc)
    since = now - timedelta(days=max(1, min(days, 365)))
    response = await fetch_fbs_postings(
        store.client_id,
        store.api_key,
        since=since,
        to=now,
        limit=100,
    )
    if not response.get("ok"):
        return {
            "ok": False,
            "store_id": store.id,
            "store_name": store.store_name,
            "error": response.get("error") or "fetch_orders_failed",
            "synced": 0,
        }

    postings = response.get("data", {}).get("result", {}).get("postings", [])
    _demo_order_query(db, store.id).delete(synchronize_session=False)
    synced = 0
    for posting in postings:
        synced += 1 if _sync_order_from_posting(db, store.id, posting) else 0

    return {
        "ok": True,
        "store_id": store.id,
        "store_name": store.store_name,
        "synced": synced,
    }


def _seed_demo_orders(db: Session) -> None:
    if db.query(models.OrderRecord).count() > 0:
        return

    stores = db.query(models.Store).order_by(models.Store.id.asc()).all()
    if not stores:
        return

    products = db.query(models.Product).order_by(models.Product.id.asc()).all()
    default_products = [
        {
            "name": "示例无线耳机",
            "image": "https://via.placeholder.com/40",
            "weight_g": 220,
            "price": 149.0,
            "cost": 78.0,
            "dims": (18, 12, 8),
        },
        {
            "name": "示例收纳盒",
            "image": "https://via.placeholder.com/40",
            "weight_g": 480,
            "price": 69.0,
            "cost": 28.0,
            "dims": (30, 20, 10),
        },
        {
            "name": "示例夹克",
            "image": "https://via.placeholder.com/40",
            "weight_g": 860,
            "price": 289.0,
            "cost": 152.0,
            "dims": (35, 25, 8),
        },
    ]

    now = datetime.now(timezone.utc)
    statuses = [
        ("FBS", "awaiting_packaging", "待备货", "待入库 / Ozon Logistics"),
        ("FBS", "awaiting_deliver", "待发货", "待出库 / Ozon Logistics"),
        ("FBS", "delivering", "配送中", "已出库 / Ozon Logistics"),
        ("FBS", "delivered", "已送达", "已入库 / Ozon Logistics"),
    ]

    for store_index, store in enumerate(stores, start=1):
        for offset, status_data in enumerate(statuses, start=1):
            scheme, status_code, status_label, warehouse_status = status_data
            product = products[(offset - 1) % len(products)] if products else None
            fallback = default_products[(offset - 1) % len(default_products)]
            dims = (
                product.length_mm,
                product.width_mm,
                product.height_mm,
            ) if product else fallback["dims"]
            weight = product.weight_g if product else fallback["weight_g"]
            price = product.price if product else fallback["price"]
            cost = max((product.price * 0.55) if product else fallback["cost"], 1.0)

            order = models.OrderRecord(
                tenant_id=store.tenant_id,
                store_id=store.id,
                posting_number=f"{store.id:04d}{offset:04d}-{store_index}",
                scheme=scheme,
                status=status_code,
                status_label=status_label,
                deadline_at=now + timedelta(hours=6 * offset) if status_code in PENDING_ORDER_STATUSES else None,
                amount=round(price * (1 + offset * 0.2), 2),
                currency="RUB",
                all_waybills=f"WB-{store.id:03d}-{offset:03d}",
                domestic_waybill=f"CN-{store.id:03d}-{offset:03d}",
                tracking_no=f"TRK-{store.id:03d}-{offset:03d}",
                sender_name="系统初始化",
                product_name=product.product_name if product else fallback["name"],
                product_image=product.primary_image if product and product.primary_image else fallback["image"],
                total_pieces=offset,
                warehouse_status=warehouse_status,
                responsible_person="仓配专员",
                length_mm=float(dims[0] or 20),
                width_mm=float(dims[1] or 20),
                height_mm=float(dims[2] or 20),
                weight_g=float(weight or 300),
                estimated_price=round(price, 2),
                total_purchase_price=round(cost, 2),
                labeling_fee=2.0,
                warehouse_name="莫斯科 1 号仓",
                logistics_type=scheme,
                inbound_status="pending" if status_code in PENDING_ORDER_STATUSES else "inbound",
                printed=False,
                downloaded=False,
                closed=False,
                created_at=now - timedelta(days=offset),
            )
            db.add(order)


def _seed_demo_products(db: Session) -> None:
    if db.query(models.Product).count() > 0:
        return

    stores = db.query(models.Store).order_by(models.Store.id.asc()).all()
    if not stores:
        return

    sample_products = [
        {
            "offer_id": "DEMO-JACKET-001",
            "sku": "SKU-JACKET-001",
            "article_no": "ART-1001",
            "product_name": "示例夹克",
            "primary_image": "https://via.placeholder.com/80",
            "source": "demo",
            "category": ("服饰", "女装", "夹克"),
            "price": 289.0,
            "display_price": 329.0,
            "profit": 58.0,
            "stock": 36,
            "backup_stock": 36,
            "weight_g": 860.0,
            "dimensions": (35.0, 25.0, 8.0),
        },
        {
            "offer_id": "DEMO-EARBUD-002",
            "sku": "SKU-EARBUD-002",
            "article_no": "ART-1002",
            "product_name": "示例无线耳机",
            "primary_image": "https://via.placeholder.com/80",
            "source": "demo",
            "category": ("数码", "耳机", "无线耳机"),
            "price": 149.0,
            "display_price": 179.0,
            "profit": 28.0,
            "stock": 52,
            "backup_stock": 52,
            "weight_g": 220.0,
            "dimensions": (18.0, 12.0, 8.0),
        },
        {
            "offer_id": "DEMO-BOX-003",
            "sku": "SKU-BOX-003",
            "article_no": "ART-1003",
            "product_name": "示例收纳盒",
            "primary_image": "https://via.placeholder.com/80",
            "source": "demo",
            "category": ("家居", "厨房", "收纳盒"),
            "price": 69.0,
            "display_price": 89.0,
            "profit": 16.0,
            "stock": 88,
            "backup_stock": 88,
            "weight_g": 480.0,
            "dimensions": (30.0, 20.0, 10.0),
        },
    ]

    for store in stores:
        for item in sample_products:
            product = models.Product(
                tenant_id=store.tenant_id,
                store_id=store.id,
                offer_id=f"{item['offer_id']}-{store.id}",
                sku=f"{item['sku']}-{store.id}",
                article_no=item["article_no"],
                product_name=item["product_name"],
                primary_image=item["primary_image"],
                info="初始化演示商品",
                source=item["source"],
                category_level_1=item["category"][0],
                category_level_2=item["category"][1],
                category_level_3=item["category"][2],
                status="approved",
                archived=False,
                auto_restock=False,
                scheduled_shelf="",
                price=item["price"],
                display_price=item["display_price"],
                profit=item["profit"],
                stock=item["stock"],
                backup_stock=item["backup_stock"],
                weight_g=item["weight_g"],
                length_mm=item["dimensions"][0],
                width_mm=item["dimensions"][1],
                height_mm=item["dimensions"][2],
                remark="初始化样本",
                country="CN",
            )
            db.add(product)


def _seed_pricing_templates(db: Session) -> None:
    if db.query(models.PricingTemplate).count() > 0:
        return

    db.add(
        models.PricingTemplate(
            tenant_id=_get_or_create_default_tenant(db).id,
            name="默认模板",
            purchase_cost=35.0,
            weight_g=300.0,
            target_margin_rate=18.0,
            length_mm=20.0,
            width_mm=20.0,
            height_mm=20.0,
            domestic_shipping=1.0,
            strike_discount_rate=10.0,
            ad_rate=3.0,
            return_rate=2.0,
            other_fee_rate=3.0,
            has_battery=False,
            has_liquid=False,
            logistics_type="FBS",
            pickup_type="Pickup",
            destination_region="Russia",
        )
    )


def _bootstrap_local_data() -> None:
    db = SessionLocal()
    try:
        _sync_products_from_upload_jobs(db)
        _demo_order_query(db).delete(synchronize_session=False)
        _seed_demo_products(db)
        _seed_pricing_templates(db)
        db.commit()
    finally:
        db.close()


@app.on_event("startup")
def initialize_application() -> None:
    _initialize_runtime_database()
    if settings.ENABLE_LOCAL_BOOTSTRAP and _can_run_local_bootstrap():
        _bootstrap_local_data()


PRODUCT_OPERATION_BATCH_SIZE = 100
UPLOAD_JOB_RESUMABLE_STATUSES = {
    "failed",
    "submit_failed",
    "queue_failed",
    "retrying",
    "canceled",
    "completed_with_errors",
}


def _chunked(values: Sequence[Any], size: int = PRODUCT_OPERATION_BATCH_SIZE) -> Iterable[List[Any]]:
    for index in range(0, len(values), size):
        yield list(values[index : index + size])


def _ensure_selected_products(products: Sequence[models.Product]) -> None:
    if not products:
        raise HTTPException(status_code=404, detail="没有找到可操作的商品")


def _products_grouped_by_store(
    db: Session, products: Sequence[models.Product], username: Optional[str]
) -> Dict[int, tuple[models.Store, List[models.Product]]]:
    grouped: Dict[int, tuple[models.Store, List[models.Product]]] = {}
    for product in products:
        store_id = int(product.store_id)
        if store_id not in grouped:
            store = _resolve_store(db, store_id, username=username)
            if not store.client_id or not store.api_key:
                raise HTTPException(
                    status_code=400,
                    detail=f"店铺「{store.store_name}」缺少 Ozon API 凭证",
                )
            grouped[store_id] = (store, [])
        grouped[store_id][1].append(product)
    return grouped


def _format_ozon_money(value: float) -> str:
    return f"{float(value):.2f}"


def _format_ozon_error_value(value: Any) -> str:
    if isinstance(value, dict):
        message = value.get("message") or value.get("detail") or value.get("error")
        code = value.get("code") or value.get("field")
        if message and code:
            return f"{code}: {message}"
        if message:
            return str(message)
        return json.dumps(value, ensure_ascii=False)
    return str(value)


def _ozon_response_error_text(response: Dict[str, Any]) -> str:
    data = response.get("data")
    if isinstance(data, dict):
        for key in ("message", "detail", "error"):
            value = data.get(key)
            if value:
                return _format_ozon_error_value(value)
    return str(response.get("error") or "unknown_error")


def _label_ozon_result_item(item: Dict[str, Any]) -> str:
    for key in ("offer_id", "offerId", "product_id", "productId", "sku"):
        value = item.get(key)
        if value not in (None, ""):
            return str(value)
    return "unknown"


def _append_ozon_failure(failures: List[str], label: str, detail: Any) -> None:
    if isinstance(detail, list):
        if not detail:
            return
        message = "; ".join(_format_ozon_error_value(item) for item in detail[:3])
    else:
        message = _format_ozon_error_value(detail)
    failures.append(f"{label}: {message}")


def _collect_ozon_failures(data: Any) -> List[str]:
    failures: List[str] = []
    if not isinstance(data, dict):
        return failures

    root_errors = data.get("errors") or data.get("error")
    if root_errors:
        _append_ozon_failure(failures, "Ozon", root_errors)

    root_result = data.get("result")
    if root_result is False:
        failures.append("Ozon: result=false")

    candidates: List[Dict[str, Any]] = []
    for container in (data, root_result if isinstance(root_result, dict) else None):
        if not isinstance(container, dict):
            continue
        for key in ("items", "stocks", "prices", "result"):
            value = container.get(key)
            if isinstance(value, list):
                candidates.extend(item for item in value if isinstance(item, dict))
    if isinstance(root_result, list):
        candidates.extend(item for item in root_result if isinstance(item, dict))

    for item in candidates:
        label = _label_ozon_result_item(item)
        item_errors = item.get("errors") or item.get("error")
        if item_errors:
            _append_ozon_failure(failures, label, item_errors)
            continue
        if item.get("updated") is False or item.get("success") is False or item.get("result") is False:
            _append_ozon_failure(
                failures,
                label,
                item.get("message") or item.get("reason") or "operation rejected",
            )

    return failures


def _raise_for_ozon_response(response: Dict[str, Any], action: str) -> None:
    if not response.get("ok"):
        raise HTTPException(
            status_code=502,
            detail=f"{action}失败：{_ozon_response_error_text(response)}",
        )
    failures = _collect_ozon_failures(response.get("data"))
    if failures:
        detail = "；".join(failures[:5])
        if len(failures) > 5:
            detail += f"；还有 {len(failures) - 5} 个错误"
        raise HTTPException(status_code=502, detail=f"{action}部分失败：{detail}")


def _extract_ozon_items(response: Dict[str, Any]) -> List[Dict[str, Any]]:
    data = response.get("data")
    containers: List[Any] = [data]
    if isinstance(data, dict):
        containers.append(data.get("result"))
    for container in containers:
        if isinstance(container, dict):
            items = container.get("items")
            if isinstance(items, list):
                return [item for item in items if isinstance(item, dict)]
        if isinstance(container, list):
            return [item for item in container if isinstance(item, dict)]
    return []


async def _resolve_ozon_product_ids(
    store: models.Store, products: Sequence[models.Product]
) -> List[int]:
    offer_ids = [str(product.offer_id or "").strip() for product in products]
    offer_ids = [offer_id for offer_id in offer_ids if offer_id]
    if not offer_ids:
        raise HTTPException(status_code=400, detail="所选商品缺少 offer_id，无法提交 Ozon")

    by_offer_id: Dict[str, int] = {}
    for offer_id_batch in _chunked(offer_ids):
        response = await get_products_info_list(
            store.client_id,
            store.api_key,
            offer_ids=offer_id_batch,
        )
        _raise_for_ozon_response(response, "查询 Ozon 商品 ID")
        for item in _extract_ozon_items(response):
            product_id = _safe_int(item.get("id") or item.get("product_id"), 0)
            offer_id = str(item.get("offer_id") or item.get("offerId") or "").strip()
            if product_id > 0 and offer_id:
                by_offer_id[offer_id] = product_id

    missing = [offer_id for offer_id in offer_ids if offer_id not in by_offer_id]
    if missing:
        preview = "、".join(missing[:5])
        suffix = f" 等 {len(missing)} 个商品" if len(missing) > 5 else ""
        raise HTTPException(
            status_code=502,
            detail=f"Ozon 没有返回商品 ID：{preview}{suffix}",
        )

    return [by_offer_id[offer_id] for offer_id in offer_ids]


def _extract_ozon_warehouses(response: Dict[str, Any]) -> List[Dict[str, Any]]:
    data = response.get("data")
    containers: List[Any] = [data]
    if isinstance(data, dict):
        containers.append(data.get("result"))
    for container in containers:
        if isinstance(container, list):
            return [item for item in container if isinstance(item, dict)]
        if isinstance(container, dict):
            for key in ("warehouses", "items", "result"):
                value = container.get(key)
                if isinstance(value, list):
                    return [item for item in value if isinstance(item, dict)]
    return []


async def _resolve_ozon_warehouse_id(store: models.Store, warehouse_name: str) -> int:
    if warehouse_name.isdigit():
        return int(warehouse_name)

    response = await list_warehouses(store.client_id, store.api_key)
    _raise_for_ozon_response(response, "查询 Ozon 仓库")
    warehouses = _extract_ozon_warehouses(response)
    normalized_target = warehouse_name.strip().casefold()
    for warehouse in warehouses:
        name = str(warehouse.get("name") or warehouse.get("warehouse_name") or "").strip()
        warehouse_id = _safe_int(
            warehouse.get("warehouse_id") or warehouse.get("warehouseId") or warehouse.get("id"),
            0,
        )
        if warehouse_id > 0 and name.casefold() == normalized_target:
            return warehouse_id

    available = "、".join(
        str(item.get("name") or item.get("warehouse_name") or "").strip()
        for item in warehouses[:5]
        if str(item.get("name") or item.get("warehouse_name") or "").strip()
    )
    raise HTTPException(
        status_code=400,
        detail=f"店铺「{store.store_name}」没有找到 Ozon 仓库「{warehouse_name}」"
        + (f"，可用仓库：{available}" if available else ""),
    )


def _prepare_upload_job_resume(db: Session, job: models.UploadJob) -> None:
    if job.status not in UPLOAD_JOB_RESUMABLE_STATUSES:
        raise HTTPException(
            status_code=400,
            detail="Only failed, canceled, retrying, or completed-with-errors upload jobs can be resumed",
        )

    job.status = "queued"
    job.cancel_requested = False
    job.canceled_at = None
    job.finished_at = None
    job.locked_at = None
    job.celery_task_id = None
    job.error = None
    job.next_attempt_at = datetime.now(timezone.utc)
    _set_upload_job_items_status(db, job, "queued")


def _record_upload_resume_queue_result(job: models.UploadJob, queue_result: Dict[str, Any]) -> None:
    queue_payload = _load_json(job.result_payload) or {}
    queue_payload["resume_dispatcher_queue"] = queue_result
    job.result_payload = json.dumps(queue_payload, ensure_ascii=False)


def _selected_products_query(
    db: Session,
    ids: Sequence[int],
    store_id: Optional[int] = None,
    username: Optional[str] = None,
):
    query = db.query(models.Product)
    if username:
        query = _scope_query_to_user_stores(query, models.Product.store_id, db, username)
        if store_id is not None:
            _resolve_store(db, store_id, username=username)
    if ids:
        query = query.filter(models.Product.id.in_(ids))
    elif store_id is not None:
        query = query.filter(models.Product.store_id == store_id)
    else:
        raise HTTPException(status_code=400, detail="Please select products or a store")
    return query


def _require_selected_warehouse(warehouse_name: Optional[str]) -> str:
    normalized = str(warehouse_name or "").strip()
    if not normalized:
        raise HTTPException(status_code=400, detail="修改库存前必须先选择仓库")
    return normalized


def _validate_product_warehouse_scope(
    products: Sequence[models.Product], warehouse_name: str
) -> None:
    mismatched = [
        product
        for product in products
        if str(product.warehouse_name or "").strip() != warehouse_name
    ]
    if mismatched:
        raise HTTPException(
            status_code=400,
            detail="所选商品包含其他仓库的数据，请先按仓库筛选后再修改库存",
        )


def _inventory_products_query(
    db: Session,
    *,
    sku: str = "",
    article_no: str = "",
    warehouse_name: Optional[str] = None,
    backup_status: str = "",
    stock_min: Optional[int] = None,
    stock_max: Optional[int] = None,
    archive_status: str = "unarchived",
    store_id: Optional[int] = None,
    username: Optional[str] = None,
):
    query = db.query(models.Product)
    if username:
        query = _scope_query_to_user_stores(query, models.Product.store_id, db, username)
        if store_id is not None:
            _resolve_store(db, store_id, username=username)
    if sku:
        query = query.filter(models.Product.sku.ilike(f"%{sku}%"))
    if article_no:
        query = query.filter(models.Product.article_no.ilike(f"%{article_no}%"))
    if warehouse_name:
        query = query.filter(models.Product.warehouse_name == warehouse_name.strip())
    if backup_status == "backed_up":
        query = query.filter(models.Product.backup_stock > 0)
    elif backup_status == "unbacked":
        query = query.filter(or_(models.Product.backup_stock.is_(None), models.Product.backup_stock <= 0))
    if stock_min is not None:
        query = query.filter(models.Product.stock >= stock_min)
    if stock_max is not None:
        query = query.filter(models.Product.stock <= stock_max)
    if archive_status == "archived":
        query = query.filter(models.Product.archived.is_(True))
    elif archive_status == "unarchived":
        query = query.filter(models.Product.archived.is_(False))
    if store_id is not None:
        query = query.filter(models.Product.store_id == store_id)
    return query


def _selected_orders_query(
    db: Session, ids: Sequence[int], username: Optional[str] = None
):
    if not ids:
        raise HTTPException(status_code=400, detail="Please select at least one order")
    query = db.query(models.OrderRecord).filter(models.OrderRecord.id.in_(ids))
    if username:
        query = _scope_query_to_user_stores(query, models.OrderRecord.store_id, db, username)
    return query


def _store_name_map(
    db: Session, store_ids: Iterable[int], username: Optional[str] = None
) -> Dict[int, str]:
    unique_ids = {store_id for store_id in store_ids if store_id is not None}
    if not unique_ids:
        return {}
    query = db.query(models.Store).filter(models.Store.id.in_(unique_ids))
    if username:
        user = _find_user_by_username(db, username)
        tenant_id = user.primary_tenant_id if user else None
        if tenant_id is not None:
            query = query.filter(models.Store.tenant_id == tenant_id)
        else:
            query = query.filter(models.Store.user_owner == username)
    return {
        store.id: store.store_name
        for store in query.all()
    }


def _category_matches(category_path: Sequence[str], path: Sequence[str]) -> bool:
    for index, part in enumerate(path):
        if index >= len(category_path) or category_path[index] != part:
            return False
    return True


def _product_category_path(product: Optional[models.Product]) -> List[str]:
    if product is None:
        return ["未分类", "未分类", "未分类"]

    return [
        str(product.category_level_1 or "").strip() or "未分类",
        str(product.category_level_2 or "").strip() or "未分类",
        str(product.category_level_3 or "").strip() or "未分类",
    ]


def _analytics_scope_label(path: Sequence[str]) -> str:
    return " / ".join(path) if path else "全部类目"


def _analytics_group_name(
    path: Sequence[str],
    category_path: Sequence[str],
    product_name: str,
) -> str:
    if len(path) < 3:
        return str(category_path[len(path)] or "未分类")
    return product_name or "未命名商品"


def _order_product_label(order: models.OrderRecord) -> str:
    return str(order.product_name or order.posting_number or f"order-{order.id}").strip()


def _analytics_order_date(order: models.OrderRecord) -> Optional[date]:
    timestamp = _as_utc(order.created_at) or _as_utc(order.updated_at)
    return timestamp.date() if timestamp else None


def _analytics_change_rate(current: float, previous: float) -> float:
    if previous <= 0:
        return 0.0 if current <= 0 else 100.0
    return round(((current - previous) / previous) * 100, 2)


def _analytics_top_share(product_sales: Dict[str, float], total_sales: float) -> float:
    if total_sales <= 0 or not product_sales:
        return 0.0
    top_values = sorted(product_sales.values(), reverse=True)[:5]
    return round(sum(top_values) / total_sales * 100, 2)


def _pick_lookup_product(
    existing: Optional[models.Product],
    candidate: models.Product,
) -> models.Product:
    if existing is None:
        return candidate

    min_dt = datetime.min.replace(tzinfo=timezone.utc)
    existing_key = (
        1 if not existing.archived else 0,
        _as_utc(existing.updated_at) or min_dt,
        _as_utc(existing.created_at) or min_dt,
        existing.id or 0,
    )
    candidate_key = (
        1 if not candidate.archived else 0,
        _as_utc(candidate.updated_at) or min_dt,
        _as_utc(candidate.created_at) or min_dt,
        candidate.id or 0,
    )
    return candidate if candidate_key > existing_key else existing


def _build_product_lookup(
    products: Sequence[models.Product],
) -> tuple[Dict[tuple[int, str], models.Product], Dict[str, models.Product]]:
    by_store_name: Dict[tuple[int, str], models.Product] = {}
    by_name: Dict[str, models.Product] = {}

    for product in products:
        product_name = str(product.product_name or "").strip()
        if not product_name:
            continue

        store_key = (product.store_id, product_name)
        by_store_name[store_key] = _pick_lookup_product(by_store_name.get(store_key), product)
        by_name[product_name] = _pick_lookup_product(by_name.get(product_name), product)

    return by_store_name, by_name


def _empty_order_group() -> Dict[str, Any]:
    return {
        "sales_amount": 0.0,
        "order_count": 0,
        "sold_units": 0,
        "store_ids": set(),
        "product_names": set(),
        "product_sales": {},
        "matched_orders": 0,
    }


def _empty_product_group() -> Dict[str, Any]:
    return {
        "sku_count": 0,
        "stock_on_hand": 0,
        "low_stock_skus": 0,
        "price_total": 0.0,
        "price_count": 0,
        "store_ids": set(),
    }


def _build_category_analytics(
    products: List[models.Product],
    orders: List[models.OrderRecord],
    path: List[str],
    days: int,
) -> Dict[str, Any]:
    today = datetime.now(timezone.utc).date()
    current_start = today - timedelta(days=days - 1)
    previous_end = current_start - timedelta(days=1)
    previous_start = previous_end - timedelta(days=days - 1)

    active_products = [product for product in products if not product.archived]
    lookup_by_store_name, lookup_by_name = _build_product_lookup(products)

    scope_product_groups: Dict[str, Dict[str, Any]] = {}
    scope_store_ids: set[int] = set()
    scope_leaf_paths: set[tuple[str, str, str]] = set()
    scope_total_stock = 0
    scope_low_stock_skus = 0

    for product in active_products:
        category_path = _product_category_path(product)
        if not _category_matches(category_path, path):
            continue

        group_name = _analytics_group_name(
            path,
            category_path,
            str(product.product_name or "").strip(),
        )
        group = scope_product_groups.setdefault(group_name, _empty_product_group())
        stock = max(product.stock or 0, 0)
        price = max(_safe_float(product.price, 0.0), 0.0)

        group["sku_count"] += 1
        group["stock_on_hand"] += stock
        if stock <= 10:
            group["low_stock_skus"] += 1
        if price > 0:
            group["price_total"] += price
            group["price_count"] += 1
        if product.store_id is not None:
            group["store_ids"].add(product.store_id)
            scope_store_ids.add(product.store_id)

        scope_total_stock += stock
        if stock <= 10:
            scope_low_stock_skus += 1
        scope_leaf_paths.add(tuple(category_path[:3]))

    current_groups: Dict[str, Dict[str, Any]] = {}
    previous_groups: Dict[str, Dict[str, Any]] = {}
    current_product_names: set[str] = set()
    previous_product_names: set[str] = set()
    current_order_count = 0
    current_matched_orders = 0
    current_sales_total = 0.0
    previous_sales_total = 0.0
    current_units_total = 0
    previous_units_total = 0
    trend_by_date = {
        current_start + timedelta(days=offset): {"sales": 0.0, "orders": 0, "units": 0}
        for offset in range(days)
    }

    for order in orders:
        order_date = _analytics_order_date(order)
        if order_date is None or order_date < previous_start or order_date > today:
            continue

        product_name = _order_product_label(order)
        lookup_name = str(order.product_name or "").strip()
        matched_product = (
            lookup_by_store_name.get((order.store_id, lookup_name)) or lookup_by_name.get(lookup_name)
        )
        category_path = _product_category_path(matched_product)
        if not _category_matches(category_path, path):
            continue

        amount = round(max(_safe_float(order.amount, 0.0), 0.0), 2)
        sold_units = max(_safe_int(order.total_pieces, 1), 1)
        group_name = _analytics_group_name(path, category_path, product_name)

        if current_start <= order_date <= today:
            target_groups = current_groups
            current_order_count += 1
            current_sales_total += amount
            current_units_total += sold_units
            current_product_names.add(product_name)
            if matched_product is not None:
                current_matched_orders += 1

            bucket = trend_by_date[order_date]
            bucket["sales"] += amount
            bucket["orders"] += 1
            bucket["units"] += sold_units
        elif previous_start <= order_date <= previous_end:
            target_groups = previous_groups
            previous_sales_total += amount
            previous_units_total += sold_units
            previous_product_names.add(product_name)
        else:
            continue

        group = target_groups.setdefault(group_name, _empty_order_group())
        group["sales_amount"] += amount
        group["order_count"] += 1
        group["sold_units"] += sold_units
        group["product_names"].add(product_name)
        if order.store_id is not None:
            group["store_ids"].add(order.store_id)
        if matched_product is not None:
            group["matched_orders"] += 1
        group["product_sales"][product_name] = round(
            group["product_sales"].get(product_name, 0.0) + amount,
            2,
        )

    previous_order_count = sum(group["order_count"] for group in previous_groups.values())
    current_sales_total = round(current_sales_total, 2)
    previous_sales_total = round(previous_sales_total, 2)
    current_avg_order_value = round(
        current_sales_total / current_order_count,
        2,
    ) if current_order_count else 0.0
    previous_avg_order_value = round(
        previous_sales_total / previous_order_count,
        2,
    ) if previous_order_count else 0.0

    table_rows: List[Dict[str, Any]] = []
    row_names = set(scope_product_groups) | set(current_groups) | set(previous_groups)
    for name in row_names:
        current_group = current_groups.get(name) or _empty_order_group()
        previous_group = previous_groups.get(name) or _empty_order_group()
        product_group = scope_product_groups.get(name) or _empty_product_group()

        sales_amount = round(current_group["sales_amount"], 2)
        order_count = int(current_group["order_count"])
        sold_units = int(current_group["sold_units"])
        sku_count = int(product_group["sku_count"])
        stock_on_hand = int(product_group["stock_on_hand"])
        low_stock_skus = int(product_group["low_stock_skus"])
        avg_price = round(
            product_group["price_total"] / product_group["price_count"],
            2,
        ) if product_group["price_count"] else 0.0
        avg_order_value = round(sales_amount / order_count, 2) if order_count else 0.0
        store_count = len(product_group["store_ids"] or current_group["store_ids"])
        sales_share = round((sales_amount / current_sales_total) * 100, 2) if current_sales_total else 0.0

        table_rows.append(
            {
                "name": name,
                "salesAmount": sales_amount,
                "salesDelta": _analytics_change_rate(
                    sales_amount,
                    previous_group["sales_amount"],
                ),
                "salesShare": sales_share,
                "orderCount": order_count,
                "orderDelta": _analytics_change_rate(
                    order_count,
                    previous_group["order_count"],
                ),
                "soldUnits": sold_units,
                "skuCount": sku_count,
                "avgPrice": avg_price,
                "avgOrderValue": avg_order_value,
                "stockOnHand": stock_on_hand,
                "lowStockSkus": low_stock_skus,
                "storeCount": store_count,
                "top5Share": _analytics_top_share(current_group["product_sales"], sales_amount),
                "matchedOrders": int(current_group["matched_orders"]),
                "nextPath": [*path, name] if len(path) < 3 else list(path),
                "canDrillDown": len(path) < 3,
            }
        )

    table_rows.sort(
        key=lambda row: (
            row["salesAmount"],
            row["orderCount"],
            row["skuCount"],
            row["stockOnHand"],
        ),
        reverse=True,
    )

    def chart_rows(key: str) -> List[Dict[str, Any]]:
        ranked_rows = [row for row in table_rows if row[key] > 0]
        ranked_rows.sort(key=lambda row: row[key], reverse=True)
        return [{"name": row["name"], "value": row[key]} for row in ranked_rows]

    trend_labels: List[str] = []
    trend_sales: List[float] = []
    trend_orders: List[int] = []
    trend_units: List[int] = []
    for offset in range(days):
        current_date = current_start + timedelta(days=offset)
        bucket = trend_by_date[current_date]
        trend_labels.append(current_date.strftime("%m-%d"))
        trend_sales.append(round(bucket["sales"], 2))
        trend_orders.append(int(bucket["orders"]))
        trend_units.append(int(bucket["units"]))

    insights: List[str] = []
    if table_rows:
        top_sales_row = next((row for row in table_rows if row["salesAmount"] > 0), None)
        if top_sales_row is not None:
            insights.append(
                f"{top_sales_row['name']} 销售额最高，贡献 {top_sales_row['salesShare']}% 的范围内销售额。"
            )

        fastest_growth_row = max(
            (row for row in table_rows if row["salesAmount"] > 0),
            key=lambda row: row["salesDelta"],
            default=None,
        )
        if fastest_growth_row is not None and fastest_growth_row["salesDelta"] > 0:
            insights.append(
                f"{fastest_growth_row['name']} 环比增长最快，销售额较上一周期提升 {fastest_growth_row['salesDelta']}%。"
            )

        low_stock_row = max(
            table_rows,
            key=lambda row: row["lowStockSkus"],
            default=None,
        )
        if low_stock_row is not None and low_stock_row["lowStockSkus"] > 0:
            insights.append(
                f"{low_stock_row['name']} 有 {low_stock_row['lowStockSkus']} 个低库存 SKU，需要优先补货。"
            )

    unmatched_orders = max(current_order_count - current_matched_orders, 0)
    if unmatched_orders > 0:
        insights.append(f"当前范围内有 {unmatched_orders} 笔订单未匹配到商品类目，已归入未分类。")

    if not insights:
        insights.append(f"最近 {days} 天当前范围暂无订单，已保留在售商品和库存视角。")

    return {
        "path": path,
        "summary": {
            "scopeLabel": _analytics_scope_label(path),
            "totalSales": current_sales_total,
            "salesDelta": _analytics_change_rate(current_sales_total, previous_sales_total),
            "orderCount": current_order_count,
            "orderDelta": _analytics_change_rate(current_order_count, previous_order_count),
            "soldUnits": current_units_total,
            "soldUnitsDelta": _analytics_change_rate(current_units_total, previous_units_total),
            "activeSkus": len(current_product_names),
            "activeSkusDelta": _analytics_change_rate(
                len(current_product_names),
                len(previous_product_names),
            ),
            "catalogSkus": sum(group["sku_count"] for group in scope_product_groups.values()),
            "stockOnHand": scope_total_stock,
            "lowStockSkus": scope_low_stock_skus,
            "avgOrderValue": current_avg_order_value,
            "avgOrderValueDelta": _analytics_change_rate(
                current_avg_order_value,
                previous_avg_order_value,
            ),
            "storeCount": len(scope_store_ids),
            "leafCategoryCount": len(scope_leaf_paths),
            "matchedOrders": current_matched_orders,
            "unmatchedOrders": unmatched_orders,
            "matchedRate": round(
                (current_matched_orders / current_order_count) * 100,
                2,
            ) if current_order_count else 0.0,
        },
        "trend": {
            "labels": trend_labels,
            "sales": trend_sales,
            "orders": trend_orders,
            "units": trend_units,
        },
        "charts": {
            "sales": chart_rows("salesAmount"),
            "orders": chart_rows("orderCount"),
            "skus": chart_rows("skuCount"),
        },
        "table": table_rows[:50],
        "insights": insights[:3],
        "meta": {
            "days": days,
            "scopeLabel": _analytics_scope_label(path),
            "generatedAt": datetime.now(timezone.utc).isoformat(),
            "currentStart": current_start.isoformat(),
            "currentEnd": today.isoformat(),
            "previousStart": previous_start.isoformat(),
            "previousEnd": previous_end.isoformat(),
            "hasData": bool(table_rows or current_order_count or scope_product_groups),
            "canDrillDown": len(path) < 3,
        },
    }


def _calculate_pricing_rows(payload: schemas.PricingCalculationRequest) -> List[Dict[str, Any]]:
    chargeable_weight = max(
        payload.weight_g / 1000.0,
        (payload.length_mm * payload.width_mm * payload.height_mm) / 6_000_000.0,
        0.1,
    )
    battery_fee = 6.0 if payload.has_battery else 0.0
    liquid_fee = 4.0 if payload.has_liquid else 0.0
    rows: List[Dict[str, Any]] = []

    for option in SHIPPING_OPTIONS:
        logistics_cost = (
            option["base_fee"] + chargeable_weight * option["per_kg_fee"] + battery_fee + liquid_fee
        )
        commission_rate = 0.12 if payload.logistics_type == "FBS" else 0.1
        ad_rate = max(payload.ad_rate, 0.0) / 100.0
        return_rate = max(payload.return_rate, 0.0) / 100.0
        other_rate = max(payload.other_fee_rate, 0.0) / 100.0
        margin_rate = max(payload.target_margin_rate, 0.0) / 100.0
        total_rate = min(0.9, commission_rate + ad_rate + return_rate + other_rate + margin_rate)
        fixed_cost = payload.purchase_cost + payload.domestic_shipping + logistics_cost
        sale_price = round(fixed_cost / max(0.08, 1 - total_rate), 2)
        strike_price = round(
            sale_price / max(0.4, 1 - (max(payload.strike_discount_rate, 0.0) / 100.0)),
            2,
        )
        commission_amount = round(sale_price * commission_rate, 2)
        ad_cost = round(sale_price * ad_rate, 2)
        other_cost = round(sale_price * (return_rate + other_rate), 2)
        total_cost = round(fixed_cost + commission_amount + ad_cost + other_cost, 2)
        gross_profit = round(sale_price - total_cost, 2)
        rows.append(
            {
                "shortName": option["short_name"],
                "logisticsName": option["logistics_name"],
                "deliveryDays": option["delivery_days"],
                "salePrice": sale_price,
                "strikePrice": strike_price,
                "logisticsCost": round(logistics_cost, 2),
                "totalCost": total_cost,
                "grossProfit": gross_profit,
                "commissionAmount": commission_amount,
                "commissionRate": round(commission_rate * 100, 2),
                "adCost": ad_cost,
                "otherCost": other_cost,
                "chargeableWeight": round(chargeable_weight, 3),
            }
        )

    rows.sort(key=lambda row: row["grossProfit"], reverse=True)
    return rows


@app.get("/")
def root() -> Dict[str, str]:
    return {"message": "Welcome to 欧卖通"}


@app.get("/healthz")
def healthz() -> JSONResponse:
    payload = _build_health_payload()
    return JSONResponse(status_code=_health_status_code(payload), content=payload)


@app.get(f"{settings.API_V1_STR}/health")
def api_health() -> JSONResponse:
    payload = _build_health_payload(include_browser=True)
    return JSONResponse(status_code=_health_status_code(payload), content=payload)


def _serialize_admin_tenant(db: Session, tenant: models.Tenant) -> Dict[str, Any]:
    stores_count = db.query(models.Store).filter(models.Store.tenant_id == tenant.id).count()
    users_count = (
        db.query(models.TenantMember)
        .filter(models.TenantMember.tenant_id == tenant.id)
        .count()
    )
    quota = (
        db.query(models.StoreQuota)
        .filter(models.StoreQuota.tenant_id == tenant.id, models.StoreQuota.store_id.is_(None))
        .first()
    )
    return {
        "id": tenant.id,
        "name": tenant.name,
        "slug": tenant.slug,
        "status": tenant.status,
        "plan_code": tenant.plan_code,
        "subscription_status": tenant.subscription_status,
        "store_limit": tenant.store_limit,
        "user_limit": tenant.user_limit,
        "expires_at": tenant.expires_at,
        "created_at": tenant.created_at,
        "stores_count": stores_count,
        "users_count": users_count,
        "max_daily_create": quota.max_daily_create if quota else None,
        "max_daily_update": quota.max_daily_update if quota else None,
        "max_total_products": quota.max_total_products if quota else None,
    }


def _serialize_admin_user(db: Session, user: models.User) -> Dict[str, Any]:
    tenant = _user_tenant(db, user)
    return {
        "id": user.id,
        "username": user.username,
        "display_name": user.display_name,
        "email": user.email,
        "is_active": bool(user.is_active),
        "is_admin": bool(user.is_admin),
        "primary_tenant_id": user.primary_tenant_id,
        "tenant_name": tenant.name if tenant else None,
        "roles": _user_role_codes(db, user, user.primary_tenant_id),
        "created_at": user.created_at,
        "last_login_at": user.last_login_at,
    }


def _normalize_tenant_slug(value: str) -> str:
    raw = str(value or "").strip().lower()
    normalized = "".join(ch for ch in raw if ch.isalnum() or ch == "-")
    normalized = "-".join(part for part in normalized.split("-") if part)
    return normalized[:64] or f"tenant-{secrets.token_hex(4)}"


def _unique_tenant_slug(db: Session, raw_slug: str) -> str:
    base_slug = _normalize_tenant_slug(raw_slug)
    tenant_slug = base_slug
    suffix = 1
    while db.query(models.Tenant).filter(models.Tenant.slug == tenant_slug).first():
        suffix += 1
        tenant_slug = f"{base_slug}-{suffix}"
    return tenant_slug


def _get_admin_tenant_or_404(db: Session, tenant_id: int) -> models.Tenant:
    tenant = db.query(models.Tenant).filter(models.Tenant.id == tenant_id).first()
    if not tenant:
        raise HTTPException(status_code=404, detail="Tenant not found")
    return tenant


def _sync_tenant_entitlements(
    db: Session,
    tenant: models.Tenant,
    *,
    max_daily_create: Optional[int] = None,
    max_daily_update: Optional[int] = None,
    max_total_products: Optional[int] = None,
) -> None:
    subscription = (
        db.query(models.Subscription)
        .filter(models.Subscription.tenant_id == tenant.id)
        .first()
    )
    if not subscription:
        subscription = models.Subscription(tenant_id=tenant.id)
        db.add(subscription)
    subscription.plan_code = tenant.plan_code
    subscription.status = tenant.subscription_status
    subscription.current_period_end = tenant.expires_at

    plan = (
        db.query(models.TenantPlan)
        .filter(models.TenantPlan.tenant_id == tenant.id)
        .first()
    )
    if not plan:
        plan = models.TenantPlan(tenant_id=tenant.id, name=tenant.plan_code.title())
        db.add(plan)
    plan.plan_code = tenant.plan_code
    plan.name = tenant.plan_code.title()
    plan.store_limit = tenant.store_limit
    plan.user_limit = tenant.user_limit
    plan.status = tenant.status
    plan.ends_at = tenant.expires_at

    quota = (
        db.query(models.StoreQuota)
        .filter(models.StoreQuota.tenant_id == tenant.id, models.StoreQuota.store_id.is_(None))
        .first()
    )
    if not quota:
        quota = models.StoreQuota(
            tenant_id=tenant.id,
            max_stores=tenant.store_limit,
            max_daily_create=max_daily_create if max_daily_create is not None else 250,
            max_daily_update=max_daily_update if max_daily_update is not None else 5000,
            max_total_products=max_total_products if max_total_products is not None else 8000,
        )
        db.add(quota)
    quota.max_stores = tenant.store_limit
    if max_daily_create is not None:
        quota.max_daily_create = max_daily_create
    if max_daily_update is not None:
        quota.max_daily_update = max_daily_update
    if max_total_products is not None:
        quota.max_total_products = max_total_products


def _replace_user_roles(
    db: Session,
    user: models.User,
    tenant: Optional[models.Tenant],
    roles: Sequence[str],
) -> None:
    normalized_roles = {str(role or "").strip() for role in roles if str(role or "").strip()}
    if not normalized_roles:
        normalized_roles = {"user"}
    allowed_roles = {"user", "tenant_admin", "super_admin"}
    invalid_roles = sorted(normalized_roles - allowed_roles)
    if invalid_roles:
        raise HTTPException(status_code=400, detail=f"Invalid roles: {', '.join(invalid_roles)}")

    db.query(models.UserRole).filter(models.UserRole.user_id == user.id).delete(
        synchronize_session=False
    )
    if tenant:
        member = (
            db.query(models.TenantMember)
            .filter(
                models.TenantMember.tenant_id == tenant.id,
                models.TenantMember.user_id == user.id,
            )
            .first()
        )
        member_role = "tenant_admin" if "tenant_admin" in normalized_roles else "user"
        if member:
            member.role = member_role
            member.status = "active"
        else:
            db.add(
                models.TenantMember(
                    tenant_id=tenant.id,
                    user_id=user.id,
                    role=member_role,
                    status="active",
                )
            )

        for role_code in sorted(normalized_roles - {"super_admin"}):
            role = _get_or_create_role(
                db,
                role_code,
                "Tenant Admin" if role_code == "tenant_admin" else "User",
                "tenant",
                tenant.id,
                True,
            )
            _ensure_user_role(db, user, role, tenant.id)

    if "super_admin" in normalized_roles:
        role = _get_or_create_role(db, "super_admin", "Super Admin", "admin", None, True)
        _ensure_user_role(db, user, role, None)
        user.is_admin = True
    else:
        user.is_admin = False


def _admin_cache_status() -> Dict[str, int]:
    with _ACTIVITY_CACHE_LOCK:
        activity_query_entries = len(_ACTIVITY_QUERY_CACHE)
        activity_product_detail_entries = len(_ACTIVITY_PRODUCT_DETAILS_CACHE)
    with SELLER_MARKET_TRENDS_CACHE_LOCK:
        seller_market_trends_entries = len(SELLER_MARKET_TRENDS_CACHE)
    with SELLER_MARKET_ALL_ROOTS_CACHE_LOCK:
        seller_market_all_roots_entries = len(SELLER_MARKET_ALL_ROOTS_CACHE)
    with SELLER_HOT_TAGS_CACHE_LOCK:
        seller_hot_tags_entries = len(SELLER_HOT_TAGS_CACHE)
    with SELLER_PRODUCT_MARKET_CACHE_LOCK:
        seller_product_market_entries = len(SELLER_PRODUCT_MARKET_CACHE)
    return {
        "activity_query_entries": activity_query_entries,
        "activity_product_detail_entries": activity_product_detail_entries,
        "seller_market_trends_entries": seller_market_trends_entries,
        "seller_market_all_roots_entries": seller_market_all_roots_entries,
        "seller_hot_tags_entries": seller_hot_tags_entries,
        "seller_product_market_entries": seller_product_market_entries,
    }


def _clear_admin_cache_scope(scope: str) -> str:
    normalized_scope = str(scope or "all").strip().lower()
    allowed_scopes = {
        "all",
        "activity",
        "seller_market",
        "hot_tags",
        "product_market",
    }
    if normalized_scope not in allowed_scopes:
        raise HTTPException(status_code=400, detail="Invalid cache scope")

    if normalized_scope in {"all", "activity"}:
        with _ACTIVITY_CACHE_LOCK:
            _ACTIVITY_QUERY_CACHE.clear()
            _ACTIVITY_PRODUCT_DETAILS_CACHE.clear()
    if normalized_scope in {"all", "seller_market"}:
        with SELLER_MARKET_TRENDS_CACHE_LOCK:
            SELLER_MARKET_TRENDS_CACHE.clear()
        with SELLER_MARKET_ALL_ROOTS_CACHE_LOCK:
            SELLER_MARKET_ALL_ROOTS_CACHE.clear()
    if normalized_scope in {"all", "hot_tags"}:
        with SELLER_HOT_TAGS_CACHE_LOCK:
            SELLER_HOT_TAGS_CACHE.clear()
    if normalized_scope in {"all", "product_market"}:
        with SELLER_PRODUCT_MARKET_CACHE_LOCK:
            SELLER_PRODUCT_MARKET_CACHE.clear()
    return normalized_scope


def _normalize_sync_job_type(job_type: str) -> str:
    normalized = str(job_type or "").strip().lower()
    if normalized not in SYNC_JOB_TYPES:
        raise HTTPException(status_code=400, detail="Unsupported sync job type")
    return normalized


def _sync_schedule_next_run(interval_minutes: int, base: Optional[datetime] = None) -> datetime:
    safe_interval = max(int(interval_minutes or 60), 5)
    base_time = base or datetime.now(timezone.utc)
    return base_time + timedelta(minutes=safe_interval)


def _normalize_sync_interval(job_type: str, interval_minutes: int) -> int:
    safe_interval = max(int(interval_minutes or 60), 5)
    if job_type == "sync_orders":
        return max(safe_interval, ORDER_SYNC_INTERVAL_MINUTES)
    return safe_interval


def _get_admin_store_for_tenant(
    db: Session,
    tenant_id: int,
    store_id: Optional[int],
) -> Optional[models.Store]:
    if store_id is None:
        return None
    store = (
        db.query(models.Store)
        .filter(models.Store.id == store_id, models.Store.tenant_id == tenant_id)
        .first()
    )
    if not store:
        raise HTTPException(status_code=404, detail="Store not found for tenant")
    return store


def _serialize_sync_schedule(db: Session, schedule: models.SyncSchedule) -> Dict[str, Any]:
    tenant = db.query(models.Tenant).filter(models.Tenant.id == schedule.tenant_id).first()
    store = (
        db.query(models.Store).filter(models.Store.id == schedule.store_id).first()
        if schedule.store_id
        else None
    )
    return {
        "id": schedule.id,
        "tenant_id": schedule.tenant_id,
        "tenant_name": tenant.name if tenant else None,
        "store_id": schedule.store_id,
        "store_name": store.store_name if store else None,
        "name": schedule.name,
        "job_type": schedule.job_type,
        "enabled": bool(schedule.enabled),
        "interval_minutes": schedule.interval_minutes,
        "days": schedule.days,
        "last_run_at": schedule.last_run_at,
        "next_run_at": schedule.next_run_at,
        "last_status": schedule.last_status,
        "last_message": schedule.last_message,
        "last_task_id": schedule.last_task_id,
        "locked_until": schedule.locked_until,
        "created_at": schedule.created_at,
        "updated_at": schedule.updated_at,
    }


def _serialize_sync_run(db: Session, run: models.SyncRun) -> Dict[str, Any]:
    tenant = db.query(models.Tenant).filter(models.Tenant.id == run.tenant_id).first()
    store = db.query(models.Store).filter(models.Store.id == run.store_id).first() if run.store_id else None
    return {
        "id": run.id,
        "tenant_id": run.tenant_id,
        "tenant_name": tenant.name if tenant else None,
        "schedule_id": run.schedule_id,
        "store_id": run.store_id,
        "store_name": store.store_name if store else None,
        "job_type": run.job_type,
        "status": run.status,
        "triggered_by": run.triggered_by,
        "task_id": run.task_id,
        "started_at": run.started_at,
        "finished_at": run.finished_at,
        "result_payload": _load_json(run.result_payload) if run.result_payload else None,
        "error": run.error,
        "created_at": run.created_at,
    }


@app.get(
    f"{settings.API_V1_STR}/admin/overview",
    response_model=schemas.AdminOverviewResponse,
)
def admin_overview(
    _: models.User = Depends(_require_super_admin),
    db: Session = Depends(get_db),
) -> Dict[str, int]:
    return {
        "tenants": db.query(models.Tenant).count(),
        "users": db.query(models.User).count(),
        "stores": db.query(models.Store).count(),
        "products": db.query(models.Product).count(),
        "orders": db.query(models.OrderRecord).count(),
        "active_subscriptions": db.query(models.Subscription)
        .filter(models.Subscription.status == "active")
        .count(),
    }


@app.get(
    f"{settings.API_V1_STR}/admin/tenants",
    response_model=List[schemas.AdminTenantResponse],
)
def admin_list_tenants(
    status_filter: str = Query(default="", alias="status"),
    _: models.User = Depends(_require_super_admin),
    db: Session = Depends(get_db),
) -> List[Dict[str, Any]]:
    query = db.query(models.Tenant)
    if status_filter:
        query = query.filter(models.Tenant.status == status_filter)
    tenants = query.order_by(models.Tenant.id.asc()).all()
    return [_serialize_admin_tenant(db, tenant) for tenant in tenants]


@app.post(
    f"{settings.API_V1_STR}/admin/tenants",
    response_model=schemas.AdminTenantResponse,
)
def admin_create_tenant(
    payload: schemas.AdminTenantCreateRequest,
    request: Request,
    _: models.User = Depends(_require_super_admin),
    db: Session = Depends(get_db),
) -> Dict[str, Any]:
    tenant_name = str(payload.name or "").strip()
    if not tenant_name:
        raise HTTPException(status_code=400, detail="Tenant name is required")

    tenant = models.Tenant(
        name=tenant_name,
        slug=_unique_tenant_slug(db, payload.slug or tenant_name),
        status=payload.status,
        plan_code=payload.plan_code,
        subscription_status=payload.subscription_status,
        store_limit=payload.store_limit,
        user_limit=payload.user_limit,
        expires_at=payload.expires_at,
    )
    db.add(tenant)
    db.flush()
    _sync_tenant_entitlements(
        db,
        tenant,
        max_daily_create=payload.max_daily_create,
        max_daily_update=payload.max_daily_update,
        max_total_products=payload.max_total_products,
    )
    _write_audit_log(
        db,
        request,
        "admin.tenant.create",
        "tenant",
        str(tenant.id),
        {"slug": tenant.slug, "plan_code": tenant.plan_code},
        tenant_id=tenant.id,
    )
    db.commit()
    db.refresh(tenant)
    return _serialize_admin_tenant(db, tenant)


@app.put(
    f"{settings.API_V1_STR}/admin/tenants/{{tenant_id}}",
    response_model=schemas.AdminTenantResponse,
)
def admin_update_tenant(
    tenant_id: int,
    payload: schemas.AdminTenantUpdateRequest,
    request: Request,
    _: models.User = Depends(_require_super_admin),
    db: Session = Depends(get_db),
) -> Dict[str, Any]:
    tenant = _get_admin_tenant_or_404(db, tenant_id)
    update_data = payload.model_dump(exclude_unset=True)
    for field in (
        "name",
        "status",
        "plan_code",
        "subscription_status",
        "store_limit",
        "user_limit",
        "expires_at",
    ):
        if field in update_data:
            setattr(tenant, field, update_data[field])

    _sync_tenant_entitlements(
        db,
        tenant,
        max_daily_create=payload.max_daily_create if "max_daily_create" in update_data else None,
        max_daily_update=payload.max_daily_update if "max_daily_update" in update_data else None,
        max_total_products=payload.max_total_products if "max_total_products" in update_data else None,
    )
    _write_audit_log(
        db,
        request,
        "admin.tenant.update",
        "tenant",
        str(tenant.id),
        update_data,
        tenant_id=tenant.id,
    )
    db.commit()
    db.refresh(tenant)
    return _serialize_admin_tenant(db, tenant)


@app.get(
    f"{settings.API_V1_STR}/admin/users",
    response_model=List[schemas.AdminUserResponse],
)
def admin_list_users(
    tenant_id: Optional[int] = Query(default=None),
    search: str = Query(default=""),
    _: models.User = Depends(_require_super_admin),
    db: Session = Depends(get_db),
) -> List[Dict[str, Any]]:
    query = db.query(models.User)
    if tenant_id is not None:
        query = query.filter(models.User.primary_tenant_id == tenant_id)
    if search:
        like_value = f"%{search.strip()}%"
        query = query.filter(
            or_(models.User.username.ilike(like_value), models.User.display_name.ilike(like_value))
        )
    users = query.order_by(models.User.id.asc()).all()
    return [_serialize_admin_user(db, user) for user in users]


@app.post(
    f"{settings.API_V1_STR}/admin/users",
    response_model=schemas.AdminUserResponse,
)
def admin_create_user(
    payload: schemas.AdminUserCreateRequest,
    request: Request,
    _: models.User = Depends(_require_super_admin),
    db: Session = Depends(get_db),
) -> Dict[str, Any]:
    username = _normalize_username(payload.username)
    if len(username) < USERNAME_MIN_LENGTH or len(username) > USERNAME_MAX_LENGTH:
        raise HTTPException(status_code=400, detail="Invalid username length")
    if len(payload.password or "") < 6:
        raise HTTPException(status_code=400, detail="Password must be at least 6 characters")
    if _find_user_by_username(db, username):
        raise HTTPException(status_code=409, detail="Username already exists")
    email = str(payload.email or "").strip() or None
    if email and db.query(models.User).filter(models.User.email == email).first():
        raise HTTPException(status_code=409, detail="Email already exists")
    tenant = _get_admin_tenant_or_404(db, payload.tenant_id)
    active_members = (
        db.query(models.TenantMember)
        .filter(models.TenantMember.tenant_id == tenant.id, models.TenantMember.status == "active")
        .count()
    )
    if tenant.user_limit and active_members >= tenant.user_limit:
        raise HTTPException(status_code=403, detail="Tenant user quota exceeded")

    user = models.User(
        username=username,
        display_name=_normalize_display_name(payload.display_name, username),
        email=email,
        password_hash=_build_password_hash(payload.password),
        primary_tenant_id=tenant.id,
        is_active=payload.is_active,
        is_admin=False,
    )
    db.add(user)
    db.flush()
    _replace_user_roles(db, user, tenant, payload.roles)
    _write_audit_log(
        db,
        request,
        "admin.user.create",
        "user",
        str(user.id),
        {"username": user.username, "tenant_id": tenant.id, "roles": payload.roles},
        tenant_id=tenant.id,
    )
    db.commit()
    db.refresh(user)
    return _serialize_admin_user(db, user)


@app.put(
    f"{settings.API_V1_STR}/admin/users/{{user_id}}",
    response_model=schemas.AdminUserResponse,
)
def admin_update_user(
    user_id: int,
    payload: schemas.AdminUserUpdateRequest,
    request: Request,
    _: models.User = Depends(_require_super_admin),
    db: Session = Depends(get_db),
) -> Dict[str, Any]:
    user = db.query(models.User).filter(models.User.id == user_id).first()
    if not user:
        raise HTTPException(status_code=404, detail="User not found")
    update_data = payload.model_dump(exclude_unset=True)
    tenant = _user_tenant(db, user)
    if "tenant_id" in update_data:
        tenant = _get_admin_tenant_or_404(db, int(update_data["tenant_id"]))
        user.primary_tenant_id = tenant.id
    if "display_name" in update_data:
        user.display_name = _normalize_display_name(update_data["display_name"], user.username)
    if "email" in update_data:
        email = str(update_data["email"] or "").strip() or None
        if email:
            existing_email = (
                db.query(models.User)
                .filter(models.User.email == email, models.User.id != user.id)
                .first()
            )
            if existing_email:
                raise HTTPException(status_code=409, detail="Email already exists")
        user.email = email
    if "is_active" in update_data:
        user.is_active = bool(update_data["is_active"])
    if "password" in update_data and update_data["password"]:
        if len(str(update_data["password"])) < 6:
            raise HTTPException(status_code=400, detail="Password must be at least 6 characters")
        user.password_hash = _build_password_hash(str(update_data["password"]))
    if payload.roles is not None:
        if user.id == _current_user_id(request) and "super_admin" not in payload.roles:
            raise HTTPException(
                status_code=400,
                detail="Current admin cannot remove their own super_admin role",
            )
        _replace_user_roles(db, user, tenant, payload.roles)
    _write_audit_log(
        db,
        request,
        "admin.user.update",
        "user",
        str(user.id),
        {key: value for key, value in update_data.items() if key != "password"},
        tenant_id=tenant.id if tenant else user.primary_tenant_id,
    )
    db.commit()
    db.refresh(user)
    return _serialize_admin_user(db, user)


@app.get(
    f"{settings.API_V1_STR}/admin/roles",
    response_model=List[schemas.AdminRoleResponse],
)
def admin_list_roles(
    _: models.User = Depends(_require_super_admin),
    db: Session = Depends(get_db),
) -> List[models.Role]:
    return db.query(models.Role).order_by(models.Role.scope.asc(), models.Role.id.asc()).all()


@app.get(
    f"{settings.API_V1_STR}/admin/permissions",
    response_model=List[schemas.AdminPermissionResponse],
)
def admin_list_permissions(
    _: models.User = Depends(_require_super_admin),
    db: Session = Depends(get_db),
) -> List[models.Permission]:
    return db.query(models.Permission).order_by(models.Permission.group.asc(), models.Permission.id.asc()).all()


@app.get(
    f"{settings.API_V1_STR}/admin/menus",
    response_model=List[schemas.AdminMenuResponse],
)
def admin_list_menus(
    _: models.User = Depends(_require_super_admin),
    db: Session = Depends(get_db),
) -> List[models.Menu]:
    return db.query(models.Menu).order_by(models.Menu.sort_order.asc(), models.Menu.id.asc()).all()


@app.get(
    f"{settings.API_V1_STR}/admin/audit-logs",
    response_model=List[schemas.AdminAuditLogResponse],
)
def admin_list_audit_logs(
    limit: int = Query(default=100, ge=1, le=500),
    tenant_id: Optional[int] = Query(default=None),
    action: str = Query(default=""),
    _: models.User = Depends(_require_super_admin),
    db: Session = Depends(get_db),
) -> List[models.AuditLog]:
    query = db.query(models.AuditLog)
    if tenant_id is not None:
        query = query.filter(models.AuditLog.tenant_id == tenant_id)
    if action:
        query = query.filter(models.AuditLog.action.ilike(f"%{action.strip()}%"))
    return query.order_by(models.AuditLog.id.desc()).limit(limit).all()


@app.get(
    f"{settings.API_V1_STR}/admin/login-logs",
    response_model=List[schemas.AdminLoginLogResponse],
)
def admin_list_login_logs(
    limit: int = Query(default=100, ge=1, le=500),
    tenant_id: Optional[int] = Query(default=None),
    success: Optional[bool] = Query(default=None),
    _: models.User = Depends(_require_super_admin),
    db: Session = Depends(get_db),
) -> List[models.LoginLog]:
    query = db.query(models.LoginLog)
    if tenant_id is not None:
        query = query.filter(models.LoginLog.tenant_id == tenant_id)
    if success is not None:
        query = query.filter(models.LoginLog.success == success)
    return query.order_by(models.LoginLog.id.desc()).limit(limit).all()


@app.get(
    f"{settings.API_V1_STR}/admin/cache/status",
    response_model=schemas.AdminCacheStatusResponse,
)
def admin_cache_status(
    _: models.User = Depends(_require_super_admin),
) -> Dict[str, int]:
    return _admin_cache_status()


@app.post(
    f"{settings.API_V1_STR}/admin/cache/clear",
    response_model=schemas.AdminCacheClearResponse,
)
def admin_clear_cache(
    payload: schemas.AdminCacheClearRequest,
    request: Request,
    _: models.User = Depends(_require_super_admin),
    db: Session = Depends(get_db),
) -> Dict[str, Any]:
    cleared_scope = _clear_admin_cache_scope(payload.scope)
    _write_audit_log(
        db,
        request,
        "admin.cache.clear",
        "cache",
        cleared_scope,
        {"scope": cleared_scope},
    )
    db.commit()
    return {"cleared_scope": cleared_scope, **_admin_cache_status()}


@app.post(
    f"{settings.API_V1_STR}/admin/cache/sync-seller-analytics",
    response_model=schemas.AsyncTaskSubmitResponse,
)
def admin_sync_seller_analytics_cache(
    payload: schemas.AdminSellerAnalyticsSyncRequest,
    request: Request,
    _: models.User = Depends(_require_super_admin),
    db: Session = Depends(get_db),
) -> Dict[str, Any]:
    if payload.tenant_id is not None:
        _get_admin_tenant_or_404(db, payload.tenant_id)
    if payload.store_id is not None and payload.tenant_id is not None:
        _get_admin_store_for_tenant(db, payload.tenant_id, payload.store_id)
    result = _submit_async_task(
        "ozon.refresh_analytics",
        queue="sync",
        tenant_id=payload.tenant_id,
        store_id=payload.store_id,
        days=payload.days,
    )
    _write_audit_log(
        db,
        request,
        "admin.cache.sync_seller_analytics",
        "cache",
        "seller_analytics",
        {"task_id": result.get("task_id"), "tenant_id": payload.tenant_id, "store_id": payload.store_id},
        tenant_id=payload.tenant_id,
    )
    db.commit()
    return result


@app.get(
    f"{settings.API_V1_STR}/admin/sync-schedules",
    response_model=List[schemas.AdminSyncScheduleResponse],
)
def admin_list_sync_schedules(
    tenant_id: Optional[int] = Query(default=None),
    enabled: Optional[bool] = Query(default=None),
    _: models.User = Depends(_require_super_admin),
    db: Session = Depends(get_db),
) -> List[Dict[str, Any]]:
    query = db.query(models.SyncSchedule)
    if tenant_id is not None:
        query = query.filter(models.SyncSchedule.tenant_id == tenant_id)
    if enabled is not None:
        query = query.filter(models.SyncSchedule.enabled == enabled)
    schedules = query.order_by(models.SyncSchedule.id.asc()).all()
    return [_serialize_sync_schedule(db, schedule) for schedule in schedules]


@app.post(
    f"{settings.API_V1_STR}/admin/sync-schedules",
    response_model=schemas.AdminSyncScheduleResponse,
)
def admin_create_sync_schedule(
    payload: schemas.AdminSyncScheduleCreateRequest,
    request: Request,
    _: models.User = Depends(_require_super_admin),
    db: Session = Depends(get_db),
) -> Dict[str, Any]:
    tenant = _get_admin_tenant_or_404(db, payload.tenant_id)
    store = _get_admin_store_for_tenant(db, tenant.id, payload.store_id)
    job_type = _normalize_sync_job_type(payload.job_type)
    interval_minutes = _normalize_sync_interval(job_type, payload.interval_minutes)
    schedule_name = str(payload.name or "").strip() or SYNC_JOB_TYPES[job_type]
    schedule = models.SyncSchedule(
        tenant_id=tenant.id,
        store_id=store.id if store else None,
        name=schedule_name,
        job_type=job_type,
        enabled=payload.enabled,
        interval_minutes=interval_minutes,
        days=payload.days,
        next_run_at=payload.next_run_at
        or _sync_schedule_next_run(interval_minutes),
        last_status="idle",
    )
    db.add(schedule)
    db.flush()
    _write_audit_log(
        db,
        request,
        "admin.sync_schedule.create",
        "sync_schedule",
        str(schedule.id),
        {
            "tenant_id": tenant.id,
            "store_id": schedule.store_id,
            "job_type": schedule.job_type,
            "interval_minutes": schedule.interval_minutes,
        },
        tenant_id=tenant.id,
    )
    db.commit()
    db.refresh(schedule)
    return _serialize_sync_schedule(db, schedule)


@app.put(
    f"{settings.API_V1_STR}/admin/sync-schedules/{{schedule_id}}",
    response_model=schemas.AdminSyncScheduleResponse,
)
def admin_update_sync_schedule(
    schedule_id: int,
    payload: schemas.AdminSyncScheduleUpdateRequest,
    request: Request,
    _: models.User = Depends(_require_super_admin),
    db: Session = Depends(get_db),
) -> Dict[str, Any]:
    schedule = db.query(models.SyncSchedule).filter(models.SyncSchedule.id == schedule_id).first()
    if not schedule:
        raise HTTPException(status_code=404, detail="Sync schedule not found")
    update_data = payload.model_dump(exclude_unset=True)

    target_tenant_id = int(update_data.get("tenant_id") or schedule.tenant_id)
    tenant = _get_admin_tenant_or_404(db, target_tenant_id)
    store_id = update_data.get("store_id", schedule.store_id)
    store = _get_admin_store_for_tenant(db, tenant.id, store_id)

    if "tenant_id" in update_data:
        schedule.tenant_id = tenant.id
    if "store_id" in update_data:
        schedule.store_id = store.id if store else None
    if "name" in update_data:
        schedule.name = str(update_data["name"] or "").strip() or schedule.name
    if "job_type" in update_data:
        schedule.job_type = _normalize_sync_job_type(str(update_data["job_type"]))
    if "enabled" in update_data:
        schedule.enabled = bool(update_data["enabled"])
    if "interval_minutes" in update_data and update_data["interval_minutes"] is not None:
        schedule.interval_minutes = _normalize_sync_interval(
            schedule.job_type,
            int(update_data["interval_minutes"]),
        )
    else:
        schedule.interval_minutes = _normalize_sync_interval(
            schedule.job_type,
            schedule.interval_minutes,
        )
    if "days" in update_data and update_data["days"] is not None:
        schedule.days = int(update_data["days"])
    if "next_run_at" in update_data:
        schedule.next_run_at = update_data["next_run_at"]
    elif "interval_minutes" in update_data:
        schedule.next_run_at = _sync_schedule_next_run(schedule.interval_minutes)

    _write_audit_log(
        db,
        request,
        "admin.sync_schedule.update",
        "sync_schedule",
        str(schedule.id),
        update_data,
        tenant_id=schedule.tenant_id,
    )
    db.commit()
    db.refresh(schedule)
    return _serialize_sync_schedule(db, schedule)


@app.post(
    f"{settings.API_V1_STR}/admin/sync-schedules/{{schedule_id}}/run",
    response_model=schemas.AsyncTaskSubmitResponse,
)
def admin_run_sync_schedule(
    schedule_id: int,
    request: Request,
    _: models.User = Depends(_require_super_admin),
    db: Session = Depends(get_db),
) -> Dict[str, Any]:
    schedule = db.query(models.SyncSchedule).filter(models.SyncSchedule.id == schedule_id).first()
    if not schedule:
        raise HTTPException(status_code=404, detail="Sync schedule not found")
    result = _submit_async_task(
        "ozon.run_sync_schedule",
        queue="sync",
        schedule_id=schedule.id,
        triggered_by=_current_username(request),
    )
    schedule.last_task_id = result.get("task_id")
    schedule.last_status = "queued"
    _write_audit_log(
        db,
        request,
        "admin.sync_schedule.run",
        "sync_schedule",
        str(schedule.id),
        {"task_id": schedule.last_task_id},
        tenant_id=schedule.tenant_id,
    )
    db.commit()
    return result


@app.get(
    f"{settings.API_V1_STR}/admin/sync-runs",
    response_model=List[schemas.AdminSyncRunResponse],
)
def admin_list_sync_runs(
    limit: int = Query(default=100, ge=1, le=500),
    tenant_id: Optional[int] = Query(default=None),
    schedule_id: Optional[int] = Query(default=None),
    _: models.User = Depends(_require_super_admin),
    db: Session = Depends(get_db),
) -> List[Dict[str, Any]]:
    query = db.query(models.SyncRun)
    if tenant_id is not None:
        query = query.filter(models.SyncRun.tenant_id == tenant_id)
    if schedule_id is not None:
        query = query.filter(models.SyncRun.schedule_id == schedule_id)
    runs = query.order_by(models.SyncRun.id.desc()).limit(limit).all()
    return [_serialize_sync_run(db, run) for run in runs]


@app.get(
    f"{settings.API_V1_STR}/admin/task-monitor",
    response_model=schemas.AdminTaskMonitorResponse,
)
def admin_task_monitor(
    _: models.User = Depends(_require_super_admin),
    db: Session = Depends(get_db),
) -> Dict[str, Any]:
    upload_counts = [
        {"status": status_value or "unknown", "count": int(count or 0)}
        for status_value, count in (
            db.query(models.UploadJob.status, func.count(models.UploadJob.id))
            .group_by(models.UploadJob.status)
            .order_by(models.UploadJob.status.asc())
            .all()
        )
    ]
    sync_counts = [
        {"status": status_value or "unknown", "count": int(count or 0)}
        for status_value, count in (
            db.query(models.SyncRun.status, func.count(models.SyncRun.id))
            .group_by(models.SyncRun.status)
            .order_by(models.SyncRun.status.asc())
            .all()
        )
    ]
    recent_upload_jobs = (
        db.query(models.UploadJob)
        .order_by(models.UploadJob.id.desc())
        .limit(50)
        .all()
    )
    store_names = _store_name_map(db, [job.store_id for job in recent_upload_jobs])
    items_by_job = _upload_job_items_by_job_ids(db, [job.id for job in recent_upload_jobs])
    recent_sync_runs = (
        db.query(models.SyncRun)
        .order_by(models.SyncRun.id.desc())
        .limit(50)
        .all()
    )
    upload_queue_backlog = int(
        db.query(func.count(models.UploadJob.id))
        .filter(models.UploadJob.status.in_({"queued", "retrying", "queue_failed"}))
        .scalar()
        or 0
    )
    return {
        "upload_status_counts": upload_counts,
        "upload_active_global_stores": _global_active_upload_store_count(db),
        "upload_queue_backlog": upload_queue_backlog,
        "recent_upload_jobs": [
            _serialize_upload_job(
                job,
                store_names.get(job.store_id),
                items_by_job.get(job.id, []),
            )
            for job in recent_upload_jobs
        ],
        "sync_status_counts": sync_counts,
        "recent_sync_runs": [_serialize_sync_run(db, run) for run in recent_sync_runs],
    }


@app.get(
    f"{settings.API_V1_STR}/admin/system-alerts",
    response_model=List[schemas.AdminSystemAlertResponse],
)
def admin_system_alerts(
    _: models.User = Depends(_require_super_admin),
    db: Session = Depends(get_db),
) -> List[Dict[str, Any]]:
    since = datetime.now(timezone.utc) - timedelta(hours=24)
    recent_total = int(
        db.query(func.count(models.UploadJob.id))
        .filter(models.UploadJob.created_at >= since)
        .scalar()
        or 0
    )
    recent_failed = int(
        db.query(func.count(models.UploadJob.id))
        .filter(models.UploadJob.created_at >= since)
        .filter(
            models.UploadJob.status.in_(
                {"failed", "submit_failed", "queue_failed", "completed_with_errors"}
            )
        )
        .scalar()
        or 0
    )
    error_total = int(
        db.query(func.count(models.UploadJob.id))
        .filter(models.UploadJob.created_at >= since)
        .filter(models.UploadJob.error.isnot(None))
        .scalar()
        or 0
    )
    queue_backlog = int(
        db.query(func.count(models.UploadJob.id))
        .filter(models.UploadJob.status.in_({"queued", "retrying", "queue_failed"}))
        .scalar()
        or 0
    )
    failure_rate = float(recent_failed / recent_total) if recent_total else 0.0
    api_error_rate = float(error_total / recent_total) if recent_total else 0.0
    backlog_threshold = float(max(int(settings.UPLOAD_MAX_GLOBAL_ACTIVE_STORES) * 4, 96))
    return [
        {
            "code": "upload_failure_rate",
            "severity": "critical" if failure_rate >= 0.2 else "warning" if failure_rate >= 0.1 else "info",
            "status": "alert" if failure_rate >= 0.1 else "ok",
            "message": "上传失败率超过阈值" if failure_rate >= 0.1 else "上传失败率正常",
            "value": round(failure_rate, 4),
            "threshold": 0.1,
        },
        {
            "code": "ozon_api_error_rate",
            "severity": "critical" if api_error_rate >= 0.2 else "warning" if api_error_rate >= 0.1 else "info",
            "status": "alert" if api_error_rate >= 0.1 else "ok",
            "message": "Ozon API 错误率超过阈值" if api_error_rate >= 0.1 else "Ozon API 错误率正常",
            "value": round(api_error_rate, 4),
            "threshold": 0.1,
        },
        {
            "code": "upload_queue_backlog",
            "severity": "warning" if queue_backlog >= backlog_threshold else "info",
            "status": "alert" if queue_backlog >= backlog_threshold else "ok",
            "message": "上传队列堆积超过阈值" if queue_backlog >= backlog_threshold else "上传队列堆积正常",
            "value": float(queue_backlog),
            "threshold": backlog_threshold,
        },
        {
            "code": "db_slow_query",
            "severity": "info",
            "status": "unknown",
            "message": "慢查询告警需要接入 RDS Performance Insights 或 PostgreSQL pg_stat_statements。",
            "value": None,
            "threshold": None,
        },
    ]


@app.post(
    f"{settings.API_V1_STR}/auth/register",
    response_model=schemas.AuthLoginResponse,
)
def register(
    payload: schemas.AuthRegisterRequest,
    request: Request,
    db: Session = Depends(get_db),
) -> Dict[str, Any]:
    username = _normalize_username(payload.username)
    if len(username) < USERNAME_MIN_LENGTH or len(username) > USERNAME_MAX_LENGTH:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=f"用户名长度需在 {USERNAME_MIN_LENGTH} 到 {USERNAME_MAX_LENGTH} 个字符之间",
        )
    if len(payload.password or "") < 6:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="密码至少需要 6 位",
        )
    if _find_user_by_username(db, username):
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="用户名已存在",
        )

    email = (payload.email or "").strip() or None
    if email:
        existing_email = (
            db.query(models.User).filter(models.User.email == email).first()
        )
        if existing_email:
            raise HTTPException(
                status_code=status.HTTP_409_CONFLICT,
                detail="邮箱已存在",
            )

    tenant_slug_base = "".join(ch for ch in username.lower() if ch.isalnum() or ch == "-") or username.lower()
    tenant_slug = tenant_slug_base
    suffix = 1
    while db.query(models.Tenant).filter(models.Tenant.slug == tenant_slug).first():
        suffix += 1
        tenant_slug = f"{tenant_slug_base}-{suffix}"
    tenant = models.Tenant(
        name=f"{_normalize_display_name(payload.display_name, username)} 的团队",
        slug=tenant_slug,
        status="active",
        plan_code="starter",
        subscription_status="active",
        store_limit=1,
        user_limit=3,
    )
    db.add(tenant)
    db.flush()

    user = models.User(
        username=username,
        display_name=_normalize_display_name(payload.display_name, username),
        email=email,
        password_hash=_build_password_hash(payload.password),
        primary_tenant_id=tenant.id,
        is_active=True,
        is_admin=False,
    )
    db.add(user)
    db.flush()
    _ensure_tenant_member(db, tenant.id, user.id, "tenant_admin")
    tenant_admin_role = _get_or_create_role(
        db, "tenant_admin", "Tenant Admin", "tenant", tenant.id, True
    )
    _ensure_user_role(db, user, tenant_admin_role, tenant.id)
    db.add(
        models.Subscription(
            tenant_id=tenant.id,
            plan_code="starter",
            status="active",
        )
    )
    db.add(
        models.TenantPlan(
            tenant_id=tenant.id,
            plan_code="starter",
            name="Starter",
            billing_cycle="monthly",
            price=0.0,
            store_limit=tenant.store_limit,
            user_limit=tenant.user_limit,
            status="active",
        )
    )
    db.add(
        models.StoreQuota(
            tenant_id=tenant.id,
            max_stores=tenant.store_limit,
            max_daily_create=250,
            max_daily_update=5000,
            max_total_products=8000,
        )
    )
    db.add(
        models.LoginLog(
            tenant_id=tenant.id,
            user_id=user.id,
            username=user.username,
            role_scope="app",
            success=True,
            ip_address=_client_ip(request),
            user_agent=request.headers.get("user-agent"),
        )
    )
    db.commit()
    db.refresh(user)

    return {
        "access_token": _create_access_token(user, db),
        "token_type": "bearer",
        "user": _serialize_auth_user(user, db),
    }


@app.post(
    f"{settings.API_V1_STR}/auth/login",
    response_model=schemas.AuthLoginResponse,
)
def login(
    payload: schemas.AuthLoginRequest,
    request: Request,
    db: Session = Depends(get_db),
) -> Dict[str, Any]:
    user = _find_user_by_username(db, payload.username)
    if not user or not _verify_password(payload.password, user.password_hash):
        db.add(
            models.LoginLog(
                tenant_id=user.primary_tenant_id if user else None,
                user_id=user.id if user else None,
                username=_normalize_username(payload.username),
                role_scope="unknown",
                success=False,
                ip_address=_client_ip(request),
                user_agent=request.headers.get("user-agent"),
                failure_reason="invalid_credentials",
            )
        )
        db.commit()
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Invalid username or password",
        )
    if not user.is_active:
        db.add(
            models.LoginLog(
                tenant_id=user.primary_tenant_id,
                user_id=user.id,
                username=user.username,
                role_scope="unknown",
                success=False,
                ip_address=_client_ip(request),
                user_agent=request.headers.get("user-agent"),
                failure_reason="disabled",
            )
        )
        db.commit()
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="User account is disabled",
        )
    user.last_login_at = datetime.now(timezone.utc)
    db.add(
        models.LoginLog(
            tenant_id=user.primary_tenant_id,
            user_id=user.id,
            username=user.username,
            role_scope="admin" if user.is_admin else "app",
            success=True,
            ip_address=_client_ip(request),
            user_agent=request.headers.get("user-agent"),
        )
    )
    db.commit()
    db.refresh(user)

    return {
        "access_token": _create_access_token(user, db),
        "token_type": "bearer",
        "user": _serialize_auth_user(user, db),
    }


@app.get(
    f"{settings.API_V1_STR}/auth/me",
    response_model=schemas.AuthUserResponse,
)
def get_current_user(request: Request, db: Session = Depends(get_db)) -> Dict[str, Any]:
    user = _find_user_by_username(db, request.state.current_user)
    if not user or not user.is_active:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="User not found or disabled",
        )
    return _serialize_auth_user(user, db)


@app.get(
    f"{settings.API_V1_STR}/dashboard/summary",
    response_model=schemas.DashboardSummaryResponse,
)
async def get_dashboard_summary(
    request: Request,
    store_id: Optional[int] = Query(default=None),
    db: Session = Depends(get_db),
) -> Dict[str, int]:
    username = _current_username(request)
    now = datetime.now(timezone.utc)
    today_start = datetime(now.year, now.month, now.day, tzinfo=timezone.utc)
    today_orders_query = db.query(models.OrderRecord).filter(
        models.OrderRecord.created_at >= today_start
    )
    pending_fbs_orders_query = db.query(models.OrderRecord).filter(
        models.OrderRecord.scheme == "FBS",
        models.OrderRecord.status.in_(PENDING_ORDER_STATUSES),
    )
    stores_query = _user_store_query(db, username)
    products_query = db.query(models.Product)
    upload_jobs_query = db.query(models.UploadJob)

    today_orders_query = _scope_query_to_user_stores(
        today_orders_query, models.OrderRecord.store_id, db, username
    )
    pending_fbs_orders_query = _scope_query_to_user_stores(
        pending_fbs_orders_query, models.OrderRecord.store_id, db, username
    )
    products_query = _scope_query_to_user_stores(
        products_query, models.Product.store_id, db, username
    )
    upload_jobs_query = _scope_query_to_user_stores(
        upload_jobs_query, models.UploadJob.store_id, db, username
    )

    if store_id is not None:
        _resolve_store(db, store_id, username=username)
        today_orders_query = today_orders_query.filter(models.OrderRecord.store_id == store_id)
        pending_fbs_orders_query = pending_fbs_orders_query.filter(
            models.OrderRecord.store_id == store_id
        )
        stores_query = stores_query.filter(models.Store.id == store_id)
        products_query = products_query.filter(models.Product.store_id == store_id)
        upload_jobs_query = upload_jobs_query.filter(models.UploadJob.store_id == store_id)

    today_orders = today_orders_query.count()
    pending_fbs_orders = pending_fbs_orders_query.count()
    stores = stores_query.all()
    total_products = products_query.count()
    low_stock_alerts = products_query.filter(
        models.Product.archived.is_(False),
        models.Product.stock <= 10,
    ).count()
    active_stores = len(stores)
    upload_jobs = upload_jobs_query.all()
    submitted_jobs = len(upload_jobs)
    completed_jobs = sum(1 for job in upload_jobs if job.status in COMPLETED_UPLOAD_STATUSES)
    failed_jobs = sum(1 for job in upload_jobs if job.status in FAILED_UPLOAD_STATUSES)
    successful_uploaded_skus = sum(
        _count_successful_upload_skus(_load_json(job.result_payload)) for job in upload_jobs
    )

    return {
        "today_orders": today_orders,
        "pending_fbs_orders": pending_fbs_orders,
        "total_products": total_products,
        "low_stock_alerts": low_stock_alerts,
        "active_stores": active_stores,
        "submitted_jobs": submitted_jobs,
        "completed_jobs": completed_jobs,
        "failed_jobs": failed_jobs,
        "successful_uploaded_skus": successful_uploaded_skus,
    }


@app.get(f"{settings.API_V1_STR}/dashboard/trends")
def get_dashboard_trends(
    request: Request,
    days: int = Query(default=7, ge=1, le=365),
    store_id: Optional[int] = Query(default=None),
    db: Session = Depends(get_db),
) -> Dict[str, Any]:
    username = _current_username(request)
    now = datetime.now(timezone.utc)
    labels: List[str] = []
    uploads: List[int] = []
    completed: List[int] = []
    successful_uploaded_skus: List[int] = []
    orders: List[int] = []
    revenue: List[float] = []
    sales_units: List[int] = []

    jobs_query = db.query(models.UploadJob)
    order_rows_query = db.query(models.OrderRecord)
    jobs_query = _scope_query_to_user_stores(jobs_query, models.UploadJob.store_id, db, username)
    order_rows_query = _scope_query_to_user_stores(
        order_rows_query, models.OrderRecord.store_id, db, username
    )
    if store_id is not None:
        _resolve_store(db, store_id, username=username)
        jobs_query = jobs_query.filter(models.UploadJob.store_id == store_id)
        order_rows_query = order_rows_query.filter(models.OrderRecord.store_id == store_id)

    jobs = jobs_query.all()
    parsed_job_results = {
        job.id: _load_json(job.result_payload) for job in jobs
    }
    order_rows = order_rows_query.all()
    for offset in range(days - 1, -1, -1):
        day_start = datetime(
            now.year, now.month, now.day, tzinfo=timezone.utc
        ) - timedelta(days=offset)
        day_end = day_start + timedelta(days=1)
        labels.append(day_start.strftime("%m-%d"))
        uploads.append(
            sum(
                1
                for job in jobs
                if _as_utc(job.created_at) and day_start <= _as_utc(job.created_at) < day_end
            )
        )
        completed.append(
            sum(
                1
                for job in jobs
                if _as_utc(job.created_at)
                and day_start <= _as_utc(job.created_at) < day_end
                and job.status in COMPLETED_UPLOAD_STATUSES
            )
        )
        successful_uploaded_skus.append(
            sum(
                _count_successful_upload_skus(parsed_job_results.get(job.id))
                for job in jobs
                if _as_utc(job.created_at) and day_start <= _as_utc(job.created_at) < day_end
            )
        )
        day_orders = [
            row
            for row in order_rows
            if _as_utc(row.created_at) and day_start <= _as_utc(row.created_at) < day_end
        ]
        orders.append(len(day_orders))
        revenue.append(round(sum(order.amount or 0.0 for order in day_orders), 2))
        sales_units.append(sum(int(order.total_pieces or 0) for order in day_orders))

    return {
        "labels": labels,
        "uploads": uploads,
        "completed": completed,
        "successful_uploaded_skus": successful_uploaded_skus,
        "orders": orders,
        "revenue": revenue,
        "sales_units": sales_units,
    }


@app.get(f"{settings.API_V1_STR}/stores", response_model=List[schemas.StoreResponse])
async def get_stores(
    request: Request,
    refresh_status: bool = Query(default=False),
    db: Session = Depends(get_db),
) -> List[models.Store]:
    username = _current_username(request)
    stores = _user_store_query(db, username).all()
    if not refresh_status or not stores:
        return stores

    verify_results = await asyncio.gather(
        *[
            verify_ozon_credentials(store.client_id, store.api_key)
            for store in stores
        ]
    )

    for store, result in zip(stores, verify_results):
        is_valid, message, daily_limit, can_update, total_limit = result
        store.key_status = "active" if is_valid else "invalid"
        store.info = message
        store.can_create = daily_limit if is_valid else "-"
        store.can_update = can_update if is_valid else "0 / 5000"
        store.daily_limit = daily_limit if is_valid else "-"
        store.total_limit = total_limit if is_valid else "0 / 8000"

    db.commit()
    for store in stores:
        db.refresh(store)
    return stores


@app.post(f"{settings.API_V1_STR}/stores", response_model=schemas.StoreResponse)
async def create_store(
    store: schemas.StoreCreate, request: Request, db: Session = Depends(get_db)
) -> models.Store:
    username = _current_username(request)
    user = _find_user_by_username(db, username)
    tenant_id = _current_tenant_id(request) or (user.primary_tenant_id if user else None)
    existing_query = db.query(models.Store).filter(models.Store.store_name == store.store_name)
    if tenant_id is not None:
        existing_query = existing_query.filter(models.Store.tenant_id == tenant_id)
    else:
        existing_query = existing_query.filter(models.Store.user_owner == username)
    existing = existing_query.first()
    if existing:
        raise HTTPException(status_code=400, detail="Store name already registered")

    quota = None
    if tenant_id is not None:
        quota = (
            db.query(models.StoreQuota)
            .filter(models.StoreQuota.tenant_id == tenant_id)
            .first()
        )
    if quota and quota.max_stores is not None:
        current_store_count = (
            db.query(models.Store)
            .filter(models.Store.tenant_id == tenant_id)
            .count()
        )
        if current_store_count >= quota.max_stores:
            raise HTTPException(status_code=403, detail="Store quota exceeded")

    is_valid, message, daily_limit, can_update, total_limit = (
        await verify_ozon_credentials(store.client_id, store.api_key)
    )

    new_store = models.Store(
        **store.dict(),
        tenant_id=tenant_id,
        user_owner=username,
        key_status="active" if is_valid else "invalid",
        info=message,
        can_create=daily_limit if is_valid else "-",
        can_update=can_update if is_valid else "0 / 5000",
        daily_limit=daily_limit if is_valid else "-",
        total_limit=total_limit if is_valid else "0 / 8000",
    )
    db.add(new_store)
    db.flush()
    _write_audit_log(
        db,
        request,
        "store.create",
        "store",
        str(new_store.id),
        {"store_name": new_store.store_name},
    )
    db.commit()
    db.refresh(new_store)
    return new_store


@app.patch(f"{settings.API_V1_STR}/stores/{{store_id}}", response_model=schemas.StoreResponse)
def update_store(
    store_id: int,
    payload: schemas.StorePatchRequest,
    request: Request,
    db: Session = Depends(get_db),
) -> models.Store:
    username = _current_username(request)
    db_store = _resolve_store(db, store_id, username=username)
    if not db_store:
        raise HTTPException(status_code=404, detail="Store not found")

    if payload.store_name and payload.store_name != db_store.store_name:
        existing_query = db.query(models.Store).filter(
            models.Store.store_name == payload.store_name,
            models.Store.id != store_id,
        )
        if db_store.tenant_id is not None:
            existing_query = existing_query.filter(models.Store.tenant_id == db_store.tenant_id)
        else:
            existing_query = existing_query.filter(models.Store.user_owner == username)
        existing = existing_query.first()
        if existing:
            raise HTTPException(status_code=400, detail="Store name already registered")

    for key, value in payload.dict(exclude_unset=True).items():
        setattr(db_store, key, value)
    _write_audit_log(
        db,
        request,
        "store.update",
        "store",
        str(db_store.id),
        {"fields": list(payload.dict(exclude_unset=True).keys())},
    )
    db.commit()
    db.refresh(db_store)
    return db_store


@app.post(
    f"{settings.API_V1_STR}/stores/{{store_id}}/sync-browser-warehouses",
    response_model=schemas.StoreWarehouseSyncResponse,
)
def sync_store_browser_warehouses(
    store_id: int,
    request: Request,
    db: Session = Depends(get_db),
) -> Dict[str, Any]:
    username = _current_username(request)
    db_store = _resolve_store(db, store_id, username=username)
    if not db_store:
        raise HTTPException(status_code=404, detail="Store not found")

    seller_payload = _fetch_seller_warehouses_from_browser()
    names: List[str] = []
    seen_names = set()
    for warehouse in seller_payload["warehouses"]:
        name = str(warehouse.get("name") or "").strip()
        if not name or name in seen_names:
            continue
        seen_names.add(name)
        names.append(name)

    db_store.warehouse_info = "\n".join(names)
    db_store.cookie_status = "active"
    db.commit()

    return {
        "message": f"已从浏览器同步 {len(names)} 个 Ozon 仓库",
        "store_id": db_store.id,
        "company_id": seller_payload["company_id"],
        "seller_url": seller_payload["seller_url"],
        "warehouses": seller_payload["warehouses"],
    }


@app.delete(f"{settings.API_V1_STR}/stores/{{store_id}}")
def delete_store(
    store_id: int, request: Request, db: Session = Depends(get_db)
) -> Dict[str, str]:
    username = _current_username(request)
    db_store = _resolve_store(db, store_id, username=username)
    if not db_store:
        raise HTTPException(status_code=404, detail="Store not found")

    _write_audit_log(
        db,
        request,
        "store.delete",
        "store",
        str(db_store.id),
        {"store_name": db_store.store_name},
    )
    db.delete(db_store)
    db.commit()
    return {"message": "Store deleted successfully"}


@app.post(f"{settings.API_V1_STR}/stores/{{store_id}}/verify")
async def verify_store(
    store_id: int, request: Request, db: Session = Depends(get_db)
) -> schemas.StoreResponse:
    username = _current_username(request)
    db_store = _resolve_store(db, store_id, username=username)
    if not db_store:
        raise HTTPException(status_code=404, detail="Store not found")

    is_valid, message, daily_limit, can_update, total_limit = (
        await verify_ozon_credentials(db_store.client_id, db_store.api_key)
    )
    db_store.key_status = "active" if is_valid else "invalid"
    db_store.info = message
    db_store.can_create = daily_limit if is_valid else "-"
    db_store.can_update = can_update if is_valid else "0 / 5000"
    db_store.daily_limit = daily_limit if is_valid else "-"
    db_store.total_limit = total_limit if is_valid else "0 / 8000"
    db.commit()
    db.refresh(db_store)
    return db_store


@app.get(
    f"{settings.API_V1_STR}/cloud-follow/config",
    response_model=schemas.CloudFollowConfigResponse,
)
def get_cloud_follow_config(
    request: Request,
    db: Session = Depends(get_db),
) -> Dict[str, Any]:
    username = _current_username(request)
    tenant_id = _current_tenant_id(request)
    config = _get_cloud_follow_config(db, username=username, tenant_id=tenant_id)
    return _serialize_cloud_follow_config(config)


@app.put(
    f"{settings.API_V1_STR}/cloud-follow/config",
    response_model=schemas.CloudFollowConfigResponse,
)
def update_cloud_follow_config(
    payload: schemas.CloudFollowConfigRequest,
    request: Request,
    db: Session = Depends(get_db),
) -> Dict[str, Any]:
    username = _current_username(request)
    tenant_id = _current_tenant_id(request)
    user_id = _current_user_id(request)
    config = _get_cloud_follow_config(db, username=username, tenant_id=tenant_id)
    if not config:
        config = models.UserCloudFollowConfig(
            tenant_id=tenant_id,
            user_id=user_id,
            username=username,
        )
        db.add(config)
    config.user_id = user_id
    config.front_cookie = str(payload.front_cookie or "").strip() or None
    config.user_agent = str(payload.user_agent or "").strip() or None
    db.commit()
    db.refresh(config)
    return _serialize_cloud_follow_config(config)


@app.post(
    f"{settings.API_V1_STR}/cloud-follow/collect-tasks",
    response_model=schemas.CloudFollowCollectTaskCreateResponse,
)
def create_cloud_follow_collect_tasks(
    payload: schemas.CloudFollowCollectTaskCreateRequest,
    request: Request,
    db: Session = Depends(get_db),
) -> Dict[str, Any]:
    username = _current_username(request)
    store = _resolve_store(db, payload.store_id, username=username)
    tenant_id = _request_tenant_id_or_user_primary(db, request, username) or store.tenant_id
    if not payload.tasks:
        raise HTTPException(status_code=400, detail="tasks cannot be empty")
    if len(payload.tasks) > 100:
        raise HTTPException(status_code=400, detail="tasks cannot exceed 100 per request")

    result: List[models.CloudFollowCollectTask] = []
    for task_item in payload.tasks:
        reference = str(task_item.reference or "").strip()
        if not reference:
            raise HTTPException(status_code=400, detail="task reference is required")
        resolved_product_id, source_url = _resolve_ozon_product_reference(reference)
        task = models.CloudFollowCollectTask(
            tenant_id=tenant_id,
            user_owner=username,
            store_id=store.id,
            reference=reference,
            resolved_product_id=str(resolved_product_id),
            status="pending_collect",
            include_variants=bool(payload.include_variants),
            max_variants=max(1, min(100, int(payload.max_variants or 20))),
            price=_normalize_cloud_follow_text(task_item.price),
            old_price=_normalize_cloud_follow_text(task_item.old_price),
            follow_min_price=_normalize_cloud_follow_text(task_item.follow_min_price),
            model=_normalize_cloud_follow_text(task_item.model),
            source_url=source_url,
        )
        db.add(task)
        result.append(task)

    db.commit()
    for task in result:
        db.refresh(task)
    return {"ok": True, "result": [_serialize_cloud_follow_collect_task(task) for task in result]}


@app.get(
    f"{settings.API_V1_STR}/cloud-follow/collect-tasks",
    response_model=schemas.CloudFollowCollectTaskCreateResponse,
)
def list_cloud_follow_collect_tasks(
    request: Request,
    db: Session = Depends(get_db),
    status_filter: Optional[str] = Query(default=None, alias="status"),
    store_id: Optional[int] = Query(default=None),
    limit: int = Query(default=50, ge=1, le=200),
) -> Dict[str, Any]:
    username = _current_username(request)
    query = _cloud_follow_collect_task_scope(
        db,
        username=username,
        tenant_id=_request_tenant_id_or_user_primary(db, request, username),
    )
    if status_filter:
        query = query.filter(models.CloudFollowCollectTask.status == status_filter)
    if store_id:
        query = query.filter(models.CloudFollowCollectTask.store_id == int(store_id))
    rows = query.order_by(models.CloudFollowCollectTask.id.desc()).limit(limit).all()
    return {"ok": True, "result": [_serialize_cloud_follow_collect_task(task) for task in rows]}


@app.post(
    f"{settings.API_V1_STR}/extension/cloud-follow/tasks/claim",
    response_model=schemas.ExtensionCloudFollowClaimResponse,
)
def claim_extension_cloud_follow_tasks(
    payload: schemas.ExtensionCloudFollowClaimRequest,
    request: Request,
    db: Session = Depends(get_db),
) -> Dict[str, Any]:
    username = _current_username(request)
    tenant_id = _request_tenant_id_or_user_primary(db, request, username)
    _reset_stale_cloud_follow_collect_tasks(db, username=username, tenant_id=tenant_id)
    limit = max(1, min(5, int(payload.limit or 1)))
    tasks = (
        _cloud_follow_collect_task_scope(db, username=username, tenant_id=tenant_id)
        .filter(models.CloudFollowCollectTask.status == "pending_collect")
        .order_by(models.CloudFollowCollectTask.id.asc())
        .limit(limit)
        .all()
    )
    if not tasks:
        return {"ok": True, "result": []}

    now_value = datetime.now(timezone.utc)
    for task in tasks:
        task.status = "collecting"
        task.claimed_at = now_value
        task.error = None
    db.commit()
    for task in tasks:
        db.refresh(task)
    return {"ok": True, "result": [_serialize_cloud_follow_collect_task(task) for task in tasks]}


@app.post(
    f"{settings.API_V1_STR}/extension/cloud-follow/tasks/{{task_id}}/result",
    response_model=schemas.CloudFollowCollectTaskResponse,
)
async def submit_extension_cloud_follow_task_result(
    task_id: int,
    payload: schemas.ExtensionCloudFollowResultRequest,
    request: Request,
    db: Session = Depends(get_db),
) -> Dict[str, Any]:
    username = _current_username(request)
    tenant_id = _request_tenant_id_or_user_primary(db, request, username)
    task = (
        _cloud_follow_collect_task_scope(db, username=username, tenant_id=tenant_id)
        .filter(models.CloudFollowCollectTask.id == int(task_id))
        .first()
    )
    if not task:
        raise HTTPException(status_code=404, detail="Collect task not found")
    store = _resolve_store(db, task.store_id, username=username)

    if not payload.ok:
        task.status = "collect_failed"
        task.error = str(payload.error or "extension_collect_failed")[:2000]
        task.completed_at = datetime.now(timezone.utc)
        db.commit()
        db.refresh(task)
        return _serialize_cloud_follow_collect_task(task)

    product_payloads: List[Dict[str, Any]] = []
    if isinstance(payload.product_data_list, list):
        product_payloads.extend([item for item in payload.product_data_list if isinstance(item, dict)])
    elif isinstance(payload.product_data, dict):
        product_payloads.append(payload.product_data)

    if not product_payloads:
        task.status = "collect_failed"
        task.error = "No product data was returned by extension"
        task.completed_at = datetime.now(timezone.utc)
        db.commit()
        db.refresh(task)
        return _serialize_cloud_follow_collect_task(task)

    try:
        job = await _submit_cloud_follow_collect_task_payloads(
            db=db,
            store=store,
            task=task,
            product_payloads=product_payloads,
        )
        task.product_payload = json.dumps(product_payloads, ensure_ascii=False)
        task.result_payload = json.dumps(
            {
                "upload_job_id": job.id,
                "upload_status": job.status,
                "ozon_task_id": job.ozon_task_id,
                "item_count": job.item_count,
            },
            ensure_ascii=False,
        )
        task.upload_job_id = job.id
        task.status = "submitted" if job.status not in {"submit_failed", "failed"} else "upload_failed"
        task.error = job.error
    except HTTPException as exc:
        task.status = "build_failed" if exc.status_code < 500 else "upload_failed"
        task.error = str(exc.detail or "cloud_follow_task_failed")[:2000]
    except Exception as exc:
        task.status = "upload_failed"
        task.error = str(exc)[:2000]

    task.completed_at = datetime.now(timezone.utc)
    db.commit()
    db.refresh(task)
    return _serialize_cloud_follow_collect_task(task)


@app.post(
    f"{settings.API_V1_STR}/cloud-follow/preview",
    response_model=schemas.CloudFollowPreviewResponse,
)
async def cloud_follow_preview(
    payload: schemas.CloudFollowPreviewRequest,
    request: Request,
    db: Session = Depends(get_db),
) -> Dict[str, Any]:
    username = _current_username(request)
    front_cookie, user_agent = _resolve_cloud_follow_session_config(
        db,
        username=username,
        tenant_id=_current_tenant_id(request),
        front_cookie=payload.front_cookie,
        user_agent=payload.user_agent,
    )
    prepared = await _prepare_cloud_follow_product_data(
        reference=payload.reference,
        front_cookie=front_cookie,
        user_agent=user_agent,
        use_browser_session=payload.use_browser_session,
        preferred_url_fragment=payload.preferred_url_fragment,
    )
    product_data = prepared["product_data"]
    description_obj = product_data.get("description") or {}
    description_text = str(description_obj.get("text") or "").strip()
    description_html = str(description_obj.get("html") or "").strip()
    description_images = description_obj.get("images") or []
    pricing_obj = product_data.get("pricing") or {}
    variants = product_data.get("variants") or []
    characteristics = product_data.get("characteristics") or []
    has_description = bool(
        description_text
        or description_html
        or (isinstance(description_images, list) and len(description_images) > 0)
    )

    return {
        "ok": True,
        "reference": prepared["reference"],
        "resolved_product_id": prepared["resolved_product_id"],
        "source_url": prepared["source_url"],
        "fetch_source": prepared.get("fetch_source"),
        "page_url": prepared.get("page_url"),
        "title": str(product_data.get("title") or ""),
        "variant_count": len(variants),
        "characteristics_count": len(characteristics),
        "has_description": has_description,
        "has_price": bool(pricing_obj.get("uploadPrice")),
        "product_data": product_data,
    }


@app.post(
    f"{settings.API_V1_STR}/cloud-follow/submit",
    response_model=schemas.CloudFollowSubmitResponse,
)
async def cloud_follow_submit(
    payload: schemas.CloudFollowSubmitRequest,
    request: Request,
    db: Session = Depends(get_db),
) -> Dict[str, Any]:
    username = _current_username(request)
    tenant_id = _current_tenant_id(request)
    front_cookie, user_agent = _resolve_cloud_follow_session_config(
        db,
        username=username,
        tenant_id=tenant_id,
        front_cookie=payload.front_cookie,
        user_agent=payload.user_agent,
    )
    store = _resolve_store(db, payload.store_id, username=username)
    return await _run_cloud_follow_submit_workflow(
        db=db,
        store=store,
        reference=payload.reference,
        include_variants=payload.include_variants,
        max_variants=payload.max_variants,
        price=payload.price,
        old_price=payload.old_price,
        follow_min_price=payload.follow_min_price,
        model=payload.model,
        use_browser_session=payload.use_browser_session,
        preferred_url_fragment=payload.preferred_url_fragment,
        front_cookie=front_cookie,
        user_agent=user_agent,
    )


@app.post(
    f"{settings.API_V1_STR}/cloud-follow/submit-async",
    response_model=schemas.AsyncTaskSubmitResponse,
)
def cloud_follow_submit_async(
    payload: schemas.CloudFollowSubmitRequest,
    request: Request,
    db: Session = Depends(get_db),
) -> Dict[str, Any]:
    username = _current_username(request)
    tenant_id = _current_tenant_id(request)
    front_cookie, user_agent = _resolve_cloud_follow_session_config(
        db,
        username=username,
        tenant_id=tenant_id,
        front_cookie=payload.front_cookie,
        user_agent=payload.user_agent,
    )
    store = _resolve_store(db, payload.store_id, username=username)
    return _submit_async_task(
        "ozon.cloud_follow_submit",
        queue="browser",
        store_id=store.id,
        user_owner=username,
        tenant_id=tenant_id,
        reference=payload.reference,
        include_variants=payload.include_variants,
        max_variants=payload.max_variants,
        price=payload.price,
        old_price=payload.old_price,
        follow_min_price=payload.follow_min_price,
        model=payload.model,
        use_browser_session=payload.use_browser_session,
        preferred_url_fragment=payload.preferred_url_fragment,
        front_cookie=front_cookie,
        user_agent=user_agent,
    )


@app.post(
    f"{settings.API_V1_STR}/upload/jobs",
    response_model=schemas.UploadJobResponse,
)
async def create_upload_job(
    payload: schemas.UploadJobCreate, request: Request, db: Session = Depends(get_db)
) -> Dict[str, Any]:
    username = _current_username(request)
    store = _resolve_store(
        db, payload.store_id, payload.store_name, username=username
    )
    _validate_upload_items(payload.items)
    job = await _submit_upload_job(
        db=db,
        store=store,
        items=payload.items,
        source=payload.source,
        local_task_id=payload.local_task_id,
        requested_store_id=payload.store_id,
        requested_store_name=payload.store_name,
    )
    return _serialize_upload_job(job, store.store_name, _upload_job_items_for_job(db, job.id))


@app.post(
    f"{settings.API_V1_STR}/extension/one-click-upload",
    response_model=schemas.ExtensionUploadResponse,
)
async def extension_one_click_upload(
    payload: schemas.ExtensionUploadRequest,
    request: Request,
    db: Session = Depends(get_db),
) -> Dict[str, Any]:
    username = _current_username(request)
    store = _resolve_store(db, payload.store_id, username=username)

    if isinstance(payload.scrapedJson, str):
        try:
            scraped_data = json.loads(payload.scrapedJson)
        except json.JSONDecodeError as exc:
            raise HTTPException(status_code=400, detail="Invalid scrapedJson payload") from exc
    elif isinstance(payload.scrapedJson, dict):
        scraped_data = payload.scrapedJson
    else:
        raise HTTPException(status_code=400, detail="scrapedJson must be an object or JSON string")

    try:
        prepared = await build_upload_item(
            client_id=store.client_id,
            api_key=store.api_key,
            scraped_data=scraped_data,
            price=payload.price,
            old_price=payload.old_price,
            min_price=payload.follow_min_price,
            model=payload.model,
        )
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except Exception as exc:
        raise HTTPException(status_code=502, detail=f"Extension upload preparation failed: {exc}") from exc

    item = prepared["item"]
    source_product_id = str(scraped_data.get("productId") or "")
    existing_job = _find_recent_extension_upload_job(
        db,
        store_id=store.id,
        offer_id=str(item.get("offer_id") or ""),
        source_product_id=source_product_id,
    )
    if existing_job is not None:
        return {
            "ok": True,
            "product_id": str(existing_job.id),
            "job_id": str(existing_job.id),
            "title": str(scraped_data.get("title") or "") or item.get("name"),
            "status": _extension_public_status(existing_job),
            "price": item.get("price"),
            "store_id": store.id,
        }

    local_task_id = f"ext-{secrets.token_hex(8)}"
    extension_meta = {
        "title": str(scraped_data.get("title") or ""),
        "source_product_id": source_product_id,
        "source_url": scraped_data.get("sourceUrl"),
        "category_info": prepared.get("category_info"),
        "price": item.get("price"),
    }
    job = await _submit_upload_job(
        db=db,
        store=store,
        items=[item],
        source="extension_one_click",
        local_task_id=local_task_id,
        requested_store_id=payload.store_id,
        extension_meta=extension_meta,
    )
    if job.status in {"submit_failed", "failed"}:
        raise HTTPException(
            status_code=502,
            detail=job.error or "Extension upload submission failed",
        )

    return {
        "ok": True,
        "product_id": str(job.id),
        "job_id": str(job.id),
        "title": extension_meta["title"] or item.get("name"),
        "status": _extension_public_status(job),
        "price": item.get("price"),
        "store_id": store.id,
    }


@app.get(
    f"{settings.API_V1_STR}/upload/jobs",
    response_model=schemas.UploadJobListResponse,
)
def list_upload_jobs(
    request: Request,
    store_id: Optional[int] = Query(default=None),
    limit: int = Query(default=20, ge=1, le=100),
    db: Session = Depends(get_db),
) -> Dict[str, List[Dict[str, Any]]]:
    username = _current_username(request)
    query = db.query(models.UploadJob).order_by(models.UploadJob.id.desc())
    query = _scope_query_to_user_stores(query, models.UploadJob.store_id, db, username)
    if store_id is not None:
        _resolve_store(db, store_id, username=username)
        query = query.filter(models.UploadJob.store_id == store_id)

    jobs = _dedupe_upload_jobs_for_list(query.limit(min(limit * 3, 300)).all(), limit)
    store_names = _store_name_map(db, [job.store_id for job in jobs], username=username)
    items_by_job = _upload_job_items_by_job_ids(db, [job.id for job in jobs])
    return {
        "result": [
            _serialize_upload_job(
                job,
                store_names.get(job.store_id),
                items_by_job.get(job.id, []),
            )
            for job in jobs
        ]
    }


@app.get(
    f"{settings.API_V1_STR}/upload/jobs/{{job_id}}",
    response_model=schemas.UploadJobResponse,
)
def get_upload_job(
    job_id: int, request: Request, db: Session = Depends(get_db)
) -> Dict[str, Any]:
    username = _current_username(request)
    job = (
        _scope_query_to_user_stores(
            db.query(models.UploadJob), models.UploadJob.store_id, db, username
        )
        .filter(models.UploadJob.id == job_id)
        .first()
    )
    if not job:
        raise HTTPException(status_code=404, detail="Upload job not found")

    store = _resolve_store(db, job.store_id, username=username)
    return _serialize_upload_job(
        job,
        store.store_name if store else None,
        _upload_job_items_for_job(db, job.id),
    )


@app.get(
    f"{settings.API_V1_STR}/extension/products/{{product_id}}/status",
    response_model=schemas.ExtensionProductStatusResponse,
)
async def get_extension_product_status(
    product_id: str,
    request: Request,
    job_id: Optional[str] = Query(default=None),
    db: Session = Depends(get_db),
) -> Dict[str, Any]:
    username = _current_username(request)
    resolved_job_id_raw = (job_id or product_id or "").strip()
    if not resolved_job_id_raw.isdigit():
        raise HTTPException(status_code=404, detail="Upload job not found")

    resolved_job_id = int(resolved_job_id_raw)
    job = (
        _scope_query_to_user_stores(
            db.query(models.UploadJob), models.UploadJob.store_id, db, username
        )
        .filter(models.UploadJob.id == resolved_job_id)
        .first()
    )
    if not job:
        raise HTTPException(status_code=404, detail="Upload job not found")

    store = _resolve_store(db, job.store_id, username=username)
    return _build_extension_status_payload(job, store_name=store.store_name if store else None)


@app.post(
    f"{settings.API_V1_STR}/upload/jobs/{{job_id}}/refresh",
    response_model=schemas.UploadJobResponse,
)
async def refresh_upload_job(
    job_id: int, request: Request, db: Session = Depends(get_db)
) -> Dict[str, Any]:
    username = _current_username(request)
    job = (
        _scope_query_to_user_stores(
            db.query(models.UploadJob), models.UploadJob.store_id, db, username
        )
        .filter(models.UploadJob.id == job_id)
        .first()
    )
    if not job:
        raise HTTPException(status_code=404, detail="Upload job not found")
    if not job.ozon_task_id:
        raise HTTPException(
            status_code=400,
            detail="Upload job has no Ozon task id to refresh",
        )

    now = datetime.now(timezone.utc)
    next_refresh_at = _as_utc(job.next_refresh_at)
    if next_refresh_at is None or next_refresh_at <= now or job.cancel_requested:
        queue_result = _submit_async_task("ozon.refresh_upload_job", queue="upload", job_id=job.id)
        queue_payload = _load_json(job.result_payload) or {}
        queue_payload["refresh_queue"] = queue_result
        job.result_payload = json.dumps(queue_payload, ensure_ascii=False)
        job.next_refresh_at = now + timedelta(seconds=UPLOAD_RESULT_POLL_INTERVAL_SECONDS)
        db.commit()
        db.refresh(job)
    store = _resolve_store(db, job.store_id, username=username)
    return _serialize_upload_job(
        job,
        store.store_name,
        _upload_job_items_for_job(db, job.id),
    )


@app.post(
    f"{settings.API_V1_STR}/upload/jobs/{{job_id}}/cancel",
    response_model=schemas.UploadJobResponse,
)
def cancel_upload_job(
    job_id: int,
    request: Request,
    db: Session = Depends(get_db),
) -> Dict[str, Any]:
    username = _current_username(request)
    job = (
        _scope_query_to_user_stores(
            db.query(models.UploadJob), models.UploadJob.store_id, db, username
        )
        .filter(models.UploadJob.id == job_id)
        .first()
    )
    if not job:
        raise HTTPException(status_code=404, detail="Upload job not found")

    now = datetime.now(timezone.utc)
    job.cancel_requested = True
    if job.status not in {"uploading", "submitted", "processing"}:
        job.status = "canceled"
        job.canceled_at = now
        job.finished_at = now
        job.locked_at = None
        _set_upload_job_items_status(db, job, "canceled", "cancel_requested")
    if job.celery_task_id and CELERY_AVAILABLE and celery_app is not None:
        try:
            celery_app.control.revoke(job.celery_task_id, terminate=False)
        except Exception:
            pass
    db.commit()
    db.refresh(job)
    store = _resolve_store(db, job.store_id, username=username)
    return _serialize_upload_job(job, store.store_name, _upload_job_items_for_job(db, job.id))


@app.post(
    f"{settings.API_V1_STR}/upload/jobs/{{job_id}}/resume",
    response_model=schemas.UploadJobResponse,
)
def resume_upload_job(
    job_id: int,
    request: Request,
    db: Session = Depends(get_db),
) -> Dict[str, Any]:
    username = _current_username(request)
    job = (
        _scope_query_to_user_stores(
            db.query(models.UploadJob), models.UploadJob.store_id, db, username
        )
        .filter(models.UploadJob.id == job_id)
        .first()
    )
    if not job:
        raise HTTPException(status_code=404, detail="Upload job not found")
    _prepare_upload_job_resume(db, job)
    db.commit()
    db.refresh(job)
    queue_result = _submit_async_task("ozon.dispatch_upload_jobs", queue="upload")
    _record_upload_resume_queue_result(job, queue_result)
    db.commit()
    db.refresh(job)
    store = _resolve_store(db, job.store_id, username=username)
    return _serialize_upload_job(job, store.store_name, _upload_job_items_for_job(db, job.id))


@app.get(
    f"{settings.API_V1_STR}/products/filters",
    response_model=schemas.ProductFilterResponse,
)
def get_product_filters(
    request: Request,
    store_id: Optional[int] = Query(default=None),
    db: Session = Depends(get_db),
) -> Dict[str, Any]:
    username = _current_username(request)
    query = db.query(models.Product)
    query = _scope_query_to_user_stores(query, models.Product.store_id, db, username)
    if store_id is not None:
        _resolve_store(db, store_id, username=username)
        query = query.filter(models.Product.store_id == store_id)

    products = query.all()
    category_rows = sorted(
        {
            (
                product.category_level_1 or "",
                product.category_level_2 or "",
                product.category_level_3 or "",
            )
            for product in products
            if product.category_level_1 or product.category_level_2 or product.category_level_3
        }
    )
    sources = sorted({product.source for product in products if product.source})
    statuses = sorted(
        {
            "archived" if product.archived else product.status
            for product in products
            if product.archived or product.status
        }
    )
    return {
        "categories": [
            {
                "level_1": level_1 or None,
                "level_2": level_2 or None,
                "level_3": level_3 or None,
            }
            for level_1, level_2, level_3 in category_rows
        ],
        "sources": sources,
        "statuses": statuses,
    }


@app.get(
    f"{settings.API_V1_STR}/products",
    response_model=schemas.ProductListResponse,
)
def list_products(
    request: Request,
    product_name: str = Query(default=""),
    sku: str = Query(default=""),
    article_no: str = Query(default=""),
    source: str = Query(default=""),
    cat1: str = Query(default=""),
    cat2: str = Query(default=""),
    cat3: str = Query(default=""),
    weight_min: Optional[float] = Query(default=None),
    weight_max: Optional[float] = Query(default=None),
    stock_min: Optional[int] = Query(default=None),
    stock_max: Optional[int] = Query(default=None),
    price_min: Optional[float] = Query(default=None),
    price_max: Optional[float] = Query(default=None),
    store_id: Optional[int] = Query(default=None),
    warehouse_name: str = Query(default=""),
    status: str = Query(default="all"),
    page: int = Query(default=1, ge=1),
    page_size: int = Query(default=15, ge=1, le=100),
    db: Session = Depends(get_db),
) -> Dict[str, Any]:
    username = _current_username(request)
    query = db.query(models.Product)
    query = _scope_query_to_user_stores(query, models.Product.store_id, db, username)
    if product_name:
        query = query.filter(models.Product.product_name.ilike(f"%{product_name}%"))
    if sku:
        query = query.filter(models.Product.sku.ilike(f"%{sku}%"))
    if article_no:
        query = query.filter(models.Product.article_no.ilike(f"%{article_no}%"))
    if source:
        query = query.filter(models.Product.source == source)
    if cat1:
        query = query.filter(models.Product.category_level_1 == cat1)
    if cat2:
        query = query.filter(models.Product.category_level_2 == cat2)
    if cat3:
        query = query.filter(models.Product.category_level_3 == cat3)
    if weight_min is not None:
        query = query.filter(models.Product.weight_g >= weight_min)
    if weight_max is not None:
        query = query.filter(models.Product.weight_g <= weight_max)
    if stock_min is not None:
        query = query.filter(models.Product.stock >= stock_min)
    if stock_max is not None:
        query = query.filter(models.Product.stock <= stock_max)
    if price_min is not None:
        query = query.filter(models.Product.price >= price_min)
    if price_max is not None:
        query = query.filter(models.Product.price <= price_max)
    if store_id is not None:
        _resolve_store(db, store_id, username=username)
        query = query.filter(models.Product.store_id == store_id)
    if warehouse_name:
        query = query.filter(models.Product.warehouse_name == warehouse_name.strip())
    if status == "archived":
        query = query.filter(models.Product.archived.is_(True))
    elif status != "all":
        query = query.filter(models.Product.archived.is_(False), models.Product.status == status)

    total = query.count()
    items = (
        query.order_by(models.Product.updated_at.desc(), models.Product.id.desc())
        .offset((page - 1) * page_size)
        .limit(page_size)
        .all()
    )
    store_names = _store_name_map(db, [item.store_id for item in items], username=username)
    return {
        "result": [_serialize_product(item, store_names.get(item.store_id)) for item in items],
        "total": total,
        "page": page,
        "page_size": page_size,
    }


@app.get(
    f"{settings.API_V1_STR}/products/{{product_id}}/market-insights",
    response_model=schemas.ProductMarketInsightsResponse,
)
def get_product_market_insights(
    product_id: int,
    request: Request,
    period: str = Query(default="weekly"),
    db: Session = Depends(get_db),
) -> Dict[str, Any]:
    username = _current_username(request)
    product = (
        _scope_query_to_user_stores(db.query(models.Product), models.Product.store_id, db, username)
        .filter(models.Product.id == product_id)
        .first()
    )
    if not product:
        raise HTTPException(status_code=404, detail="Product not found")
    return _fetch_product_market_insights_from_browser(product, period=period)


@app.post(f"{settings.API_V1_STR}/sourcing/1688/compare")
async def compare_products_with_1688(
    payload: schemas.Sourcing1688CompareRequest,
) -> Dict[str, Any]:
    items = [item.model_dump() for item in payload.items]
    try:
        return await compare_1688_sources(items, max_candidates=payload.max_candidates)
    except Exception as exc:
        logger.exception("1688 sourcing compare failed")
        raise HTTPException(status_code=502, detail=f"1688 比价失败：{exc}") from exc


@app.post(
    f"{settings.API_V1_STR}/jobs/verify-stores",
    response_model=schemas.AsyncTaskSubmitResponse,
)
def submit_verify_stores_task(
    request: Request,
    payload: schemas.StoreScopedTaskRequest = Body(default=schemas.StoreScopedTaskRequest()),
    db: Session = Depends(get_db),
) -> Dict[str, Any]:
    username = _current_username(request)
    tenant_id = _current_tenant_id(request)
    if payload.store_id is not None:
        _resolve_store(db, payload.store_id, username=username)
    return _submit_async_task(
        "ozon.verify_stores",
        queue="sync",
        store_id=payload.store_id,
        user_owner=username,
        tenant_id=tenant_id,
    )


@app.post(
    f"{settings.API_V1_STR}/jobs/sync-products",
    response_model=schemas.AsyncTaskSubmitResponse,
)
def submit_sync_products_task(
    request: Request,
    payload: schemas.StoreScopedTaskRequest = Body(default=schemas.StoreScopedTaskRequest()),
    db: Session = Depends(get_db),
) -> Dict[str, Any]:
    username = _current_username(request)
    tenant_id = _current_tenant_id(request)
    if payload.store_id is not None:
        _resolve_store(db, payload.store_id, username=username)
    return _submit_async_task(
        "ozon.sync_products",
        queue="sync",
        store_id=payload.store_id,
        user_owner=username,
        tenant_id=tenant_id,
    )


@app.post(
    f"{settings.API_V1_STR}/jobs/sync-orders",
    response_model=schemas.AsyncTaskSubmitResponse,
)
def submit_sync_orders_task(
    request: Request,
    payload: schemas.OrderSyncRequest = Body(default=schemas.OrderSyncRequest()),
    db: Session = Depends(get_db),
) -> Dict[str, Any]:
    username = _current_username(request)
    tenant_id = _current_tenant_id(request)
    rate_key = f"manual_order_sync:{tenant_id or username}"
    _enforce_redis_rate_limit(
        rate_key,
        limit=int(settings.MANUAL_ORDER_SYNC_LIMIT),
        window_seconds=int(settings.MANUAL_ORDER_SYNC_WINDOW_SECONDS),
        detail="操作过于频繁：订单手动同步每个用户半小时最多 5 次。",
    )
    if payload.store_id is not None:
        _resolve_store(db, payload.store_id, username=username)
    return _submit_async_task(
        "ozon.sync_orders",
        queue="sync",
        store_id=payload.store_id,
        days=payload.days,
        user_owner=username,
        tenant_id=tenant_id,
    )


@app.post(
    f"{settings.API_V1_STR}/jobs/sync-browser-warehouses",
    response_model=schemas.AsyncTaskSubmitResponse,
)
def submit_sync_browser_warehouses_task(
    request: Request,
    payload: schemas.StoreScopedTaskRequest = Body(default=schemas.StoreScopedTaskRequest()),
    db: Session = Depends(get_db),
) -> Dict[str, Any]:
    username = _current_username(request)
    tenant_id = _current_tenant_id(request)
    if payload.store_id is None:
        raise HTTPException(status_code=400, detail="store_id is required")
    _resolve_store(db, payload.store_id, username=username)
    return _submit_async_task(
        "ozon.sync_browser_warehouses",
        queue="browser",
        store_id=payload.store_id,
        user_owner=username,
        tenant_id=tenant_id,
    )


@app.post(
    f"{settings.API_V1_STR}/jobs/sync-core",
    response_model=schemas.AsyncTaskSubmitResponse,
)
def submit_sync_core_task(
    request: Request,
    payload: schemas.SyncCoreRequest = Body(default=schemas.SyncCoreRequest()),
) -> Dict[str, Any]:
    username = _current_username(request)
    tenant_id = _current_tenant_id(request)
    return _submit_async_task(
        "ozon.sync_core",
        queue="sync",
        days=payload.days,
        user_owner=username,
        tenant_id=tenant_id,
    )


@app.post(
    f"{settings.API_V1_STR}/jobs/refresh-analytics",
    response_model=schemas.AsyncTaskSubmitResponse,
)
def submit_refresh_analytics_task(
    request: Request,
    payload: schemas.AnalyticsRefreshRequest = Body(default=schemas.AnalyticsRefreshRequest()),
    db: Session = Depends(get_db),
) -> Dict[str, Any]:
    username = _current_username(request)
    tenant_id = _current_tenant_id(request)
    if payload.store_id is not None:
        _resolve_store(db, payload.store_id, username=username)
    return _submit_async_task(
        "ozon.refresh_analytics",
        queue="sync",
        store_id=payload.store_id,
        days=payload.days,
        user_owner=username,
        tenant_id=tenant_id,
    )


@app.get(
    f"{settings.API_V1_STR}/jobs/{{task_id}}",
    response_model=schemas.TaskStatusResponse,
)
def get_job_status(task_id: str) -> Dict[str, Any]:
    return _serialize_async_result(task_id)


@app.post(
    f"{settings.API_V1_STR}/products/sync",
    response_model=schemas.ProductSyncResponse,
)
async def sync_products(
    request: Request,
    store_id: Optional[int] = Query(default=None),
    run_async: bool = Query(default=False),
    db: Session = Depends(get_db),
) -> Dict[str, Any]:
    username = _current_username(request)
    tenant_id = _current_tenant_id(request)
    if store_id is not None:
        _resolve_store(db, store_id, username=username)
    return _submit_async_task(
        "ozon.sync_products",
        queue="sync",
        store_id=store_id,
        user_owner=username,
        tenant_id=tenant_id,
    )


@app.post(f"{settings.API_V1_STR}/products/batch/price")
async def batch_update_product_price(
    payload: schemas.ProductBatchPriceRequest,
    request: Request,
    db: Session = Depends(get_db),
) -> Dict[str, Any]:
    username = _current_username(request)
    products = _selected_products_query(
        db, payload.ids, payload.store_id, username=username
    ).all()
    _ensure_selected_products(products)

    display_price = (
        payload.display_price if payload.display_price is not None else round(payload.price * 1.15, 2)
    )
    for store, store_products in _products_grouped_by_store(db, products, username).values():
        currency_code = str(store.currency or "RUB").strip().upper() or "RUB"
        price_items = [
            {
                "offer_id": product.offer_id,
                "price": _format_ozon_money(payload.price),
                "old_price": _format_ozon_money(display_price),
                "currency_code": currency_code,
            }
            for product in store_products
        ]
        for batch in _chunked(price_items):
            response = await update_product_prices(store.client_id, store.api_key, batch)
            _raise_for_ozon_response(response, "Ozon 改价")

    for product in products:
        product.price = payload.price
        product.display_price = display_price
        product.profit = round(product.price * 0.18, 2)
    db.commit()
    return {"message": f"Ozon 改价完成，共 {len(products)} 个商品"}


@app.post(f"{settings.API_V1_STR}/products/batch/stock")
async def batch_update_product_stock(
    payload: schemas.ProductBatchStockRequest,
    request: Request,
    db: Session = Depends(get_db),
) -> Dict[str, Any]:
    username = _current_username(request)
    warehouse_name = _require_selected_warehouse(payload.warehouse_name)
    products = _selected_products_query(
        db, payload.ids, payload.store_id, username=username
    ).all()
    _ensure_selected_products(products)
    _validate_product_warehouse_scope(products, warehouse_name)

    for store, store_products in _products_grouped_by_store(db, products, username).values():
        warehouse_id = await _resolve_ozon_warehouse_id(store, warehouse_name)
        stock_items = [
            {
                "offer_id": product.offer_id,
                "stock": int(payload.stock),
                "warehouse_id": warehouse_id,
            }
            for product in store_products
        ]
        for batch in _chunked(stock_items):
            response = await update_product_stocks(store.client_id, store.api_key, batch)
            _raise_for_ozon_response(response, "Ozon 库存更新")

    for product in products:
        product.stock = payload.stock
        product.warehouse_name = warehouse_name
    db.commit()
    return {"message": f"Ozon 库存更新完成，共 {len(products)} 个商品"}


@app.post(f"{settings.API_V1_STR}/products/batch/archive")
async def batch_archive_products(
    payload: schemas.ProductBatchArchiveRequest,
    request: Request,
    db: Session = Depends(get_db),
) -> Dict[str, Any]:
    username = _current_username(request)
    products = _selected_products_query(
        db, payload.ids, payload.store_id, username=username
    ).all()
    _ensure_selected_products(products)

    operation = archive_products if payload.archived else unarchive_products
    action = "Ozon 商品归档" if payload.archived else "Ozon 商品恢复"
    for store, store_products in _products_grouped_by_store(db, products, username).values():
        product_ids = await _resolve_ozon_product_ids(store, store_products)
        for batch in _chunked(product_ids):
            response = await operation(store.client_id, store.api_key, batch)
            _raise_for_ozon_response(response, action)

    for product in products:
        product.archived = payload.archived
        if payload.archived:
            product.status = "archived"
        elif product.status == "archived":
            product.status = "approved"
    db.commit()
    return {"message": f"{'归档' if payload.archived else '恢复'}完成，共 {len(products)} 个商品"}


@app.post(f"{settings.API_V1_STR}/products/batch/remark")
def batch_remark_products(
    payload: schemas.ProductBatchRemarkRequest,
    request: Request,
    db: Session = Depends(get_db),
) -> Dict[str, str]:
    username = _current_username(request)
    products = _selected_products_query(
        db, payload.ids, payload.store_id, username=username
    ).all()
    _ensure_selected_products(products)
    for product in products:
        product.remark = payload.remark
    db.commit()
    return {"message": f"备注已更新，共 {len(products)} 个商品"}


@app.post(f"{settings.API_V1_STR}/products/batch/retry")
def batch_retry_products(
    payload: schemas.ProductBatchIdsRequest,
    request: Request,
    db: Session = Depends(get_db),
) -> Dict[str, Any]:
    username = _current_username(request)
    products = _selected_products_query(
        db, payload.ids, payload.store_id, username=username
    ).all()
    _ensure_selected_products(products)

    upload_job_ids = sorted(
        {
            int(product.upload_job_id)
            for product in products
            if product.upload_job_id is not None
        }
    )
    if not upload_job_ids:
        raise HTTPException(status_code=400, detail="所选商品没有关联上传任务，无法重试")

    jobs = (
        _scope_query_to_user_stores(
            db.query(models.UploadJob), models.UploadJob.store_id, db, username
        )
        .filter(models.UploadJob.id.in_(upload_job_ids))
        .all()
    )
    jobs_by_id = {int(job.id): job for job in jobs}
    missing_job_ids = [job_id for job_id in upload_job_ids if job_id not in jobs_by_id]
    if missing_job_ids:
        raise HTTPException(status_code=404, detail=f"上传任务不存在：{missing_job_ids[:5]}")

    invalid_jobs = [
        f"{job.id}({job.status})"
        for job in jobs
        if job.status not in UPLOAD_JOB_RESUMABLE_STATUSES
    ]
    if invalid_jobs:
        raise HTTPException(
            status_code=400,
            detail=f"这些上传任务当前不能重试：{', '.join(invalid_jobs[:5])}",
        )

    for job in jobs:
        _prepare_upload_job_resume(db, job)
    for product in products:
        if product.upload_job_id in jobs_by_id:
            product.status = "queued"
    db.commit()
    queue_result = _submit_async_task("ozon.dispatch_upload_jobs", queue="upload")
    for job in jobs:
        _record_upload_resume_queue_result(job, queue_result)
    db.commit()
    return {"message": f"已重新提交 {len(jobs)} 个上传任务，涉及 {len(products)} 个商品"}


@app.get(
    f"{settings.API_V1_STR}/inventory",
    response_model=schemas.ProductListResponse,
)
def list_inventory(
    request: Request,
    sku: str = Query(default=""),
    article_no: str = Query(default=""),
    warehouse_name: str = Query(default=""),
    backup_status: str = Query(default=""),
    stock_min: Optional[int] = Query(default=None),
    stock_max: Optional[int] = Query(default=None),
    archive_status: str = Query(default="unarchived"),
    store_id: Optional[int] = Query(default=None),
    page: int = Query(default=1, ge=1),
    page_size: int = Query(default=15, ge=1, le=100),
    db: Session = Depends(get_db),
) -> Dict[str, Any]:
    username = _current_username(request)
    query = _inventory_products_query(
        db,
        sku=sku,
        article_no=article_no,
        warehouse_name=warehouse_name or None,
        backup_status=backup_status,
        stock_min=stock_min,
        stock_max=stock_max,
        archive_status=archive_status,
        store_id=store_id,
        username=username,
    )

    total = query.count()
    items = (
        query.order_by(models.Product.updated_at.desc(), models.Product.id.desc())
        .offset((page - 1) * page_size)
        .limit(page_size)
        .all()
    )
    store_names = _store_name_map(db, [item.store_id for item in items], username=username)
    return {
        "result": [_serialize_product(item, store_names.get(item.store_id)) for item in items],
        "total": total,
        "page": page,
        "page_size": page_size,
    }


@app.post(f"{settings.API_V1_STR}/inventory/batch/backup")
def batch_backup_inventory(
    payload: schemas.ProductBatchIdsRequest,
    request: Request,
    db: Session = Depends(get_db),
) -> Dict[str, str]:
    username = _current_username(request)
    products = _selected_products_query(
        db, payload.ids, payload.store_id, username=username
    ).all()
    for product in products:
        product.backup_stock = product.stock
    db.commit()
    return {"message": f"Backed up stock for {len(products)} products"}


@app.post(f"{settings.API_V1_STR}/inventory/batch/restore")
def batch_restore_inventory(
    payload: schemas.ProductBatchIdsRequest,
    request: Request,
    db: Session = Depends(get_db),
) -> Dict[str, str]:
    username = _current_username(request)
    products = _selected_products_query(
        db, payload.ids, payload.store_id, username=username
    ).all()
    for product in products:
        product.stock = product.backup_stock or product.stock
    db.commit()
    return {"message": f"Restored stock for {len(products)} products"}


@app.post(f"{settings.API_V1_STR}/inventory/batch/update-stock")
def batch_update_inventory_stock(
    payload: schemas.ProductBatchStockRequest,
    request: Request,
    db: Session = Depends(get_db),
) -> Dict[str, str]:
    username = _current_username(request)
    warehouse_name = _require_selected_warehouse(payload.warehouse_name)
    if payload.apply_to_filtered:
        products = _inventory_products_query(
            db,
            sku=payload.sku or "",
            article_no=payload.article_no or "",
            warehouse_name=warehouse_name,
            backup_status=payload.backup_status or "",
            archive_status=payload.archive_status or "",
            store_id=payload.store_id,
            username=username,
        ).all()
    else:
        products = _selected_products_query(
            db, payload.ids, payload.store_id, username=username
        ).all()
    _validate_product_warehouse_scope(products, warehouse_name)
    for product in products:
        product.stock = payload.stock
    db.commit()
    return {"message": f"Updated stock for {len(products)} inventory items"}


@app.post(f"{settings.API_V1_STR}/inventory/batch/automation")
def batch_update_inventory_automation(
    payload: schemas.InventoryAutomationRequest,
    request: Request,
    db: Session = Depends(get_db),
) -> Dict[str, str]:
    username = _current_username(request)
    products = _selected_products_query(
        db, payload.ids, payload.store_id, username=username
    ).all()
    for product in products:
        if payload.auto_restock is not None:
            product.auto_restock = payload.auto_restock
        if payload.scheduled_shelf is not None:
            product.scheduled_shelf = payload.scheduled_shelf
    db.commit()
    return {"message": f"Updated automation for {len(products)} inventory items"}


@app.post(
    f"{settings.API_V1_STR}/orders/sync",
    response_model=schemas.OrderSyncResponse,
)
async def sync_orders(
    payload: schemas.OrderSyncRequest,
    request: Request,
    run_async: bool = Query(default=False),
    db: Session = Depends(get_db),
) -> Dict[str, Any]:
    username = _current_username(request)
    tenant_id = _current_tenant_id(request)
    if payload.store_id is not None:
        _resolve_store(db, payload.store_id, username=username)
    return _submit_async_task(
        "ozon.sync_orders",
        store_id=payload.store_id,
        days=payload.days,
        user_owner=username,
        tenant_id=tenant_id,
    )


@app.get(
    f"{settings.API_V1_STR}/orders",
    response_model=schemas.OrderListResponse,
)
def list_orders(
    request: Request,
    scheme: str = Query(default="FBS"),
    status: str = Query(default="all"),
    search: str = Query(default=""),
    store_id: Optional[int] = Query(default=None),
    page: int = Query(default=1, ge=1),
    page_size: int = Query(default=15, ge=1, le=100),
    db: Session = Depends(get_db),
) -> Dict[str, Any]:
    username = _current_username(request)
    query = db.query(models.OrderRecord)
    query = _scope_query_to_user_stores(query, models.OrderRecord.store_id, db, username)
    normalized_scheme = scheme.lower()
    if normalized_scheme not in {"all", "fbs"}:
        raise HTTPException(status_code=400, detail="Only FBS orders are supported")
    query = query.filter(models.OrderRecord.scheme == "FBS")
    if status != "all":
        query = query.filter(models.OrderRecord.status == status)
    if search:
        like_value = f"%{search}%"
        query = query.filter(
            or_(
                models.OrderRecord.posting_number.ilike(like_value),
                models.OrderRecord.product_name.ilike(like_value),
            )
        )
    if store_id is not None:
        _resolve_store(db, store_id, username=username)
        query = query.filter(models.OrderRecord.store_id == store_id)

    total = query.count()
    rows = (
        query.order_by(models.OrderRecord.created_at.desc(), models.OrderRecord.id.desc())
        .offset((page - 1) * page_size)
        .limit(page_size)
        .all()
    )
    store_names = _store_name_map(db, [row.store_id for row in rows], username=username)
    return {
        "result": [_serialize_order(row, store_names.get(row.store_id)) for row in rows],
        "total": total,
        "page": page,
        "page_size": page_size,
    }


@app.post(f"{settings.API_V1_STR}/orders/{{order_id}}/mark-packaged")
def mark_order_packaged(
    order_id: int, request: Request, db: Session = Depends(get_db)
) -> Dict[str, str]:
    username = _current_username(request)
    order = (
        _scope_query_to_user_stores(
            db.query(models.OrderRecord), models.OrderRecord.store_id, db, username
        )
        .filter(models.OrderRecord.id == order_id)
        .first()
    )
    if not order:
        raise HTTPException(status_code=404, detail="Order not found")
    if order.status == "awaiting_packaging":
        order.status = "awaiting_deliver"
        order.status_label = "待发货"
        order.warehouse_status = "待出库 / Ozon Logistics"
        db.commit()
        return {"message": "Order moved to awaiting deliver"}
    return {"message": "Order status unchanged"}


@app.get(
    f"{settings.API_V1_STR}/warehouse/orders",
    response_model=schemas.OrderListResponse,
)
def list_warehouse_orders(
    request: Request,
    order_no: str = Query(default=""),
    waybill_no: str = Query(default=""),
    tracking_no: str = Query(default=""),
    sender_name: str = Query(default=""),
    store_id: Optional[int] = Query(default=None),
    status: str = Query(default="全部订单"),
    page: int = Query(default=1, ge=1),
    page_size: int = Query(default=15, ge=1, le=100),
    db: Session = Depends(get_db),
) -> Dict[str, Any]:
    username = _current_username(request)
    query = db.query(models.OrderRecord)
    query = _scope_query_to_user_stores(query, models.OrderRecord.store_id, db, username)
    if order_no:
        query = query.filter(models.OrderRecord.posting_number.ilike(f"%{order_no}%"))
    if waybill_no:
        query = query.filter(
            or_(
                models.OrderRecord.all_waybills.ilike(f"%{waybill_no}%"),
                models.OrderRecord.domestic_waybill.ilike(f"%{waybill_no}%"),
            )
        )
    if tracking_no:
        query = query.filter(models.OrderRecord.tracking_no.ilike(f"%{tracking_no}%"))
    if sender_name:
        query = query.filter(models.OrderRecord.sender_name.ilike(f"%{sender_name}%"))
    if store_id is not None:
        _resolve_store(db, store_id, username=username)
        query = query.filter(models.OrderRecord.store_id == store_id)
    if status != "全部订单":
        query = query.filter(models.OrderRecord.warehouse_status.ilike(f"%{status}%"))

    total = query.count()
    rows = (
        query.order_by(models.OrderRecord.updated_at.desc(), models.OrderRecord.id.desc())
        .offset((page - 1) * page_size)
        .limit(page_size)
        .all()
    )
    store_names = _store_name_map(db, [row.store_id for row in rows], username=username)
    return {
        "result": [_serialize_order(row, store_names.get(row.store_id)) for row in rows],
        "total": total,
        "page": page,
        "page_size": page_size,
    }


@app.post(f"{settings.API_V1_STR}/warehouse/batch/inbound")
def batch_warehouse_inbound(
    payload: schemas.WarehouseBatchRequest,
    request: Request,
    db: Session = Depends(get_db),
) -> Dict[str, str]:
    username = _current_username(request)
    rows = _selected_orders_query(db, payload.ids, username=username).all()
    for row in rows:
        row.inbound_status = "inbound"
        row.warehouse_status = "已入库 / Ozon Logistics"
    db.commit()
    return {"message": f"Inbound completed for {len(rows)} orders"}


@app.post(f"{settings.API_V1_STR}/warehouse/batch/print")
def batch_warehouse_print(
    payload: schemas.WarehouseBatchRequest,
    request: Request,
    db: Session = Depends(get_db),
) -> Dict[str, str]:
    username = _current_username(request)
    rows = _selected_orders_query(db, payload.ids, username=username).all()
    for row in rows:
        row.printed = True
    db.commit()
    return {"message": f"Marked {len(rows)} orders as printed"}


@app.post(f"{settings.API_V1_STR}/warehouse/batch/download")
def batch_warehouse_download(
    payload: schemas.WarehouseBatchRequest,
    request: Request,
    db: Session = Depends(get_db),
) -> Dict[str, str]:
    username = _current_username(request)
    rows = _selected_orders_query(db, payload.ids, username=username).all()
    for row in rows:
        row.downloaded = True
    db.commit()
    return {"message": f"Marked {len(rows)} orders as downloaded"}


@app.post(f"{settings.API_V1_STR}/warehouse/batch/close")
def batch_warehouse_close(
    payload: schemas.WarehouseBatchRequest,
    request: Request,
    db: Session = Depends(get_db),
) -> Dict[str, str]:
    username = _current_username(request)
    rows = _selected_orders_query(db, payload.ids, username=username).all()
    for row in rows:
        row.closed = True
        row.warehouse_status = "已关闭"
    db.commit()
    return {"message": f"Closed {len(rows)} orders"}


@app.get(f"{settings.API_V1_STR}/analytics/categories")
def get_category_analytics(
    request: Request,
    days: int = Query(default=7, ge=1, le=365),
    path: str = Query(default=""),
    store_id: Optional[int] = Query(default=None),
    db: Session = Depends(get_db),
) -> Dict[str, Any]:
    username = _current_username(request)
    path_list = [part for part in path.split("/") if part]
    products_query = db.query(models.Product)
    orders_query = db.query(models.OrderRecord)
    products_query = _scope_query_to_user_stores(
        products_query, models.Product.store_id, db, username
    )
    orders_query = _scope_query_to_user_stores(
        orders_query, models.OrderRecord.store_id, db, username
    )
    if store_id is not None:
        _resolve_store(db, store_id, username=username)
        products_query = products_query.filter(models.Product.store_id == store_id)
        orders_query = orders_query.filter(models.OrderRecord.store_id == store_id)
    products = products_query.all()
    orders = orders_query.all()
    return _build_category_analytics(products, orders, path_list, days)


@app.get(f"{settings.API_V1_STR}/analytics/market-category-trends")
def get_market_category_trends(
    request: Request,
    path: str = Query(default=""),
    root_scope: str = Query(default="current"),
    period: str = Query(default="28_days"),
) -> Dict[str, Any]:
    tenant_id = _current_tenant_id(request)
    normalized_scope = str(root_scope or "current").strip().lower()
    normalized_period = _normalize_market_period(period)
    if normalized_scope == "all":
        return _fetch_seller_market_all_roots_from_browser(normalized_period, tenant_id=tenant_id)

    path_ids = [_safe_int(part, 0) for part in path.split("/") if str(part).strip()]
    return _fetch_seller_market_category_trends_from_browser(
        path_ids,
        normalized_period,
        tenant_id=tenant_id,
    )


@app.get(f"{settings.API_V1_STR}/commissions")
def get_commissions(search: str = Query(default="")) -> Dict[str, Any]:
    if not search:
        rows = commission_data.COMMISSION_ROWS
    else:
        keyword = search.strip().lower()
        rows = [
            row
            for row in commission_data.COMMISSION_ROWS
            if keyword in row["group"].lower() or keyword in row["category"].lower()
        ]
    return {"result": rows, "meta": commission_data.COMMISSION_META}


@app.get(f"{settings.API_V1_STR}/hot-tags")
def get_hot_tags(
    request: Request,
    search: str = Query(default=""),
    trend_days: int = Query(default=SELLER_HOT_TAGS_DEFAULT_TREND_WINDOW_DAYS),
) -> Dict[str, Any]:
    normalized_trend_days = _normalize_seller_hot_tags_trend_window_days(trend_days)
    dataset = _get_hot_tags_dataset(normalized_trend_days, tenant_id=_current_tenant_id(request))
    source_rows = dataset.get("result") or []
    if not search:
        rows = source_rows
    else:
        keyword = search.strip().casefold()
        rows = [
            row
            for row in source_rows
            if keyword in str(row.get("tag") or "").casefold()
            or keyword in str(row.get("group") or "").casefold()
        ]

    meta = dict(dataset.get("meta") or {})
    meta["trendWindowDays"] = normalized_trend_days
    meta["total"] = len(rows)
    meta["filteredTotal"] = len(rows)
    meta["unfilteredTotal"] = len(source_rows)
    return {"result": rows, "meta": meta}


@app.get(
    f"{settings.API_V1_STR}/pricing/templates",
    response_model=List[schemas.PricingTemplateResponse],
)
def list_pricing_templates(
    request: Request,
    db: Session = Depends(get_db),
) -> List[models.PricingTemplate]:
    tenant_id = _current_tenant_id(request)
    query = db.query(models.PricingTemplate)
    if tenant_id:
        query = query.filter(
            or_(
                models.PricingTemplate.tenant_id == tenant_id,
                models.PricingTemplate.tenant_id.is_(None),
            )
        )
    return query.order_by(models.PricingTemplate.id.asc()).all()


@app.post(
    f"{settings.API_V1_STR}/pricing/templates",
    response_model=schemas.PricingTemplateResponse,
)
def save_pricing_template(
    payload: schemas.PricingTemplateCreate,
    request: Request,
    db: Session = Depends(get_db),
) -> models.PricingTemplate:
    tenant_id = _current_tenant_id(request)
    template = (
        db.query(models.PricingTemplate)
        .filter(
            models.PricingTemplate.name == payload.name,
            models.PricingTemplate.tenant_id == tenant_id,
        )
        .first()
    )
    if template is None:
        template = models.PricingTemplate(name=payload.name, tenant_id=tenant_id)
        db.add(template)
    for key, value in payload.dict().items():
        setattr(template, key, value)
    db.commit()
    db.refresh(template)
    return template


@app.post(f"{settings.API_V1_STR}/pricing/calculate")
def calculate_pricing(payload: schemas.PricingCalculationRequest) -> Dict[str, Any]:
    return {"result": _calculate_pricing_rows(payload)}


ACTIVITY_ADD_MODE_LABELS = {
    "AUTO": "自动加入",
    "AUTOMATIC": "自动加入",
    "MANUAL": "手动加入",
    "NOT_SET": "未设置",
    "UNKNOWN": "未设置",
}


def _activity_cache_get(
    cache: Dict[str, tuple[float, Dict[str, Any]]],
    key: str,
) -> Optional[Dict[str, Any]]:
    with _ACTIVITY_CACHE_LOCK:
        cached = cache.get(key)
        if not cached:
            return None
        expires_at, value = cached
        if expires_at <= time.time():
            cache.pop(key, None)
            return None
        return copy.deepcopy(value)


def _activity_cache_set(
    cache: Dict[str, tuple[float, Dict[str, Any]]],
    key: str,
    value: Dict[str, Any],
    ttl_seconds: float,
) -> None:
    with _ACTIVITY_CACHE_LOCK:
        cache[key] = (time.time() + max(ttl_seconds, 1.0), copy.deepcopy(value))


def _activity_query_cache_key(
    scope: str,
    tenant_id: Optional[int],
    store_id: int,
    payload: Dict[str, Any],
) -> str:
    payload_key = json.dumps(payload, ensure_ascii=False, sort_keys=True, separators=(",", ":"))
    return f"{scope}:tenant:{tenant_id or 0}:store:{store_id}:{payload_key}"


def _activity_product_detail_cache_key(
    client_id: str,
    product_id: int,
    tenant_id: Optional[int] = None,
    store_id: Optional[int] = None,
) -> str:
    return f"tenant:{tenant_id or 0}:store:{store_id or 0}:client:{client_id}:product:{product_id}"


def _clear_activity_query_cache(store_id: Optional[int] = None) -> None:
    with _ACTIVITY_CACHE_LOCK:
        if store_id is None:
            _ACTIVITY_QUERY_CACHE.clear()
            return

        prefixes = (
            f"actions:",
            f"candidates:",
            f"participating:",
        )
        keys_to_delete = [
            key
            for key in _ACTIVITY_QUERY_CACHE
            if key.startswith(prefixes) and f":store:{store_id}:" in key
        ]
        for key in keys_to_delete:
            _ACTIVITY_QUERY_CACHE.pop(key, None)


def _first_non_empty(*values: Any) -> Any:
    for value in values:
        if value is None:
            continue
        if isinstance(value, str):
            text = value.strip()
            if text:
                return text
            continue
        if value not in ("", [], {}, ()):
            return value
    return None


def _optional_money(value: Any) -> Optional[float]:
    if value is None:
        return None
    if isinstance(value, str) and not value.strip():
        return None
    return round(_safe_float(value, 0.0), 2)


def _activity_add_mode_label(value: Any) -> str:
    raw_value = str(value or "").strip()
    upper_value = raw_value.upper()
    if upper_value in ACTIVITY_ADD_MODE_LABELS:
        return ACTIVITY_ADD_MODE_LABELS[upper_value]
    if "AUTO" in upper_value:
        return "自动加入"
    if "MANUAL" in upper_value:
        return "手动加入"
    return raw_value or "未设置"


def _normalize_activity_list_payload(payload: Dict[str, Any]) -> Dict[str, Any]:
    normalized = dict(payload or {})
    limit = max(_safe_int(normalized.get("limit"), 100), 1)
    normalized["limit"] = limit
    if "offset" not in normalized:
        page = max(_safe_int(normalized.get("page"), 1), 1)
        normalized["offset"] = (page - 1) * limit
    else:
        normalized["offset"] = max(_safe_int(normalized.get("offset"), 0), 0)
    normalized.pop("page", None)
    normalized.pop("last_id", None)
    return normalized


def _normalize_actions_result(result: Dict[str, Any]) -> Dict[str, Any]:
    if not result.get("ok"):
        return result

    raw_items = result.get("data", {}).get("result") or []
    normalized_items: List[Dict[str, Any]] = []
    for item in raw_items:
        if not isinstance(item, dict):
            continue
        action_id = _safe_int(item.get("id") or item.get("action_id"), 0)
        title = str(
            _first_non_empty(
                item.get("title"),
                item.get("name"),
                f"活动 {action_id}" if action_id else "未命名活动",
            )
        )
        normalized_items.append(
            {
                **item,
                "id": action_id or item.get("id"),
                "title": title,
                "action_type": str(item.get("action_type") or "").strip(),
                "description": str(item.get("description") or "").strip(),
                "date_start": str(item.get("date_start") or "").strip(),
                "date_end": str(item.get("date_end") or "").strip(),
                "freeze_date": str(item.get("freeze_date") or "").strip(),
                "potential_products_count": _safe_int(item.get("potential_products_count"), 0),
                "participating_products_count": _safe_int(
                    item.get("participating_products_count"), 0
                ),
                "banned_products_count": _safe_int(item.get("banned_products_count"), 0),
                "is_participating": bool(item.get("is_participating")),
                "with_targeting": bool(item.get("with_targeting")),
            }
        )

    result["data"] = {"result": normalized_items}
    return result


def _extract_activity_products(result: Dict[str, Any]) -> tuple[List[Dict[str, Any]], int]:
    payload = result.get("data", {}).get("result") or {}
    if isinstance(payload, list):
        rows = [item for item in payload if isinstance(item, dict)]
        return rows, len(rows)
    rows = payload.get("products") or payload.get("items") or []
    if not isinstance(rows, list):
        rows = []
    total = _safe_int(payload.get("total"), len(rows))
    return [item for item in rows if isinstance(item, dict)], total


def _activity_product_id(item: Dict[str, Any]) -> Optional[int]:
    product_id = _safe_int(item.get("product_id") or item.get("id"), 0)
    return product_id if product_id > 0 else None


async def _fetch_activity_product_details(
    client_id: str,
    api_key: str,
    product_ids: Sequence[int],
    tenant_id: Optional[int] = None,
    store_id: Optional[int] = None,
) -> Dict[int, Dict[str, Any]]:
    details_by_product_id: Dict[int, Dict[str, Any]] = {}
    unique_ids = list(dict.fromkeys(product_id for product_id in product_ids if product_id > 0))
    if not unique_ids:
        return details_by_product_id

    missing_ids: List[int] = []
    for product_id in unique_ids:
        cached_detail = _activity_cache_get(
            _ACTIVITY_PRODUCT_DETAILS_CACHE,
            _activity_product_detail_cache_key(client_id, product_id, tenant_id, store_id),
        )
        if cached_detail is None:
            missing_ids.append(product_id)
            continue
        details_by_product_id[product_id] = cached_detail

    for start in range(0, len(missing_ids), 100):
        batch_ids = missing_ids[start : start + 100]
        detail_result = await get_products_info_list(
            client_id,
            api_key,
            product_ids=batch_ids,
        )
        if not detail_result.get("ok"):
            continue
        detail_items = (
            detail_result.get("data", {}).get("items")
            or detail_result.get("data", {}).get("result", {}).get("items")
            or []
        )
        for detail in detail_items:
            if not isinstance(detail, dict):
                continue
            product_id = _safe_int(detail.get("id") or detail.get("product_id"), 0)
            if product_id > 0:
                details_by_product_id[product_id] = detail
                _activity_cache_set(
                    _ACTIVITY_PRODUCT_DETAILS_CACHE,
                    _activity_product_detail_cache_key(client_id, product_id, tenant_id, store_id),
                    detail,
                    _ACTIVITY_PRODUCT_DETAILS_CACHE_TTL_SECONDS,
                )

    return details_by_product_id


def _activity_local_product_lookup(
    db: Session,
    store_id: int,
    rows: Sequence[Dict[str, Any]],
    details_by_product_id: Dict[int, Dict[str, Any]],
) -> Dict[str, models.Product]:
    lookup_keys: set[str] = set()

    for detail in details_by_product_id.values():
        for key in _product_lookup_keys(detail.get("offer_id"), detail.get("sku")):
            lookup_keys.add(key)

    for row in rows:
        for key in _product_lookup_keys(row.get("offer_id"), row.get("sku")):
            lookup_keys.add(key)

    if not lookup_keys:
        return {}

    products = (
        db.query(models.Product)
        .filter(
            models.Product.store_id == store_id,
            or_(
                models.Product.offer_id.in_(lookup_keys),
                models.Product.sku.in_(lookup_keys),
            ),
        )
        .all()
    )

    lookup: Dict[str, models.Product] = {}
    for product in products:
        for key in _product_lookup_keys(product.offer_id, product.sku):
            lookup[key] = product
    return lookup


def _activity_row_image(
    detail: Dict[str, Any],
    row: Dict[str, Any],
    product: Optional[models.Product],
) -> str:
    return str(
        _first_non_empty(
            _extract_primary_image(detail.get("primary_image")),
            _extract_primary_image(detail.get("images")),
            _extract_primary_image(row.get("image")),
            _extract_primary_image(row.get("primary_image")),
            _extract_primary_image(product.primary_image if product else None),
            "",
        )
    )


def _enrich_activity_products(
    rows: Sequence[Dict[str, Any]],
    *,
    action_id: Optional[int],
    details_by_product_id: Dict[int, Dict[str, Any]],
    local_product_lookup: Dict[str, models.Product],
) -> List[Dict[str, Any]]:
    enriched_rows: List[Dict[str, Any]] = []

    for row in rows:
        product_id = _activity_product_id(row)
        detail = details_by_product_id.get(product_id or 0, {})
        offer_id = str(_first_non_empty(detail.get("offer_id"), row.get("offer_id"), "") or "")
        sku = str(_first_non_empty(detail.get("sku"), row.get("sku"), offer_id) or "")

        local_product = None
        for key in _product_lookup_keys(offer_id, sku):
            local_product = local_product_lookup.get(key)
            if local_product is not None:
                break

        local_min_price = (
            round(local_product.price or 0.0, 2)
            if local_product is not None and local_product.price is not None
            else None
        )
        action_price = _optional_money(row.get("action_price"))
        enriched_rows.append(
            {
                **row,
                "action_id": action_id,
                "activity_product_id": product_id,
                "sku": sku,
                "offer_id": offer_id or (local_product.offer_id if local_product else ""),
                "name": str(
                    _first_non_empty(
                        detail.get("name"),
                        row.get("name"),
                        row.get("title"),
                        local_product.product_name if local_product else None,
                        offer_id or sku,
                        f"商品 {product_id}" if product_id else "未命名商品",
                    )
                ),
                "image": _activity_row_image(detail, row, local_product),
                "price": _optional_money(
                    _first_non_empty(row.get("price"), detail.get("price"), local_min_price)
                ),
                "action_price": action_price,
                "max_action_price": _optional_money(row.get("max_action_price")),
                "stock": _safe_int(
                    _first_non_empty(row.get("stock"), local_product.stock if local_product else None),
                    0,
                ),
                "min_stock": _safe_int(row.get("min_stock"), 0),
                "add_mode": str(row.get("add_mode") or "").strip(),
                "add_mode_label": _activity_add_mode_label(row.get("add_mode")),
                "local_min_price": local_min_price,
                "below_min_price": bool(
                    action_price is not None
                    and local_min_price is not None
                    and action_price < local_min_price
                ),
            }
        )

    return enriched_rows


async def _normalize_activity_products_result(
    result: Dict[str, Any],
    *,
    client_id: str,
    api_key: str,
    store_id: int,
    db: Session,
    action_id: Optional[int],
) -> Dict[str, Any]:
    if not result.get("ok"):
        return result

    rows, total = _extract_activity_products(result)
    product_ids = [product_id for product_id in (_activity_product_id(item) for item in rows) if product_id]
    tenant_id = _store_tenant_id(db, store_id)
    details_by_product_id = await _fetch_activity_product_details(
        client_id,
        api_key,
        product_ids,
        tenant_id=tenant_id,
        store_id=store_id,
    )
    local_product_lookup = _activity_local_product_lookup(db, store_id, rows, details_by_product_id)
    result["data"] = {
        "result": {
            "products": _enrich_activity_products(
                rows,
                action_id=action_id,
                details_by_product_id=details_by_product_id,
                local_product_lookup=local_product_lookup,
            ),
            "total": total,
        }
    }
    return result


async def _load_cached_activity_products_result(
    *,
    scope: str,
    loader: Callable[[str, str, Dict[str, Any]], Awaitable[Dict[str, Any]]],
    client_id: str,
    api_key: str,
    normalized_payload: Dict[str, Any],
    store_id: int,
    db: Session,
    action_id: Optional[int],
) -> Dict[str, Any]:
    tenant_id = _store_tenant_id(db, store_id)
    cache_key = _activity_query_cache_key(scope, tenant_id, store_id, normalized_payload)
    cached_result = _activity_cache_get(_ACTIVITY_QUERY_CACHE, cache_key)
    if cached_result is not None:
        cached_result["store_id"] = store_id
        return cached_result

    result = await loader(client_id, api_key, normalized_payload)
    result["store_id"] = store_id
    normalized_result = await _normalize_activity_products_result(
        result,
        client_id=client_id,
        api_key=api_key,
        store_id=store_id,
        db=db,
        action_id=action_id,
    )
    if normalized_result.get("ok"):
        _activity_cache_set(
            _ACTIVITY_QUERY_CACHE,
            cache_key,
            normalized_result,
            _ACTIVITY_QUERY_CACHE_TTL_SECONDS,
        )
    return normalized_result


@app.get(f"{settings.API_V1_STR}/activities/actions")
async def api_get_actions(
    request: Request,
    store_id: Optional[int] = Query(default=None),
    db: Session = Depends(get_db),
) -> Dict[str, Any]:
    username = _current_username(request)
    client_id, api_key, resolved_store_id = _resolve_store_credentials(
        db, store_id, username=username
    )
    tenant_id = _store_tenant_id(db, resolved_store_id)
    cache_key = _activity_query_cache_key("actions", tenant_id, resolved_store_id, {})
    cached_result = _activity_cache_get(_ACTIVITY_QUERY_CACHE, cache_key)
    if cached_result is not None:
        cached_result["store_id"] = resolved_store_id
        return cached_result

    result = await get_actions(client_id, api_key)
    result["store_id"] = resolved_store_id
    normalized_result = _normalize_actions_result(result)
    if normalized_result.get("ok"):
        _activity_cache_set(
            _ACTIVITY_QUERY_CACHE,
            cache_key,
            normalized_result,
            _ACTIVITY_QUERY_CACHE_TTL_SECONDS,
        )
    return normalized_result


@app.post(f"{settings.API_V1_STR}/activities/candidates")
async def api_get_candidates(
    request: Request,
    payload: Dict[str, Any] = Body(default={}),
    store_id: Optional[int] = Query(default=None),
    db: Session = Depends(get_db),
) -> Dict[str, Any]:
    username = _current_username(request)
    client_id, api_key, resolved_store_id = _resolve_store_credentials(
        db, store_id, username=username
    )
    normalized_payload = _normalize_activity_list_payload(payload)
    return await _load_cached_activity_products_result(
        scope="candidates",
        loader=get_candidates,
        client_id=client_id,
        api_key=api_key,
        normalized_payload=normalized_payload,
        store_id=resolved_store_id,
        db=db,
        action_id=_safe_int(normalized_payload.get("action_id"), 0) or None,
    )


@app.post(f"{settings.API_V1_STR}/activities/participating")
async def api_get_participating(
    request: Request,
    payload: Dict[str, Any] = Body(default={}),
    store_id: Optional[int] = Query(default=None),
    db: Session = Depends(get_db),
) -> Dict[str, Any]:
    username = _current_username(request)
    client_id, api_key, resolved_store_id = _resolve_store_credentials(
        db, store_id, username=username
    )
    normalized_payload = _normalize_activity_list_payload(payload)
    return await _load_cached_activity_products_result(
        scope="participating",
        loader=get_participating_products,
        client_id=client_id,
        api_key=api_key,
        normalized_payload=normalized_payload,
        store_id=resolved_store_id,
        db=db,
        action_id=_safe_int(normalized_payload.get("action_id"), 0) or None,
    )


@app.post(f"{settings.API_V1_STR}/activities/activate")
async def api_activate_products(
    request: Request,
    payload: Dict[str, Any] = Body(default={}),
    store_id: Optional[int] = Query(default=None),
    db: Session = Depends(get_db),
) -> Dict[str, Any]:
    username = _current_username(request)
    client_id, api_key, resolved_store_id = _resolve_store_credentials(
        db, store_id, username=username
    )
    result = await activate_products(client_id, api_key, payload)
    result["store_id"] = resolved_store_id
    if result.get("ok"):
        _clear_activity_query_cache(resolved_store_id)
    return result


@app.post(f"{settings.API_V1_STR}/activities/deactivate")
async def api_deactivate_products(
    request: Request,
    payload: Dict[str, Any] = Body(default={}),
    store_id: Optional[int] = Query(default=None),
    db: Session = Depends(get_db),
) -> Dict[str, Any]:
    username = _current_username(request)
    client_id, api_key, resolved_store_id = _resolve_store_credentials(
        db, store_id, username=username
    )
    result = await deactivate_products(client_id, api_key, payload)
    result["store_id"] = resolved_store_id
    if result.get("ok"):
        _clear_activity_query_cache(resolved_store_id)
    return result


@app.post(f"{settings.API_V1_STR}/activities/discount-tasks")
async def api_discount_tasks(
    request: Request,
    payload: Dict[str, Any] = Body(default={}),
    store_id: Optional[int] = Query(default=None),
    db: Session = Depends(get_db),
) -> Dict[str, Any]:
    username = _current_username(request)
    client_id, api_key, resolved_store_id = _resolve_store_credentials(
        db, store_id, username=username
    )
    result = await get_discount_tasks(client_id, api_key, payload)
    result["store_id"] = resolved_store_id
    return result


@app.post(f"{settings.API_V1_STR}/activities/discount-tasks/approve")
async def api_discount_tasks_approve(
    request: Request,
    payload: Dict[str, Any] = Body(default={}),
    store_id: Optional[int] = Query(default=None),
    db: Session = Depends(get_db),
) -> Dict[str, Any]:
    username = _current_username(request)
    client_id, api_key, resolved_store_id = _resolve_store_credentials(
        db, store_id, username=username
    )
    result = await approve_discount_tasks(client_id, api_key, payload)
    result["store_id"] = resolved_store_id
    return result


@app.post(f"{settings.API_V1_STR}/activities/discount-tasks/reject")
async def api_discount_tasks_reject(
    request: Request,
    payload: Dict[str, Any] = Body(default={}),
    store_id: Optional[int] = Query(default=None),
    db: Session = Depends(get_db),
) -> Dict[str, Any]:
    username = _current_username(request)
    client_id, api_key, resolved_store_id = _resolve_store_credentials(
        db, store_id, username=username
    )
    result = await reject_discount_tasks(client_id, api_key, payload)
    result["store_id"] = resolved_store_id
    return result


@app.get(f"{settings.API_V1_STR}/notifications")
async def get_notifications(
    request: Request,
    store_id: Optional[int] = Query(default=None),
    db: Session = Depends(get_db),
) -> Dict[str, List[Dict[str, Any]]]:
    username = _current_username(request)
    try:
        client_id, api_key, resolved_store_id = _resolve_store_credentials(
            db, store_id, username=username
        )
    except HTTPException:
        if store_id is None:
            return {"result": []}
        raise

    alerts: List[Dict[str, Any]] = []
    alert_id = 1

    local_pending_orders = (
        db.query(models.OrderRecord)
        .filter(models.OrderRecord.store_id == resolved_store_id)
        .filter(models.OrderRecord.status.in_(PENDING_ORDER_STATUSES))
        .order_by(models.OrderRecord.created_at.desc())
        .limit(5)
        .all()
    )
    for order in local_pending_orders:
        alerts.append(
            {
                "id": alert_id,
                "type": "order",
                "title": "本地订单待处理",
                "desc": f"订单 {order.posting_number} 仍处于 {order.status_label}。",
                "target_id": order.posting_number,
                "created_at": order.created_at,
                "store_id": resolved_store_id,
            }
        )
        alert_id += 1

    orders = await get_unfulfilled_orders(client_id, api_key)
    for order in orders[:5]:
        alerts.append(
            {
                "id": alert_id,
                "type": "order",
                "title": "Ozon pending shipment",
                "desc": f"Order {order.get('posting_number')} is still waiting for shipment.",
                "target_id": order.get("posting_number"),
                "created_at": order.get("in_process_at", ""),
                "store_id": resolved_store_id,
            }
        )
        alert_id += 1

    tasks = await get_discount_tasks_alerts(client_id, api_key)
    for task in tasks[:5]:
        alerts.append(
            {
                "id": alert_id,
                "type": "promo",
                "title": "Promotion task pending",
                "desc": f"Promotion {task.get('title')} has a pending discount task.",
                "target_id": task.get("id", ""),
                "created_at": "",
                "store_id": resolved_store_id,
            }
        )
        alert_id += 1

    return {"result": alerts}


if __name__ == "__main__":
    import uvicorn

    uvicorn.run(
        "main:app",
        host=settings.API_HOST,
        port=settings.API_PORT,
        reload=settings.is_development,
    )
