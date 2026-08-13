#!/bin/sh
set -eu

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
ALEMBIC_BIN="${SCRIPT_DIR}/.venv/bin/alembic"
UVICORN_BIN="${SCRIPT_DIR}/.venv/bin/uvicorn"

if [ "${RUN_MIGRATIONS_ON_START:-1}" = "1" ]; then
  "${ALEMBIC_BIN}" upgrade head
fi

exec "${UVICORN_BIN}" main:app --host "${API_HOST:-0.0.0.0}" --port "${API_PORT:-8000}" --workers "${API_WORKERS:-2}"
