#!/bin/bash
set -euo pipefail

PROJECT_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
REPO_ROOT="$(cd "$PROJECT_ROOT/../.." && pwd)"
INSTALL_ROOT="${BANANA_WORKFLOW_HOME:-$HOME/Library/Application Support/BananaMallWorkflow}"
RUNTIME_ROOT="$INSTALL_ROOT/runtime"
DATA_ROOT="$INSTALL_ROOT/data"

mkdir -p "$RUNTIME_ROOT" "$DATA_ROOT"
rsync -a --delete --exclude storage "$PROJECT_ROOT/.next/standalone/" "$RUNTIME_ROOT/"
mkdir -p "$RUNTIME_ROOT/.next/static" "$RUNTIME_ROOT/public"
rsync -a --delete "$PROJECT_ROOT/.next/static/" "$RUNTIME_ROOT/.next/static/"
rsync -a --delete "$PROJECT_ROOT/public/" "$RUNTIME_ROOT/public/"

move_shared_path() {
  local source_path="$1"
  local target_path="$2"
  if [ -L "$source_path" ]; then
    return
  fi
  if [ -e "$target_path" ]; then
    echo "目标已存在，停止迁移：$target_path" >&2
    exit 1
  fi
  mv "$source_path" "$target_path"
  ln -s "$target_path" "$source_path"
}

move_shared_path "$PROJECT_ROOT/prisma/dev.db" "$DATA_ROOT/dev.db"
move_shared_path "$PROJECT_ROOT/storage" "$DATA_ROOT/storage"
move_shared_path "$REPO_ROOT/ai" "$DATA_ROOT/ai"
move_shared_path "$PROJECT_ROOT/../image-workshop" "$DATA_ROOT/image-workshop"

if [ -d "$RUNTIME_ROOT/storage" ] && [ ! -L "$RUNTIME_ROOT/storage" ]; then
  rsync -a --ignore-existing "$RUNTIME_ROOT/storage/" "$DATA_ROOT/storage/"
  rm -rf "$RUNTIME_ROOT/storage"
fi
ln -sfn "$DATA_ROOT/storage" "$RUNTIME_ROOT/storage"

cp "$PROJECT_ROOT/.env" "$RUNTIME_ROOT/.env"
/usr/bin/python3 - "$RUNTIME_ROOT/.env" "$DATA_ROOT" <<'PY'
from pathlib import Path
import sys

env_path = Path(sys.argv[1])
data_root = Path(sys.argv[2])
updates = {
    "DATABASE_URL": f'"file:{data_root / "dev.db"}"',
    "STORAGE_ROOT": f'"{data_root / "storage"}"',
    "BROWSER_AI_PROJECT_ROOT": f'"{data_root / "ai"}"',
    "IMAGE_WORKSHOP_ROOT": f'"{data_root / "image-workshop"}"',
    "CHROME_DEVTOOLS_BASE": '"http://127.0.0.1:9222"',
}
lines = env_path.read_text().splitlines()
seen = set()
output = []
for line in lines:
    key = line.split("=", 1)[0].strip() if "=" in line else ""
    if key in updates:
        output.append(f"{key}={updates[key]}")
        seen.add(key)
    else:
        output.append(line)
for key, value in updates.items():
    if key not in seen:
        output.append(f"{key}={value}")
env_path.write_text("\n".join(output) + "\n")
PY

cp "$PROJECT_ROOT/scripts/start-local-workflow.sh" "$INSTALL_ROOT/start-local-workflow.sh"
cp "$PROJECT_ROOT/scripts/start-local-image-workshop.sh" "$INSTALL_ROOT/start-local-image-workshop.sh"
chmod +x "$INSTALL_ROOT/start-local-workflow.sh"
chmod +x "$INSTALL_ROOT/start-local-image-workshop.sh"
echo "$RUNTIME_ROOT"
