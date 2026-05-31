#!/usr/bin/env bash
set -euo pipefail

RUNTIME_USER="${RUNTIME_USER:-ozon}"
BASE_ROOT="${BASE_ROOT:-/opt/ozon}"
APP_ROOT="${APP_ROOT:-${BASE_ROOT}/backend}"
FRONTEND_ROOT="${FRONTEND_ROOT:-${BASE_ROOT}/frontend_dist}"
DEPLOY_ROOT="${DEPLOY_ROOT:-${BASE_ROOT}/deploy}"
CHROME_ROOT="${CHROME_ROOT:-${BASE_ROOT}/chrome-for-testing}"
CHROME_BIN="${CHROME_ROOT}/chrome-linux64/chrome"

if [[ "$(id -u)" -ne 0 ]]; then
  exec sudo -E bash "$0" "$@"
fi

if [[ ! -d "${APP_ROOT}" ]]; then
  echo "missing backend directory: ${APP_ROOT}" >&2
  exit 1
fi

if [[ ! -d "${FRONTEND_ROOT}" ]]; then
  echo "missing frontend directory: ${FRONTEND_ROOT}" >&2
  exit 1
fi

if [[ ! -d "${DEPLOY_ROOT}" ]]; then
  echo "missing deploy directory: ${DEPLOY_ROOT}" >&2
  exit 1
fi

if ! id "${RUNTIME_USER}" >/dev/null 2>&1; then
  useradd --system --create-home --shell /bin/bash "${RUNTIME_USER}"
fi

ensure_swap() {
  if command -v swapon >/dev/null 2>&1 && swapon --show=NAME --noheadings 2>/dev/null | grep -qx "/swapfile"; then
    return
  fi

  if [[ ! -f /swapfile ]]; then
    fallocate -l 2G /swapfile || dd if=/dev/zero of=/swapfile bs=1M count=2048
    chmod 600 /swapfile
    mkswap /swapfile >/dev/null
  fi

  grep -q "^/swapfile " /etc/fstab || echo "/swapfile none swap sw 0 0" >>/etc/fstab
  swapon /swapfile 2>/dev/null || true
}

ensure_swap

export DEBIAN_FRONTEND=noninteractive
apt-get update -y >/dev/null
apt-get install -y \
  nginx \
  postgresql \
  postgresql-client \
  redis-server \
  python3 \
  python3-venv \
  python3-pip \
  build-essential \
  libpq-dev \
  tar \
  gzip \
  unzip \
  curl >/dev/null

systemctl enable --now postgresql >/dev/null
systemctl enable --now redis-server >/dev/null

mkdir -p "${BASE_ROOT}"
chown -R "${RUNTIME_USER}:${RUNTIME_USER}" "${BASE_ROOT}"

PYTHON_BIN="$(command -v python3)"
rm -rf "${APP_ROOT}/.venv"
sudo -u "${RUNTIME_USER}" "${PYTHON_BIN}" -m venv "${APP_ROOT}/.venv"
sudo -u "${RUNTIME_USER}" "${APP_ROOT}/.venv/bin/pip" install --upgrade pip >/dev/null
sudo -u "${RUNTIME_USER}" "${APP_ROOT}/.venv/bin/pip" install -r "${APP_ROOT}/requirements.txt" >/dev/null

if [[ ! -f "${APP_ROOT}/.env" ]]; then
  cp "${DEPLOY_ROOT}/backend.env.example" "${APP_ROOT}/.env"
  chown "${RUNTIME_USER}:${RUNTIME_USER}" "${APP_ROOT}/.env"
fi

ensure_env_default() {
  local key="$1"
  local value="$2"
  if ! grep -Eq "^${key}=" "${APP_ROOT}/.env"; then
    printf '\n%s=%s\n' "${key}" "${value}" >>"${APP_ROOT}/.env"
  fi
}

ensure_env_default "ENABLE_BROWSER_ASSIST_HEALTH" "false"

ensure_local_postgres() {
  local database_url
  database_url="$(grep -E '^DATABASE_URL=' "${APP_ROOT}/.env" | tail -n 1 | cut -d= -f2- | tr -d '\r')"
  if [[ -z "${database_url}" ]]; then
    echo "DATABASE_URL is empty in ${APP_ROOT}/.env" >&2
    exit 1
  fi

  "${APP_ROOT}/.venv/bin/python" - "${database_url}" >/tmp/ozon-local-db.sql <<'PY'
import sys
from urllib.parse import urlparse, unquote

url = sys.argv[1].replace("postgresql+psycopg2://", "postgresql://", 1)
parsed = urlparse(url)
host = parsed.hostname or ""
if host not in {"127.0.0.1", "localhost", ""}:
    raise SystemExit(0)

user = unquote(parsed.username or "")
password = unquote(parsed.password or "")
dbname = (parsed.path or "/").lstrip("/")
if not user or not dbname:
    raise SystemExit("local PostgreSQL DATABASE_URL must include user and database")

def sql_literal(value: str) -> str:
    return "'" + value.replace("'", "''") + "'"

def sql_ident(value: str) -> str:
    return '"' + value.replace('"', '""') + '"'

print(
    "DO $$ BEGIN "
    f"IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = {sql_literal(user)}) THEN "
    f"CREATE ROLE {sql_ident(user)} LOGIN PASSWORD {sql_literal(password)}; "
    "END IF; END $$;"
)
print(f"ALTER ROLE {sql_ident(user)} WITH PASSWORD {sql_literal(password)};")
print(
    "SELECT 'CREATE DATABASE ' || quote_ident("
    f"{sql_literal(dbname)}"
    ") || ' OWNER ' || quote_ident("
    f"{sql_literal(user)}"
    ") WHERE NOT EXISTS (SELECT FROM pg_database WHERE datname = "
    f"{sql_literal(dbname)}"
    ")\\gexec"
)
print(f"GRANT ALL PRIVILEGES ON DATABASE {sql_ident(dbname)} TO {sql_ident(user)};")
PY

  if [[ -s /tmp/ozon-local-db.sql ]]; then
    sudo -u postgres psql -v ON_ERROR_STOP=1 -f /tmp/ozon-local-db.sql >/dev/null
  fi
  rm -f /tmp/ozon-local-db.sql
}

ensure_local_postgres

install -m 0644 "${DEPLOY_ROOT}/ozon-backend.service" /etc/systemd/system/ozon-backend.service
install -m 0644 "${DEPLOY_ROOT}/ozon-worker.service" /etc/systemd/system/ozon-worker.service
install -m 0644 "${DEPLOY_ROOT}/ozon-upload-worker.service" /etc/systemd/system/ozon-upload-worker.service
install -m 0644 "${DEPLOY_ROOT}/ozon-browser-worker.service" /etc/systemd/system/ozon-browser-worker.service
install -m 0644 "${DEPLOY_ROOT}/ozon-beat.service" /etc/systemd/system/ozon-beat.service
install -m 0644 "${DEPLOY_ROOT}/ozon-chrome.service" /etc/systemd/system/ozon-chrome.service
install -m 0644 "${DEPLOY_ROOT}/ozon_spa.conf" /etc/nginx/conf.d/ozon_spa.conf
rm -f /etc/nginx/sites-enabled/default
rm -rf /var/www/html/*
cp -r "${FRONTEND_ROOT}/." /var/www/html/

chown -R "${RUNTIME_USER}:${RUNTIME_USER}" "${BASE_ROOT}"

systemctl daemon-reload
systemctl enable nginx ozon-backend ozon-worker ozon-upload-worker ozon-beat >/dev/null
systemctl disable --now ozon-browser-worker ozon-chrome >/dev/null 2>&1 || true
systemctl restart ozon-backend
systemctl restart ozon-worker
systemctl restart ozon-upload-worker
systemctl restart ozon-beat
systemctl restart nginx

echo "gcp bootstrap complete"
