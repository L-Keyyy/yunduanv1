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
    task_routes={
        "ozon.upload_job": {"queue": "upload"},
        "ozon.dispatch_upload_jobs": {"queue": "upload"},
        "ozon.poll_upload_jobs": {"queue": "upload"},
        "ozon.refresh_upload_job": {"queue": "upload"},
        "ozon.cloud_follow_submit": {"queue": "browser"},
        "ozon.sync_browser_warehouses": {"queue": "browser"},
        "ozon.sync_products": {"queue": "sync"},
        "ozon.sync_orders": {"queue": "sync"},
        "ozon.sync_core": {"queue": "sync"},
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
        "dispatch-upload-jobs-every-15-seconds": {
            "task": "ozon.dispatch_upload_jobs",
            "schedule": 15.0,
            "kwargs": {"limit": settings.UPLOAD_MAX_GLOBAL_ACTIVE_STORES},
            "options": {"queue": "upload"},
        },
        "poll-upload-jobs-every-90-seconds": {
            "task": "ozon.poll_upload_jobs",
            "schedule": float(settings.UPLOAD_RESULT_POLL_INTERVAL_SECONDS),
            "kwargs": {"limit": 200},
            "options": {"queue": "upload"},
        },
    },
)
