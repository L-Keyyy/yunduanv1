#!/bin/sh
set -eu

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
CELERY_BIN="${SCRIPT_DIR}/.venv/bin/celery"
WORKER_NAME="${CELERY_WORKER_NAME:-worker}"
QUEUES="${CELERY_QUEUES:-default,sync}"
CONCURRENCY="${CELERY_CONCURRENCY:-1}"

exec "${CELERY_BIN}" -A tasks.celery_app worker \
  --loglevel "${CELERY_LOGLEVEL:-info}" \
  --hostname "${WORKER_NAME}@%h" \
  --queues "${QUEUES}" \
  --concurrency "${CONCURRENCY}"
