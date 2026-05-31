## GCP low-cost single-VM deployment

This profile is for the cost-saving architecture:

- One Compute Engine VM runs Nginx, FastAPI, Celery, PostgreSQL, and Redis.
- Ozon/Seller page scraping stays local in the Chrome extension.
- No Cloud SQL, Memorystore, NAT Gateway, or load balancer is required for the first version.
- `ozon-chrome` and `ozon-browser-worker` are installed but disabled by default.

### Ports

Open only these ports in the GCP firewall:

- `22/tcp` from your own IP for SSH
- `80/tcp` for the web app
- `443/tcp` only after HTTPS is configured

Do not expose `9222/tcp` to the public internet. Chrome DevTools has powerful browser control permissions. If you need it temporarily, use an SSH tunnel:

```powershell
ssh -i D:\path\to\key -L 9222:127.0.0.1:9222 YOUR_GCP_SSH_USER@YOUR_GCP_EXTERNAL_IP
```

### Expected paths on the VM

- Backend: `/opt/ozon/backend`
- Frontend dist: `/opt/ozon/frontend_dist`
- Deploy assets: `/opt/ozon/deploy`
- Runtime user: `ozon`

### First deploy

1. Build/upload the backend, frontend `dist`, and this `deploy/gcp` directory to the paths above.
2. Copy `/opt/ozon/deploy/backend.env.example` to `/opt/ozon/backend/.env`.
3. Edit the real secrets in `.env`:

```bash
sudo nano /opt/ozon/backend/.env
```

At minimum change:

- `DATABASE_URL` password
- `SECRET_KEY`
- `FIELD_ENCRYPTION_KEY`
- `ADMIN_PASSWORD`
- `CORS_ORIGINS` external IP/domain

4. Run bootstrap:

```bash
sudo bash /opt/ozon/deploy/bootstrap-remote.sh
```

### Incremental deploy from Windows

```powershell
cd D:\ozon\ozon_websit
powershell -ExecutionPolicy Bypass -File .\deploy\gcp\sync-and-verify.ps1 -HostName YOUR_GCP_EXTERNAL_IP -RemoteUser YOUR_GCP_SSH_USER -KeyPath D:\path\to\key
```

### Runtime checks

```bash
sudo systemctl status ozon-backend ozon-worker ozon-upload-worker ozon-beat nginx postgresql redis-server
curl -fsS http://127.0.0.1:8000/healthz
curl -fsS http://127.0.0.1:8000/api/v1/health
sudo systemctl is-active ozon-chrome ozon-browser-worker
```

The last command should report inactive unless you explicitly chose cloud-side browser assistance.

### Cost controls

- Stop or delete the VM when not needed.
- Persistent disks still cost money while the VM is stopped.
- Static external IPs can cost money when reserved and unused.
- Avoid Cloud SQL, Memorystore, Cloud NAT, and external load balancers until the app has enough traffic to justify them.
