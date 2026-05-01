set -euo pipefail
python3 -c "from pathlib import Path; files=['/home/ec2-user/ozon_deploy/bootstrap-remote.sh','/home/ec2-user/ozon_backend/start-api.sh','/home/ec2-user/ozon_backend/start-worker.sh']; [Path(f).write_text(Path(f).read_text(encoding='utf-8').replace('\\r\\n','\\n'), encoding='utf-8') for f in files]"
chmod +x /home/ec2-user/ozon_deploy/bootstrap-remote.sh /home/ec2-user/ozon_backend/start-api.sh /home/ec2-user/ozon_backend/start-worker.sh
bash -n /home/ec2-user/ozon_deploy/bootstrap-remote.sh
bash /home/ec2-user/ozon_deploy/bootstrap-remote.sh