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
    beat_schedule={
        "run-due-sync-schedules-every-minute": {
            "task": "ozon.run_due_schedules",
            "schedule": 60.0,
            "kwargs": {"limit": 20},
        },
    },
)
