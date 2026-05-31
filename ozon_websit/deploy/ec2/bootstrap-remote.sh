#!/usr/bin/env bash
set -euo pipefail

APP_ROOT="/home/ec2-user/ozon_backend"
FRONTEND_ROOT="/home/ec2-user/ozon_frontend_dist"
DEPLOY_ROOT="/home/ec2-user/ozon_deploy"
CHROME_ROOT="/home/ec2-user/.local/chrome-for-testing"
CHROME_BIN="${CHROME_ROOT}/chrome-linux64/chrome"

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

sudo dnf install -y nginx python3.12 python3.12-pip tar gzip unzip xorg-x11-server-Xvfb xorg-x11-xauth >/dev/null

ensure_swap() {
  if swapon --show --noheadings | grep -q .; then
    return
  fi
  if [[ ! -f /swapfile ]]; then
    sudo fallocate -l 2G /swapfile 2>/dev/null || sudo dd if=/dev/zero of=/swapfile bs=1M count=2048 status=none
  fi
  sudo chmod 600 /swapfile
  sudo mkswap -f /swapfile >/dev/null
  sudo swapon /swapfile
  if ! grep -qE '^[^#]+[[:space:]]+none[[:space:]]+swap[[:space:]]+' /etc/fstab; then
    echo '/swapfile none swap sw 0 0' | sudo tee -a /etc/fstab >/dev/null
  fi
}

ensure_swap

for pkg in \
  alsa-lib \
  atk \
  cups-libs \
  dbus-glib \
  gtk3 \
  liberation-fonts \
  libXcomposite \
  libXcursor \
  libXdamage \
  libXext \
  libXi \
  libXrandr \
  libXScrnSaver \
  libXtst \
  mesa-libgbm \
  nss \
  pango
do
  sudo dnf install -y "${pkg}" >/dev/null 2>&1 || true
done

PYTHON_BIN="$(command -v python3.12 || command -v python3)"
rm -rf "${APP_ROOT}/.venv"
"${PYTHON_BIN}" -m venv "${APP_ROOT}/.venv"
"${APP_ROOT}/.venv/bin/pip" install --upgrade pip >/dev/null
"${APP_ROOT}/.venv/bin/pip" install -r "${APP_ROOT}/requirements.txt" >/dev/null

if [[ ! -f "${APP_ROOT}/.env" ]]; then
  cp "${DEPLOY_ROOT}/backend.env.example" "${APP_ROOT}/.env"
fi

env_value() {
  local key="$1"
  grep -E "^${key}=" "${APP_ROOT}/.env" | tail -n 1 | cut -d= -f2- | tr -d '\r'
}

database_url="$(env_value DATABASE_URL)"
redis_url="$(env_value REDIS_URL)"
broker_url="$(env_value CELERY_BROKER_URL)"
result_backend="$(env_value CELERY_RESULT_BACKEND)"
field_key="$(env_value FIELD_ENCRYPTION_KEY)"

if [[ -z "${database_url}" || "${database_url}" == *"your-rds-endpoint"* || "${database_url}" == sqlite:* ]]; then
  echo "invalid DATABASE_URL in ${APP_ROOT}/.env; production deploy requires PostgreSQL/RDS" >&2
  exit 1
fi

if [[ -z "${redis_url}" || "${redis_url}" == *"your-redis-endpoint"* ]]; then
  echo "invalid REDIS_URL in ${APP_ROOT}/.env; production deploy requires Redis/ElastiCache" >&2
  exit 1
fi

if [[ -z "${broker_url}" || "${broker_url}" == *"your-redis-endpoint"* || -z "${result_backend}" || "${result_backend}" == *"your-redis-endpoint"* ]]; then
  echo "invalid Celery Redis settings in ${APP_ROOT}/.env; set CELERY_BROKER_URL and CELERY_RESULT_BACKEND" >&2
  exit 1
fi

if [[ -z "${field_key}" || "${field_key}" == change-me* ]]; then
  echo "invalid FIELD_ENCRYPTION_KEY in ${APP_ROOT}/.env; set a long secret or Fernet key" >&2
  exit 1
fi

mkdir -p "$(dirname "${CHROME_ROOT}")"

if [[ ! -x "${CHROME_BIN}" ]]; then
  chrome_url="$(
    python3 <<'PY'
import json
from urllib.request import urlopen

url = "https://googlechromelabs.github.io/chrome-for-testing/last-known-good-versions-with-downloads.json"
with urlopen(url, timeout=30) as response:
    payload = json.load(response)

for item in payload["channels"]["Stable"]["downloads"]["chrome"]:
    if item["platform"] == "linux64":
        print(item["url"])
        break
else:
    raise SystemExit("linux64 chrome download not found")
PY
  )"

  tmp_zip="/tmp/chrome-for-testing-linux64.zip"
  rm -f "${tmp_zip}"
  curl -fsSL "${chrome_url}" -o "${tmp_zip}"
  rm -rf "${CHROME_ROOT}"
  mkdir -p "$(dirname "${CHROME_ROOT}")"
  unzip -oq "${tmp_zip}" -d "$(dirname "${CHROME_ROOT}")"
fi

mkdir -p "${CHROME_ROOT}"
ln -sfn "$(dirname "${CHROME_ROOT}")/chrome-linux64" "${CHROME_ROOT}/chrome-linux64"

sudo install -m 0644 "${DEPLOY_ROOT}/ozon-backend.service" /etc/systemd/system/ozon-backend.service
sudo install -m 0644 "${DEPLOY_ROOT}/ozon-worker.service" /etc/systemd/system/ozon-worker.service
sudo install -m 0644 "${DEPLOY_ROOT}/ozon-upload-worker.service" /etc/systemd/system/ozon-upload-worker.service
sudo install -m 0644 "${DEPLOY_ROOT}/ozon-browser-worker.service" /etc/systemd/system/ozon-browser-worker.service
sudo install -m 0644 "${DEPLOY_ROOT}/ozon-beat.service" /etc/systemd/system/ozon-beat.service
sudo install -m 0644 "${DEPLOY_ROOT}/ozon-chrome.service" /etc/systemd/system/ozon-chrome.service
sudo install -m 0644 "${DEPLOY_ROOT}/ozon_spa.conf" /etc/nginx/default.d/ozon_spa.conf
sudo rm -rf /usr/share/nginx/html/*
sudo cp -r "${FRONTEND_ROOT}/." /usr/share/nginx/html/

sudo systemctl daemon-reload
sudo systemctl enable nginx ozon-backend ozon-worker ozon-upload-worker ozon-beat >/dev/null
sudo systemctl disable --now ozon-browser-worker ozon-chrome >/dev/null 2>&1 || true
sudo systemctl restart ozon-backend
sudo systemctl restart ozon-worker
sudo systemctl restart ozon-upload-worker
sudo systemctl restart ozon-beat
sudo systemctl restart nginx

echo "bootstrap complete"
