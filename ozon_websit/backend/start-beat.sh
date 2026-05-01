#!/bin/sh
set -eu

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
CELERY_BIN="${SCRIPT_DIR}/.venv/bin/celery"

exec "${CELERY_BIN}" -A tasks.celery_app beat --loglevel "${CELERY_LOGLEVEL:-info}"
