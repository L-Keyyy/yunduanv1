param(
    [string]$HostName = "15.134.99.199",
    [string]$RemoteUser = "ec2-user",
    [string]$KeyPath = "D:\ozon\first_ssh.pem",
    [string]$ProjectRoot = "D:\ozon\ozon_websit",
    [switch]$SkipBuild,
    [switch]$SkipVerify
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

function Write-Step {
    param([string]$Message)
    Write-Host ""
    Write-Host "==> $Message" -ForegroundColor Cyan
}

function Get-CommandPath {
    param([string]$Name)
    $command = Get-Command $Name -ErrorAction SilentlyContinue
    if (-not $command) {
        throw "Required command not found: $Name"
    }
    return $command.Source
}

function Invoke-Checked {
    param(
        [string]$FilePath,
        [string[]]$Arguments,
        [string]$WorkingDirectory = $ProjectRoot
    )

    $quoted = @($FilePath) + ($Arguments | ForEach-Object {
        if ($_ -match "\s") { '"' + $_ + '"' } else { $_ }
    })
    Write-Host ($quoted -join " ") -ForegroundColor DarkGray

    Push-Location $WorkingDirectory
    try {
        & $FilePath @Arguments
        if ($LASTEXITCODE -ne 0) {
            throw ("Command failed with exit code {0}: {1}" -f $LASTEXITCODE, $FilePath)
        }
    }
    finally {
        Pop-Location
    }
}

function Invoke-CheckedWithRetry {
    param(
        [string]$FilePath,
        [string[]]$Arguments,
        [string]$WorkingDirectory = $ProjectRoot,
        [int]$Attempts = 3,
        [int]$DelaySeconds = 10
    )

    for ($attempt = 1; $attempt -le $Attempts; $attempt++) {
        try {
            Invoke-Checked -FilePath $FilePath -Arguments $Arguments -WorkingDirectory $WorkingDirectory
            return
        }
        catch {
            if ($attempt -ge $Attempts) {
                throw
            }

            Write-Warning ("Remote command failed on attempt {0}/{1}: {2}. Retrying in {3}s." -f $attempt, $Attempts, $_.Exception.Message, $DelaySeconds)
            Start-Sleep -Seconds $DelaySeconds
        }
    }
}

function Quote-ProcessArgument {
    param([string]$Argument)
    if ($Argument -notmatch '[\s"]') {
        return $Argument
    }

    return '"' + ($Argument -replace '"', '\"') + '"'
}

function Send-FileOverSsh {
    param(
        [string]$SshPath,
        [string[]]$SshOptions,
        [string]$RemoteTarget,
        [string]$LocalPath,
        [string]$RemotePath
    )

    if (-not (Test-Path -LiteralPath $LocalPath)) {
        throw "Upload source not found: $LocalPath"
    }

    $remoteDir = $RemotePath -replace "/[^/]+$", ""
    $remoteCommand = "mkdir -p '$remoteDir' && cat > '$RemotePath'"
    $arguments = @($SshOptions + $RemoteTarget + $remoteCommand)
    $argumentLine = ($arguments | ForEach-Object { Quote-ProcessArgument $_ }) -join " "

    Write-Host ("{0} {1} < {2}" -f $SshPath, $argumentLine, $LocalPath) -ForegroundColor DarkGray

    $processInfo = [System.Diagnostics.ProcessStartInfo]::new()
    $processInfo.FileName = $SshPath
    $processInfo.Arguments = $argumentLine
    $processInfo.UseShellExecute = $false
    $processInfo.RedirectStandardInput = $true
    $processInfo.RedirectStandardOutput = $true
    $processInfo.RedirectStandardError = $true

    $process = [System.Diagnostics.Process]::Start($processInfo)
    try {
        $fileStream = [System.IO.File]::OpenRead($LocalPath)
        try {
            $fileStream.CopyTo($process.StandardInput.BaseStream)
            $process.StandardInput.BaseStream.Close()
        }
        finally {
            $fileStream.Dispose()
        }

        $stdout = $process.StandardOutput.ReadToEnd()
        $stderr = $process.StandardError.ReadToEnd()
        $process.WaitForExit()

        if ($stdout) { Write-Host $stdout.TrimEnd() }
        if ($stderr) { Write-Host $stderr.TrimEnd() -ForegroundColor DarkGray }
        if ($process.ExitCode -ne 0) {
            throw ("Upload failed with exit code {0}: {1}" -f $process.ExitCode, $LocalPath)
        }
    }
    finally {
        $process.Dispose()
    }
}

function Send-FileOverSshWithRetry {
    param(
        [string]$SshPath,
        [string[]]$SshOptions,
        [string]$RemoteTarget,
        [string]$LocalPath,
        [string]$RemotePath,
        [int]$Attempts = 3,
        [int]$DelaySeconds = 10
    )

    for ($attempt = 1; $attempt -le $Attempts; $attempt++) {
        try {
            Send-FileOverSsh -SshPath $SshPath -SshOptions $SshOptions -RemoteTarget $RemoteTarget -LocalPath $LocalPath -RemotePath $RemotePath
            return
        }
        catch {
            if ($attempt -ge $Attempts) {
                throw
            }

            Write-Warning ("Upload failed on attempt {0}/{1}: {2}. Retrying in {3}s." -f $attempt, $Attempts, $_.Exception.Message, $DelaySeconds)
            Start-Sleep -Seconds $DelaySeconds
        }
    }
}

function Remove-IfExists {
    param([string]$Path)
    if (Test-Path -LiteralPath $Path) {
        Remove-Item -LiteralPath $Path -Force -Recurse
    }
}

$sshPath = Get-CommandPath "ssh"
$tarPath = Get-CommandPath "tar"
$pythonPath = Get-CommandPath "python"
$npmPath = Get-CommandPath "npm"

if (-not (Test-Path -LiteralPath $KeyPath)) {
    throw "SSH key not found: $KeyPath"
}

$sshOptions = @(
    "-o", "StrictHostKeyChecking=accept-new",
    "-o", "BatchMode=yes",
    "-o", "ConnectTimeout=75",
    "-o", "ConnectionAttempts=3",
    "-o", "ServerAliveInterval=15",
    "-o", "ServerAliveCountMax=4",
    "-i", $KeyPath
)

$backendRoot = Join-Path $ProjectRoot "backend"
$frontendRoot = Join-Path $ProjectRoot "frontend"
$deployRoot = Join-Path $ProjectRoot "deploy\ec2"
$frontendDist = Join-Path $frontendRoot "dist"

foreach ($requiredPath in @($backendRoot, $frontendRoot, $deployRoot)) {
    if (-not (Test-Path -LiteralPath $requiredPath)) {
        throw "Required path not found: $requiredPath"
    }
}

$timestamp = Get-Date -Format "yyyyMMdd-HHmmss"
$releaseDir = Join-Path $env:TEMP "oumaitong-cloud-sync-$timestamp"
$backendArchive = Join-Path $releaseDir "backend.tgz"
$frontendArchive = Join-Path $releaseDir "frontend.tgz"
$deployArchive = Join-Path $releaseDir "deploy.tgz"

New-Item -ItemType Directory -Path $releaseDir -Force | Out-Null

try {
    if (-not $SkipBuild) {
        Write-Step "Validating backend Python files"
        Invoke-Checked -FilePath $pythonPath -Arguments @("-m", "compileall", $backendRoot)

        Write-Step "Building frontend dist"
        Invoke-Checked -FilePath $npmPath -Arguments @("run", "build") -WorkingDirectory $frontendRoot
    }

    if (-not (Test-Path -LiteralPath $frontendDist)) {
        throw "Frontend dist not found: $frontendDist"
    }

    Write-Step "Packaging backend release"
    Invoke-Checked -FilePath $tarPath -Arguments @(
        "-czf", $backendArchive,
        "-C", $ProjectRoot,
        "--exclude=backend/.venv",
        "--exclude=backend/__pycache__",
        "--exclude=backend/cache",
        "--exclude=backend/ozon.db",
        "--exclude=backend/alembic_validation.db",
        "--exclude=backend/backend.stdout.log",
        "--exclude=backend/backend.stderr.log",
        "backend"
    )

    Write-Step "Packaging frontend dist"
    Invoke-Checked -FilePath $tarPath -Arguments @(
        "-czf", $frontendArchive,
        "-C", $frontendDist,
        "."
    )

    Write-Step "Packaging deploy assets"
    Invoke-Checked -FilePath $tarPath -Arguments @(
        "-czf", $deployArchive,
        "-C", $deployRoot,
        "."
    )

    $remoteBase = "/home/$RemoteUser"
    $remoteStaging = "$remoteBase/deploy_staging/$timestamp"
    $remoteTarget = "$RemoteUser@$HostName"

    Write-Step "Preparing remote staging directory"
    Invoke-CheckedWithRetry -FilePath $sshPath -Arguments @(
        $sshOptions +
        $remoteTarget,
        "mkdir -p $remoteStaging"
    )

    Write-Step "Uploading release archives"
    Send-FileOverSshWithRetry -SshPath $sshPath -SshOptions $sshOptions -RemoteTarget $remoteTarget -LocalPath $backendArchive -RemotePath "$remoteStaging/backend.tgz"
    Send-FileOverSshWithRetry -SshPath $sshPath -SshOptions $sshOptions -RemoteTarget $remoteTarget -LocalPath $frontendArchive -RemotePath "$remoteStaging/frontend.tgz"
    Send-FileOverSshWithRetry -SshPath $sshPath -SshOptions $sshOptions -RemoteTarget $remoteTarget -LocalPath $deployArchive -RemotePath "$remoteStaging/deploy.tgz"

    $remoteScript = @'
set -euo pipefail

TIMESTAMP="$1"
REMOTE_ROOT="$HOME"
STAGING_ROOT="${REMOTE_ROOT}/deploy_staging/${TIMESTAMP}"
BACKUP_ROOT="${REMOTE_ROOT}/backups/deploy_${TIMESTAMP}"
LIVE_BACKEND="${REMOTE_ROOT}/ozon_backend"
LIVE_FRONTEND="${REMOTE_ROOT}/ozon_frontend_dist"
LIVE_DEPLOY="${REMOTE_ROOT}/ozon_deploy"
NEW_BACKEND="${STAGING_ROOT}/backend_release"
NEW_FRONTEND="${STAGING_ROOT}/frontend_release"
NEW_DEPLOY="${STAGING_ROOT}/deploy_release"
SWAPPED=0

rollback() {
  status=$?
  if [ "${SWAPPED}" = "1" ]; then
    echo "deployment failed, restoring previous release" >&2
    rm -rf "${LIVE_BACKEND}" "${LIVE_FRONTEND}" "${LIVE_DEPLOY}"
    if [ -d "${BACKUP_ROOT}/ozon_backend" ]; then mv "${BACKUP_ROOT}/ozon_backend" "${LIVE_BACKEND}"; fi
    if [ -d "${BACKUP_ROOT}/ozon_frontend_dist" ]; then mv "${BACKUP_ROOT}/ozon_frontend_dist" "${LIVE_FRONTEND}"; fi
    if [ -d "${BACKUP_ROOT}/ozon_deploy" ]; then mv "${BACKUP_ROOT}/ozon_deploy" "${LIVE_DEPLOY}"; fi
    python3 - <<'PY'
from pathlib import Path
for path in (
    Path("/home/ec2-user/ozon_deploy/bootstrap-remote.sh"),
    Path("/home/ec2-user/ozon_backend/start-api.sh"),
    Path("/home/ec2-user/ozon_backend/start-worker.sh"),
    Path("/home/ec2-user/ozon_backend/start-beat.sh"),
):
    if path.exists():
        path.write_text(path.read_text(encoding="utf-8").replace("\r\n", "\n"), encoding="utf-8")
PY
    chmod +x "${LIVE_DEPLOY}/bootstrap-remote.sh" "${LIVE_BACKEND}/start-api.sh" "${LIVE_BACKEND}/start-worker.sh" "${LIVE_BACKEND}/start-beat.sh" || true
    bash "${LIVE_DEPLOY}/bootstrap-remote.sh" || true
  fi
  exit "${status}"
}

trap rollback ERR

mkdir -p "${BACKUP_ROOT}" "${NEW_BACKEND}" "${NEW_FRONTEND}" "${NEW_DEPLOY}"
tar -xzf "${STAGING_ROOT}/backend.tgz" -C "${STAGING_ROOT}"
tar -xzf "${STAGING_ROOT}/frontend.tgz" -C "${NEW_FRONTEND}"
tar -xzf "${STAGING_ROOT}/deploy.tgz" -C "${NEW_DEPLOY}"
mv "${STAGING_ROOT}/backend" "${NEW_BACKEND}/app"

sudo systemctl stop ozon-beat ozon-worker ozon-backend || true

if [ -d "${LIVE_BACKEND}" ]; then mv "${LIVE_BACKEND}" "${BACKUP_ROOT}/ozon_backend"; fi
if [ -d "${LIVE_FRONTEND}" ]; then mv "${LIVE_FRONTEND}" "${BACKUP_ROOT}/ozon_frontend_dist"; fi
if [ -d "${LIVE_DEPLOY}" ]; then mv "${LIVE_DEPLOY}" "${BACKUP_ROOT}/ozon_deploy"; fi

mv "${NEW_BACKEND}/app" "${LIVE_BACKEND}"
mv "${NEW_FRONTEND}" "${LIVE_FRONTEND}"
mv "${NEW_DEPLOY}" "${LIVE_DEPLOY}"
SWAPPED=1

if [ -f "${BACKUP_ROOT}/ozon_backend/.env" ]; then
  cp -a "${BACKUP_ROOT}/ozon_backend/.env" "${LIVE_BACKEND}/.env"
fi

if [ -f "${BACKUP_ROOT}/ozon_backend/ozon.db" ]; then
  cp -a "${BACKUP_ROOT}/ozon_backend/ozon.db" "${LIVE_BACKEND}/ozon.db"
fi

if [ -d "${BACKUP_ROOT}/ozon_backend/cache" ]; then
  cp -a "${BACKUP_ROOT}/ozon_backend/cache" "${LIVE_BACKEND}/cache"
fi

python3 - <<'PY'
from pathlib import Path
for path in (
    Path("/home/ec2-user/ozon_deploy/bootstrap-remote.sh"),
    Path("/home/ec2-user/ozon_backend/start-api.sh"),
    Path("/home/ec2-user/ozon_backend/start-worker.sh"),
    Path("/home/ec2-user/ozon_backend/start-beat.sh"),
):
    if path.exists():
        path.write_text(path.read_text(encoding="utf-8").replace("\r\n", "\n"), encoding="utf-8")
PY

chmod +x "${LIVE_DEPLOY}/bootstrap-remote.sh" "${LIVE_BACKEND}/start-api.sh" "${LIVE_BACKEND}/start-worker.sh" "${LIVE_BACKEND}/start-beat.sh"
bash -n "${LIVE_DEPLOY}/bootstrap-remote.sh"
bash "${LIVE_DEPLOY}/bootstrap-remote.sh"

trap - ERR
rm -rf "${STAGING_ROOT}"
echo "remote deploy complete"
'@

    Write-Step "Activating release on remote host"
    $remoteScriptPath = Join-Path $releaseDir "remote-activate.sh"
    [System.IO.File]::WriteAllText($remoteScriptPath, $remoteScript)

    Send-FileOverSshWithRetry -SshPath $sshPath -SshOptions $sshOptions -RemoteTarget $remoteTarget -LocalPath $remoteScriptPath -RemotePath "$remoteStaging/remote-activate.sh"

    try {
        Invoke-Checked -FilePath $sshPath -Arguments @(
            $sshOptions +
            $remoteTarget,
            "bash $remoteStaging/remote-activate.sh $timestamp"
        )
    }
    catch {
        Write-Warning ("Remote activation SSH session ended before confirmation: {0}. Checking whether activation completed." -f $_.Exception.Message)
        Invoke-CheckedWithRetry -FilePath $sshPath -Arguments @(
            $sshOptions +
            $remoteTarget,
            "test ! -d $remoteStaging && sudo systemctl is-active ozon-backend ozon-worker ozon-beat nginx redis6 >/dev/null && curl -fsS http://127.0.0.1:8000/healthz >/dev/null"
        )
    }

    if (-not $SkipVerify) {
        Write-Step "Verifying remote health and auth route"
        Invoke-CheckedWithRetry -FilePath $sshPath -Arguments @(
            $sshOptions +
            $remoteTarget,
            "sudo systemctl is-active ozon-backend ozon-worker ozon-beat ozon-chrome nginx redis6; echo '---'; curl -sS http://127.0.0.1:8000/healthz; echo; echo '---'; curl -sS http://127.0.0.1:8000/api/v1/health; echo; echo '---'; curl -sS -o /tmp/register-check.out -w '%{http_code}' -X POST -H 'Content-Type: application/json' -d '{}' http://127.0.0.1:8000/api/v1/auth/register; echo; cat /tmp/register-check.out; echo"
        )

        Write-Step "Checking public SPA route"
        Invoke-CheckedWithRetry -FilePath $sshPath -Arguments @(
            $sshOptions +
            $remoteTarget,
            "curl -sS -I http://127.0.0.1/register | head -n 5"
        )
    }

    Write-Step "Cloud sync finished"
    Write-Host "Release timestamp: $timestamp" -ForegroundColor Green
    Write-Host "Remote host: $HostName" -ForegroundColor Green
}
finally {
    Remove-IfExists -Path $releaseDir
}
