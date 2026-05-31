from __future__ import annotations

from celery import Celery

from config import settings


celery_app = Celery(
    "ozon_management",
    broker=settings.CELERY_BROKER_URL,
    backend=settings.CELERY_RESULT_BACKEND,
    include=["tasks"],
)

celery_app.conf.update(
    task_serializer="json",
    accept_content=["json"],
    result_serializer="json",
    enable_utc=True,
    timezone="UTC",
    task_track_started=True,
    broker_connection_retry_on_startup=True,
    worker_prefetch_multiplier=settings.CELERY_WORKER_PREFETCH_MULTIPLIER,
    worker_max_tasks_per_child=settings.CELERY_WORKER_MAX_TASKS_PER_CHILD,
    worker_max_memory_per_child=settings.CELERY_WORKER_MAX_MEMORY_PER_CHILD_KB,
    task_reject_on_worker_lost=True,
    task_routes={
        "ozon.upload_job": {"queue": "upload"},
        "ozon.dispatch_upload_jobs": {"queue": "upload"},
        "ozon.poll_upload_jobs": {"queue": "upload"},
        "ozon.refresh_upload_job": {"queue": "upload"},
        "ozon.sync_warehouses": {"queue": "sync"},
        "ozon.sync_products": {"queue": "sync"},
        "ozon.sync_orders": {"queue": "sync"},
        "ozon.periodic_incremental_order_sync": {"queue": "sync"},
        "ozon.sync_core": {"queue": "sync"},
        "ozon.login_auto_sync": {"queue": "sync"},
        "ozon.verify_stores": {"queue": "sync"},
        "ozon.run_sync_schedule": {"queue": "sync"},
        "ozon.run_due_schedules": {"queue": "sync"},
        "ozon.refresh_analytics": {"queue": "sync"},
    },
    beat_schedule={
        "run-due-sync-schedules-every-minute": {
            "task": "ozon.run_due_schedules",
            "schedule": 60.0,
            "kwargs": {"limit": 20},
        },
        "periodic-incremental-order-sync": {
            "task": "ozon.periodic_incremental_order_sync",
            "schedule": float(max(5, int(settings.ORDER_SYNC_INTERVAL_MINUTES or 30)) * 60),
            "kwargs": {"days": 7, "overlap_minutes": 30},
            "options": {"queue": "sync"},
        },
        "dispatch-upload-jobs-every-15-seconds": {
            "task": "ozon.dispatch_upload_jobs",
            "schedule": 15.0,
            "kwargs": {"limit": settings.UPLOAD_MAX_GLOBAL_ACTIVE_STORES},
            "options": {"queue": "upload"},
        },
        "poll-upload-jobs-every-90-seconds": {
            "task": "ozon.poll_upload_jobs",
            "schedule": float(settings.UPLOAD_RESULT_POLL_INTERVAL_SECONDS),
            "kwargs": {"limit": settings.UPLOAD_RESULT_POLL_LIMIT},
            "options": {"queue": "upload"},
        },
    },
)
