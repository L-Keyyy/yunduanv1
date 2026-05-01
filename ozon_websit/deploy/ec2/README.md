## EC2 deployment

This deployment layout keeps the current single-instance shape:

- `nginx` serves the Vue `dist` directory on port `80`
- `uvicorn` runs the FastAPI app on `127.0.0.1:8000`
- `redis6` backs Celery async jobs
- `celery` runs background sync tasks
- `chrome-for-testing` runs headless on `127.0.0.1:9222` for browser-assisted Seller workflows

### Expected paths

- Backend: `/home/ec2-user/ozon_backend`
- Frontend dist source: `/home/ec2-user/ozon_frontend_dist`
- Frontend published docroot: `/usr/share/nginx/html`
- Deploy assets: `/home/ec2-user/ozon_deploy`

### First-time bootstrap

1. Upload this directory to `/home/ec2-user/ozon_deploy`.
2. Upload the backend code to `/home/ec2-user/ozon_backend`.
3. Upload the frontend `dist` directory to `/home/ec2-user/ozon_frontend_dist`.
4. Copy `backend.env.example` to `/home/ec2-user/ozon_backend/.env` and fill the real values.
5. Run:

```bash
cd /home/ec2-user/ozon_deploy
chmod +x bootstrap-remote.sh
./bootstrap-remote.sh
```

### Incremental sync from Windows

For normal day-to-day changes, use the PowerShell sync script from the local
Windows workspace. It will:

- compile backend Python files locally
- build the frontend `dist`
- upload backend code, frontend assets, and deploy files
- backup the current cloud release before swapping
- preserve remote `.env`, `ozon.db`, and `backend/cache`
- restart services and verify health endpoints

Example:

```powershell
cd D:\ozon\ozon_websit
powershell -ExecutionPolicy Bypass -File .\deploy\ec2\sync-and-verify.ps1
```

Optional flags:

```powershell
.\deploy\ec2\sync-and-verify.ps1 -HostName 15.134.99.199
.\deploy\ec2\sync-and-verify.ps1 -SkipBuild
.\deploy\ec2\sync-and-verify.ps1 -SkipVerify
```

### Runtime checks

```bash
sudo systemctl status ozon-backend ozon-worker ozon-chrome redis6 nginx
curl -sS http://127.0.0.1:8000/healthz
curl -sS http://127.0.0.1:8000/api/v1/health
curl -sS http://127.0.0.1:9222/json/version
```

### Seller session

The browser-assisted features only work after a Seller session exists in the Chrome profile at:

`/home/ec2-user/chrome-profile`

The backend does not open the session for you. It only connects to an already running Chrome DevTools target.

On some cloud IPs, `seller.ozon.ru` may return an `Antibot Challenge Page` even when Chrome is running with a real X11 display. In that case the blocker is the remote IP reputation or challenge flow, not the local `9222` service.

### Data safety boundaries

The sync script treats the cloud host as a mixed stateful/stateless deployment:

- stateless and safe to overwrite: backend source code, frontend `dist`,
  systemd service files, nginx config
- stateful and preserved on every deploy: backend `.env`, `ozon.db`,
  `backend/cache`, and the Chrome profile under `/home/ec2-user/chrome-profile`

For the next cloud step, the recommended storage split is:

- secrets and credentials: Parameter Store or Secrets Manager, not the repo
- business data: PostgreSQL/RDS
- queue and cache: Redis/ElastiCache
- browser-assisted Seller session: isolated on the Chrome helper EC2
- large import/export files and screenshots: S3
