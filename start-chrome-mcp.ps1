param(
  [int]$Port = 9222,
  [string]$OpenUrl = "about:blank"
)

$ErrorActionPreference = "Stop"

function Get-ChromePath {
  $candidates = @(
    "$env:ProgramFiles\Google\Chrome\Application\chrome.exe",
    "$env:ProgramFiles(x86)\Google\Chrome\Application\chrome.exe",
    "$env:LocalAppData\Google\Chrome\Application\chrome.exe"
  )

  return $candidates | Where-Object { Test-Path $_ } | Select-Object -First 1
}

function Get-DebugEndpoint {
  param([int]$DebugPort)

  try {
    $response = Invoke-WebRequest -UseBasicParsing -Uri "http://127.0.0.1:$DebugPort/json/version" -TimeoutSec 2
    if ($response.StatusCode -eq 200 -and $response.Content) {
      return $response.Content | ConvertFrom-Json
    }
  } catch {
    return $null
  }

  return $null
}

$chromePath = Get-ChromePath
if (-not $chromePath) {
  throw "Chrome executable not found."
}

$userDataDir = Join-Path $env:LOCALAPPDATA "CodexChromeMcp-$Port"
New-Item -ItemType Directory -Force -Path $userDataDir | Out-Null

$existingEndpoint = Get-DebugEndpoint -DebugPort $Port
if ($existingEndpoint) {
  Write-Host "Chrome MCP is already available on port $Port."
  Write-Host $existingEndpoint.webSocketDebuggerUrl
  exit 0
}

$listener = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue |
  Select-Object -First 1

if ($listener) {
  $owner = Get-Process -Id $listener.OwningProcess -ErrorAction SilentlyContinue
  if ($owner -and $owner.ProcessName -ne "chrome") {
    throw "Port $Port is already in use by $($owner.ProcessName) (PID $($owner.Id))."
  }

  if ($owner -and $owner.ProcessName -eq "chrome") {
    Stop-Process -Id $owner.Id -Force -ErrorAction SilentlyContinue
    Start-Sleep -Seconds 1
  }
}

Start-Process -FilePath $chromePath -ArgumentList @(
  "--remote-debugging-port=$Port",
  "--user-data-dir=$userDataDir",
  "--no-first-run",
  "--no-default-browser-check",
  $OpenUrl
) | Out-Null

$endpoint = $null
for ($i = 0; $i -lt 20; $i++) {
  Start-Sleep -Milliseconds 500
  $endpoint = Get-DebugEndpoint -DebugPort $Port
  if ($endpoint) {
    break
  }
}

if (-not $endpoint) {
  throw "Chrome started, but the DevTools endpoint on port $Port did not become ready."
}

Write-Host "Chrome MCP is ready on port $Port."
Write-Host "Profile: $userDataDir"
Write-Host $endpoint.webSocketDebuggerUrl
