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

sudo dnf install -y nginx redis6 python3.12 python3.12-pip tar gzip unzip xorg-x11-server-Xvfb xorg-x11-xauth >/dev/null

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
sudo install -m 0644 "${DEPLOY_ROOT}/ozon-beat.service" /etc/systemd/system/ozon-beat.service
sudo install -m 0644 "${DEPLOY_ROOT}/ozon-chrome.service" /etc/systemd/system/ozon-chrome.service
sudo install -m 0644 "${DEPLOY_ROOT}/ozon_spa.conf" /etc/nginx/default.d/ozon_spa.conf
sudo rm -rf /usr/share/nginx/html/*
sudo cp -r "${FRONTEND_ROOT}/." /usr/share/nginx/html/

sudo systemctl daemon-reload
sudo systemctl enable redis6 nginx ozon-backend ozon-worker ozon-beat ozon-chrome >/dev/null
sudo systemctl restart redis6
sudo systemctl restart ozon-backend
sudo systemctl restart ozon-worker
sudo systemctl restart ozon-beat
sudo systemctl restart ozon-chrome
sudo systemctl restart nginx

echo "bootstrap complete"
