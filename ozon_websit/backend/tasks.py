from __future__ import annotations

import asyncio
import json
from datetime import datetime, timedelta, timezone
from typing import Any, Dict, List, Optional

from celery.utils.log import get_task_logger

from celery_app import celery_app
from database import SessionLocal, engine
import models
from main import (
    _run_cloud_follow_submit_workflow,
    _fetch_seller_warehouses_from_browser,
    _sync_products_from_upload_jobs,
    _sync_store_orders,
    _sync_store_products_from_ozon,
)
from ozon_client import verify_ozon_credentials

logger = get_task_logger(__name__)


def _ensure_sync_task_tables() -> None:
    models.SyncSchedule.__table__.create(bind=engine, checkfirst=True)
    models.SyncRun.__table__.create(bind=engine, checkfirst=True)


def _select_stores(
    db,
    store_id: Optional[int] = None,
    user_owner: Optional[str] = None,
    tenant_id: Optional[int] = None,
) -> List[models.Store]:
    query = db.query(models.Store).order_by(models.Store.id.asc())
    if tenant_id:
        query = query.filter(models.Store.tenant_id == tenant_id)
    elif user_owner:
        user = db.query(models.User).filter(models.User.username == user_owner).first()
        tenant_id = user.primary_tenant_id if user else None
        if tenant_id:
            query = query.filter(
                (models.Store.tenant_id == tenant_id)
                | (models.Store.user_owner == user_owner)
            )
        else:
            query = query.filter(models.Store.user_owner == user_owner)
    if store_id is not None:
        query = query.filter(models.Store.id == store_id)
    return query.all()


def run_verify_stores(
    store_id: Optional[int] = None,
    user_owner: Optional[str] = None,
    tenant_id: Optional[int] = None,
) -> Dict[str, Any]:
    db = SessionLocal()
    try:
        stores = _select_stores(db, store_id, user_owner, tenant_id)
        if not stores:
            return {
                "ok": False,
                "message": "No store configured",
                "verified": 0,
                "stores": 0,
                "results": [],
            }

        async def _verify_all() -> List[Any]:
            return await asyncio.gather(
                *[
                    verify_ozon_credentials(store.client_id, store.api_key)
                    for store in stores
                ]
            )

        verify_results = asyncio.run(_verify_all())
        rows: List[Dict[str, Any]] = []

        for store, result in zip(stores, verify_results):
            is_valid, message, daily_limit, can_update, total_limit = result
            store.key_status = "active" if is_valid else "invalid"
            store.info = message
            store.can_create = daily_limit if is_valid else "-"
            store.can_update = can_update if is_valid else "0 / 5000"
            store.daily_limit = daily_limit if is_valid else "-"
            store.total_limit = total_limit if is_valid else "0 / 8000"
            rows.append(
                {
                    "store_id": store.id,
                    "store_name": store.store_name,
                    "valid": bool(is_valid),
                    "message": message,
                }
            )

        db.commit()
        verified = sum(1 for row in rows if row["valid"])
        return {
            "ok": True,
            "message": f"Verified {len(rows)} store(s)",
            "verified": verified,
            "stores": len(rows),
            "results": rows,
        }
    except Exception:
        db.rollback()
        raise
    finally:
        db.close()


def run_sync_products(
    store_id: Optional[int] = None,
    user_owner: Optional[str] = None,
    tenant_id: Optional[int] = None,
) -> Dict[str, Any]:
    db = SessionLocal()
    try:
        stores = _select_stores(db, store_id, user_owner, tenant_id)
        synced_from_upload_jobs = _sync_products_from_upload_jobs(
            db, store_ids=[store.id for store in stores]
        )
        synced_from_ozon = 0
        skipped: List[str] = []

        for store in stores:
            try:
                synced_from_ozon += asyncio.run(_sync_store_products_from_ozon(db, store))
            except Exception as exc:
                skipped.append(f"{store.store_name}: {exc}")

        db.commit()
        total = synced_from_upload_jobs + synced_from_ozon
        return {
            "ok": True,
            "message": f"Synchronized {total} product row(s)",
            "synced_total": total,
            "synced_from_upload_jobs": synced_from_upload_jobs,
            "synced_from_ozon": synced_from_ozon,
            "stores": len(stores),
            "skipped": skipped,
        }
    except Exception:
        db.rollback()
        raise
    finally:
        db.close()


def run_sync_orders(
    store_id: Optional[int] = None,
    days: int = 30,
    user_owner: Optional[str] = None,
    tenant_id: Optional[int] = None,
) -> Dict[str, Any]:
    db = SessionLocal()
    try:
        stores = _select_stores(db, store_id, user_owner, tenant_id)
        if not stores:
            return {
                "ok": False,
                "message": "No store configured",
                "synced_orders": 0,
                "stores": 0,
                "skipped": [],
            }

        synced_total = 0
        skipped: List[str] = []
        results: List[Dict[str, Any]] = []

        for store in stores:
            result = asyncio.run(_sync_store_orders(db, store, days))
            results.append(result)
            if result.get("ok"):
                synced_total += int(result.get("synced", 0))
            else:
                skipped.append(f"{store.store_name}: {result.get('error', 'sync_failed')}")

        db.commit()
        return {
            "ok": True,
            "message": f"Synchronized {synced_total} FBS order(s)",
            "synced_orders": synced_total,
            "stores": len(stores),
            "skipped": skipped,
            "results": results,
        }
    except Exception:
        db.rollback()
        raise
    finally:
        db.close()


def run_sync_browser_warehouses(
    store_id: int,
    user_owner: Optional[str] = None,
    tenant_id: Optional[int] = None,
) -> Dict[str, Any]:
    db = SessionLocal()
    try:
        query = db.query(models.Store).filter(models.Store.id == store_id)
        if tenant_id:
            query = query.filter(models.Store.tenant_id == tenant_id)
        elif user_owner:
            user = db.query(models.User).filter(models.User.username == user_owner).first()
            tenant_id = user.primary_tenant_id if user else None
            if tenant_id:
                query = query.filter(
                    (models.Store.tenant_id == tenant_id)
                    | (models.Store.user_owner == user_owner)
                )
            else:
                query = query.filter(models.Store.user_owner == user_owner)
        store = query.first()
        if not store:
            return {
                "ok": False,
                "message": "Store not found",
                "store_id": store_id,
                "warehouses": [],
            }

        seller_payload = _fetch_seller_warehouses_from_browser()
        names: List[str] = []
        seen_names = set()
        for warehouse in seller_payload["warehouses"]:
            name = str(warehouse.get("name") or "").strip()
            if not name or name in seen_names:
                continue
            seen_names.add(name)
            names.append(name)

        store.warehouse_info = "\n".join(names)
        store.cookie_status = "active"
        db.commit()

        return {
            "ok": True,
            "message": f"Synchronized {len(names)} Ozon warehouse(s) from browser",
            "store_id": store.id,
            "store_name": store.store_name,
            "company_id": seller_payload["company_id"],
            "seller_url": seller_payload["seller_url"],
            "warehouses": seller_payload["warehouses"],
        }
    except Exception:
        db.rollback()
        raise
    finally:
        db.close()


def run_sync_core(
    days: int = 30,
    user_owner: Optional[str] = None,
    tenant_id: Optional[int] = None,
) -> Dict[str, Any]:
    verify_result = run_verify_stores(user_owner=user_owner, tenant_id=tenant_id)
    product_result = run_sync_products(user_owner=user_owner, tenant_id=tenant_id)
    order_result = run_sync_orders(days=days, user_owner=user_owner, tenant_id=tenant_id)
    return {
        "ok": all(
            result.get("ok", True)
            for result in (verify_result, product_result, order_result)
        ),
        "message": "Core sync workflow completed",
        "verify_stores": verify_result,
        "sync_products": product_result,
        "sync_orders": order_result,
    }


def run_cloud_follow_submit(
    *,
    store_id: int,
    reference: str,
    include_variants: bool = False,
    max_variants: int = 20,
    price: Optional[Any] = None,
    old_price: Optional[Any] = None,
    follow_min_price: Optional[Any] = None,
    model: Optional[str] = None,
    use_browser_session: bool = True,
    preferred_url_fragment: Optional[str] = None,
    front_cookie: Optional[str] = None,
    user_agent: Optional[str] = None,
    user_owner: Optional[str] = None,
    tenant_id: Optional[int] = None,
) -> Dict[str, Any]:
    db = SessionLocal()
    try:
        stores = _select_stores(
            db,
            store_id=int(store_id),
            user_owner=user_owner,
            tenant_id=tenant_id,
        )
        if not stores:
            raise ValueError("Store not found or not accessible for current tenant/user")
        store = stores[0]
        result = asyncio.run(
            _run_cloud_follow_submit_workflow(
                db=db,
                store=store,
                reference=reference,
                include_variants=bool(include_variants),
                max_variants=int(max_variants or 20),
                price=price,
                old_price=old_price,
                follow_min_price=follow_min_price,
                model=model,
                use_browser_session=bool(use_browser_session),
                preferred_url_fragment=preferred_url_fragment,
                front_cookie=front_cookie,
                user_agent=user_agent,
            )
        )
        return result
    except Exception:
        db.rollback()
        raise
    finally:
        db.close()


def _next_run_at(interval_minutes: int, base: Optional[datetime] = None) -> datetime:
    return (base or datetime.now(timezone.utc)) + timedelta(minutes=max(int(interval_minutes or 60), 5))


def _as_utc(value: Optional[datetime]) -> Optional[datetime]:
    if value is None:
        return None
    if value.tzinfo is None:
        return value.replace(tzinfo=timezone.utc)
    return value.astimezone(timezone.utc)


def _run_schedule_payload(schedule: models.SyncSchedule) -> Dict[str, Any]:
    if schedule.job_type == "verify_stores":
        return run_verify_stores(store_id=schedule.store_id, tenant_id=schedule.tenant_id)
    if schedule.job_type == "sync_products":
        return run_sync_products(store_id=schedule.store_id, tenant_id=schedule.tenant_id)
    if schedule.job_type == "sync_orders":
        return run_sync_orders(
            store_id=schedule.store_id,
            days=schedule.days,
            tenant_id=schedule.tenant_id,
        )
    if schedule.job_type == "sync_core":
        return run_sync_core(days=schedule.days, tenant_id=schedule.tenant_id)
    raise ValueError(f"Unsupported sync job type: {schedule.job_type}")


def run_sync_schedule(schedule_id: int, triggered_by: str = "system") -> Dict[str, Any]:
    _ensure_sync_task_tables()
    db = SessionLocal()
    now = datetime.now(timezone.utc)
    try:
        schedule = (
            db.query(models.SyncSchedule)
            .filter(models.SyncSchedule.id == schedule_id)
            .first()
        )
        if not schedule:
            return {"ok": False, "message": "Sync schedule not found", "schedule_id": schedule_id}

        locked_until = _as_utc(schedule.locked_until)
        if locked_until and locked_until > now:
            return {
                "ok": False,
                "message": "Sync schedule is already running",
                "schedule_id": schedule.id,
            }

        schedule.locked_until = now + timedelta(hours=2)
        schedule.last_status = "running"
        run = models.SyncRun(
            tenant_id=schedule.tenant_id,
            schedule_id=schedule.id,
            store_id=schedule.store_id,
            job_type=schedule.job_type,
            status="running",
            triggered_by=triggered_by or "system",
            started_at=now,
        )
        db.add(run)
        db.commit()
        db.refresh(run)

        try:
            result_payload = _run_schedule_payload(schedule)
            finished_at = datetime.now(timezone.utc)
            ok = bool(result_payload.get("ok", True))
            status = "success" if ok else "failed"
            message = str(result_payload.get("message") or status)
            run.status = status
            run.finished_at = finished_at
            run.result_payload = json.dumps(result_payload, ensure_ascii=False)
            run.error = None if ok else message
            schedule.last_run_at = finished_at
            schedule.next_run_at = _next_run_at(schedule.interval_minutes, finished_at)
            schedule.last_status = status
            schedule.last_message = message
            schedule.locked_until = None
            db.commit()
            return {
                "ok": ok,
                "message": message,
                "schedule_id": schedule.id,
                "run_id": run.id,
                "status": status,
                "result": result_payload,
            }
        except Exception as exc:
            finished_at = datetime.now(timezone.utc)
            message = str(exc)
            run.status = "failed"
            run.finished_at = finished_at
            run.error = message
            schedule.last_run_at = finished_at
            schedule.next_run_at = _next_run_at(schedule.interval_minutes, finished_at)
            schedule.last_status = "failed"
            schedule.last_message = message
            schedule.locked_until = None
            db.commit()
            raise
    except Exception:
        db.rollback()
        raise
    finally:
        db.close()


def run_due_schedules(limit: int = 20) -> Dict[str, Any]:
    _ensure_sync_task_tables()
    db = SessionLocal()
    now = datetime.now(timezone.utc)
    try:
        schedules = (
            db.query(models.SyncSchedule)
            .filter(models.SyncSchedule.enabled == True)  # noqa: E712
            .filter(models.SyncSchedule.next_run_at.isnot(None))
            .filter(models.SyncSchedule.next_run_at <= now)
            .filter(
                (models.SyncSchedule.locked_until.is_(None))
                | (models.SyncSchedule.locked_until <= now)
            )
            .order_by(models.SyncSchedule.next_run_at.asc(), models.SyncSchedule.id.asc())
            .limit(limit)
            .all()
        )
        schedule_ids = [schedule.id for schedule in schedules]
    finally:
        db.close()

    results = [run_sync_schedule(schedule_id, triggered_by="scheduler") for schedule_id in schedule_ids]
    return {
        "ok": True,
        "message": f"Processed {len(results)} due sync schedule(s)",
        "processed": len(results),
        "results": results,
    }


@celery_app.task(name="ozon.verify_stores")
def verify_stores_task(
    store_id: Optional[int] = None,
    user_owner: Optional[str] = None,
    tenant_id: Optional[int] = None,
) -> Dict[str, Any]:
    logger.info(
        "Starting verify_stores_task for store_id=%s user_owner=%s",
        store_id,
        user_owner,
    )
    return run_verify_stores(store_id=store_id, user_owner=user_owner, tenant_id=tenant_id)


@celery_app.task(name="ozon.sync_products")
def sync_products_task(
    store_id: Optional[int] = None,
    user_owner: Optional[str] = None,
    tenant_id: Optional[int] = None,
) -> Dict[str, Any]:
    logger.info(
        "Starting sync_products_task for store_id=%s user_owner=%s",
        store_id,
        user_owner,
    )
    return run_sync_products(store_id=store_id, user_owner=user_owner, tenant_id=tenant_id)


@celery_app.task(name="ozon.sync_orders")
def sync_orders_task(
    store_id: Optional[int] = None,
    days: int = 30,
    user_owner: Optional[str] = None,
    tenant_id: Optional[int] = None,
) -> Dict[str, Any]:
    logger.info(
        "Starting sync_orders_task for store_id=%s days=%s user_owner=%s",
        store_id,
        days,
        user_owner,
    )
    return run_sync_orders(
        store_id=store_id,
        days=days,
        user_owner=user_owner,
        tenant_id=tenant_id,
    )


@celery_app.task(name="ozon.sync_browser_warehouses")
def sync_browser_warehouses_task(
    store_id: int,
    user_owner: Optional[str] = None,
    tenant_id: Optional[int] = None,
) -> Dict[str, Any]:
    logger.info(
        "Starting sync_browser_warehouses_task for store_id=%s user_owner=%s",
        store_id,
        user_owner,
    )
    return run_sync_browser_warehouses(
        store_id=store_id,
        user_owner=user_owner,
        tenant_id=tenant_id,
    )


@celery_app.task(name="ozon.sync_core")
def sync_core_task(
    days: int = 30,
    user_owner: Optional[str] = None,
    tenant_id: Optional[int] = None,
) -> Dict[str, Any]:
    logger.info("Starting sync_core_task days=%s user_owner=%s", days, user_owner)
    return run_sync_core(days=days, user_owner=user_owner, tenant_id=tenant_id)


@celery_app.task(name="ozon.cloud_follow_submit")
def cloud_follow_submit_task(
    store_id: int,
    reference: str,
    include_variants: bool = False,
    max_variants: int = 20,
    price: Optional[Any] = None,
    old_price: Optional[Any] = None,
    follow_min_price: Optional[Any] = None,
    model: Optional[str] = None,
    use_browser_session: bool = True,
    preferred_url_fragment: Optional[str] = None,
    front_cookie: Optional[str] = None,
    user_agent: Optional[str] = None,
    user_owner: Optional[str] = None,
    tenant_id: Optional[int] = None,
) -> Dict[str, Any]:
    logger.info(
        "Starting cloud_follow_submit_task store_id=%s reference=%s user_owner=%s",
        store_id,
        reference,
        user_owner,
    )
    return run_cloud_follow_submit(
        store_id=store_id,
        reference=reference,
        include_variants=include_variants,
        max_variants=max_variants,
        price=price,
        old_price=old_price,
        follow_min_price=follow_min_price,
        model=model,
        use_browser_session=use_browser_session,
        preferred_url_fragment=preferred_url_fragment,
        front_cookie=front_cookie,
        user_agent=user_agent,
        user_owner=user_owner,
        tenant_id=tenant_id,
    )


@celery_app.task(name="ozon.run_sync_schedule")
def run_sync_schedule_task(schedule_id: int, triggered_by: str = "system") -> Dict[str, Any]:
    logger.info("Starting run_sync_schedule_task schedule_id=%s", schedule_id)
    return run_sync_schedule(schedule_id=schedule_id, triggered_by=triggered_by)


@celery_app.task(name="ozon.run_due_schedules")
def run_due_schedules_task(limit: int = 20) -> Dict[str, Any]:
    logger.info("Starting run_due_schedules_task limit=%s", limit)
    return run_due_schedules(limit=limit)
