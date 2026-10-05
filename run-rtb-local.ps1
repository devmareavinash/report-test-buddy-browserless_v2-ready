<#
.SYNOPSIS
  One-command local startup for Report Test Buddy (Browserless edition).

.DESCRIPTION
  Preflight-checks the toolchain, prepares .env, installs npm deps, then starts
  the four pieces in the right order:

      Browserless OSS  http://127.0.0.1:3000   (Docker, Chromium for script runs)
      Snowflake SSO    http://127.0.0.1:8002   (Python sidecar, optional)
      Deno backend     http://127.0.0.1:8000   (edge-function gateway)
      Vite frontend    http://localhost:8080   (foreground - Ctrl+C stops it)

  Place this file in the repo root OR in scripts\ - it locates the root either way.

.PARAMETER Compose
  Run the whole stack in Docker (docker compose up --build) instead of natively.

.PARAMETER SkipBrowserless
  Do not start Browserless (use when it is already running, or you only need the UI).

.PARAMETER SkipSso
  Do not start the Snowflake SSO sidecar (skip if you are not querying Snowflake).

.PARAMETER SkipInstall
  Do not run npm install even when node_modules is missing.

.PARAMETER RepoPath
  Repository to run. When omitted, the script uses the repository containing
  this file (or its parent when the file is under scripts\).

.EXAMPLE
  .\run-rtb-local.ps1
.EXAMPLE
  .\run-rtb-local.ps1 -SkipSso
.EXAMPLE
  .\run-rtb-local.ps1 -Compose
#>

[CmdletBinding()]
param(
  [string]$RepoPath = "",
  [switch]$Compose,
  [switch]$SkipBrowserless,
  [switch]$SkipSso,
  [switch]$SkipInstall
)

$ErrorActionPreference = "Stop"
$script:DockerDown = $false

# ---------------------------------------------------------------- helpers ----
function Write-Step($msg) { Write-Host "`n==> $msg" -ForegroundColor Cyan }
function Write-Ok($msg)   { Write-Host "    OK  $msg" -ForegroundColor Green }
function Write-Warn2($msg){ Write-Host "    !   $msg" -ForegroundColor Yellow }
function Write-Bad($msg)  { Write-Host "    X   $msg" -ForegroundColor Red }

function Test-Cmd($name) { [bool](Get-Command $name -ErrorAction SilentlyContinue) }

# Start a child PowerShell window running a .ps1.
# NOTE: Start-Process -ArgumentList joins array items with spaces and does NOT quote
# them, so any path containing a space (e.g. "OneDrive - Bayer") must be quoted here
# or the child window dies instantly with "file not found".
function Start-Child($scriptPath, $extraEnv) {
  if (-not (Test-Path $scriptPath)) { Write-Warn2 "not found: $scriptPath"; return $false }
  $quoted = '"' + $scriptPath + '"'
  $argline = "-NoExit -ExecutionPolicy Bypass -File $quoted"
  Write-Host "    launching: powershell $argline" -ForegroundColor DarkGray
  Start-Process -FilePath "powershell.exe" -ArgumentList $argline -WorkingDirectory (Split-Path $scriptPath -Parent) | Out-Null
  return $true
}

# Start a child PowerShell window running an inline command.
function Start-ChildCommand($workDir, $command) {
  $argline = "-NoExit -ExecutionPolicy Bypass -Command " + '"' + "Set-Location '$workDir'; $command" + '"'
  Write-Host "    launching: powershell -Command <inline>" -ForegroundColor DarkGray
  Start-Process -FilePath "powershell.exe" -ArgumentList $argline -WorkingDirectory $workDir | Out-Null
}

# Docker Desktop can be installed but the engine stopped - `docker run` then fails instantly.
function Test-DockerEngine {
  try { docker info *> $null; return ($LASTEXITCODE -eq 0) } catch { return $false }
}

function Test-Port($port) {
  try {
    $c = New-Object Net.Sockets.TcpClient
    $c.Connect("127.0.0.1", $port); $c.Close(); return $true
  } catch { return $false }
}

function Wait-Port($port, $label, $timeoutSec = 90) {
  $sw = [Diagnostics.Stopwatch]::StartNew()
  while ($sw.Elapsed.TotalSeconds -lt $timeoutSec) {
    if (Test-Port $port) { Write-Ok "$label is up on port $port"; return $true }
    Start-Sleep -Seconds 2
  }
  Write-Warn2 "$label did not open port $port within $timeoutSec s - check its window"
  return $false
}

# ------------------------------------------------------------- repo root -----
# Use the selected repository explicitly. This prevents the non-v2 and v2
# working copies from being mixed depending on where the launcher was saved.
$root = $null
if ($RepoPath -and (Test-Path (Join-Path $RepoPath "package.json"))) {
  $root = (Resolve-Path $RepoPath).Path
} else {
  $here = if ($PSScriptRoot) { $PSScriptRoot } else { (Get-Location).Path }
  $root = if (Test-Path (Join-Path $here "package.json")) { $here }
          elseif (Test-Path (Join-Path $here "..\package.json")) { (Resolve-Path (Join-Path $here "..")).Path }
          else { $null }
}

if (-not $root) {
  Write-Bad "Could not find package.json at RepoPath: $RepoPath"
  Write-Host "    Pass the repository explicitly with -RepoPath `"C:\path\to\repo`"" -ForegroundColor Yellow
  exit 1
}
Set-Location $root
Write-Host "`n  Report Test Buddy - local startup" -ForegroundColor White
Write-Host "  repo: $root"

# ------------------------------------------------------------- preflight -----
Write-Step "Checking prerequisites"
$missing = @()
if (-not (Test-Cmd node))   { $missing += "Node.js 18+ (https://nodejs.org)" } else { Write-Ok "node   $(node -v)" }
if (-not (Test-Cmd npm))    { $missing += "npm" }                              else { Write-Ok "npm    $(npm -v)" }
if (-not $Compose) {
  if (-not (Test-Cmd deno)) { $missing += "Deno (winget install DenoLand.Deno)" } else { Write-Ok "deno   $((deno --version) -split "`n" | Select-Object -First 1)" }
}
if (-not (Test-Cmd docker)) {
  if ($Compose -or -not $SkipBrowserless) { $missing += "Docker Desktop (needed for Browserless)" }
} else {
  if (Test-DockerEngine) { Write-Ok "docker engine running" }
  else {
    Write-Warn2 "docker is installed but the engine is NOT running - start Docker Desktop"
    if ($Compose) { $missing += "a running Docker engine" }
    else { $script:DockerDown = $true }
  }
}

if ($missing.Count) {
  Write-Bad "Missing prerequisites:"
  $missing | ForEach-Object { Write-Host "        - $_" }
  exit 1
}

# ------------------------------------------------------------------ .env -----
Write-Step "Checking .env"
$envPath = Join-Path $root ".env"
if (-not (Test-Path $envPath)) {
  if (Test-Path (Join-Path $root ".env.example")) {
    Copy-Item (Join-Path $root ".env.example") $envPath
    Write-Warn2 ".env created from .env.example - fill in the required values, then re-run:"
    Write-Host  "        VITE_SUPABASE_URL / VITE_SUPABASE_PUBLISHABLE_KEY / VITE_SUPABASE_PROJECT_ID"
    Write-Host  "        SUPABASE_URL / SUPABASE_ANON_KEY / SUPABASE_SERVICE_ROLE_KEY"
    Write-Host  "        ANTHROPIC_API_KEY  (script generation / repair)"
    Write-Host  "        BROWSERLESS_HOST=http://127.0.0.1:3000, BROWSERLESS_TOKEN=local-dev-token"
    exit 1
  }
  Write-Bad "No .env and no .env.example found."
  exit 1
}
Write-Ok ".env present"

$envText = Get-Content $envPath -Raw
foreach ($key in @("VITE_SUPABASE_URL", "ANTHROPIC_API_KEY", "BROWSERLESS_HOST")) {
  if ($envText -notmatch "(?m)^\s*$key\s*=\s*\S") { Write-Warn2 "$key looks empty in .env" }
}

# --------------------------------------------------------------- compose -----
if ($Compose) {
  Write-Step "Starting the full stack with Docker Compose"
  Write-Host "    web http://localhost:8080 | backend :8000 | browserless :3000"
  docker compose --profile docker-sso up --build
  exit $LASTEXITCODE
}

# ---------------------------------------------------------- npm install ------
if (-not $SkipInstall -and -not (Test-Path (Join-Path $root "node_modules"))) {
  Write-Step "Installing npm dependencies (first run only)"
  npm install
  if ($LASTEXITCODE -ne 0) { Write-Bad "npm install failed"; exit 1 }
  Write-Ok "dependencies installed"
}

# ----------------------------------------------------------- browserless -----
if (-not $SkipBrowserless) {
  Write-Step "Starting Browserless (Chromium for script runs)"
  if (Test-Port 3000) {
    Write-Ok "something is already listening on 3000 - reusing it"
  }
  elseif ($script:DockerDown) {
    Write-Warn2 "skipping Browserless - Docker engine is not running. Start Docker Desktop, then:"
    Write-Host  "        docker run --rm -p 3000:3000 --shm-size=2g -e TOKEN=local-dev-token -e TIMEOUT=840000 ghcr.io/browserless/chromium:v2.55.4"
  }
  elseif (Test-Path (Join-Path $root "scripts\dev-browserless.ps1")) {
    Start-Child (Join-Path $root "scripts\dev-browserless.ps1")
    Wait-Port 3000 "Browserless" 120 | Out-Null
  }
  else {
    $token = if ($env:BROWSERLESS_TOKEN) { $env:BROWSERLESS_TOKEN } else { "local-dev-token" }
    # 840000 = 14 min. The old 7-min default expired before heavy trend / Show Data
    # scripts finished, surfacing as a 504 from the proxy.
    $timeoutMs = if ($env:BROWSERLESS_TIMEOUT_MS) { $env:BROWSERLESS_TIMEOUT_MS } else { "840000" }
    $args = '["--ignore-certificate-errors","--ignore-certificate-errors-spki-list","--window-size=1920,1080","--force-device-scale-factor=1"]'
    # Starting many Chromium processes simultaneously can exhaust a 4 GB Docker
    # Desktop VM before any process exposes its DevTools endpoint. Keep a small
    # launch pool and queue the remaining orchestration requests.
    $concurrent = if ($env:BROWSERLESS_CONCURRENT) { $env:BROWSERLESS_CONCURRENT } else { "3" }
    $queued = if ($env:BROWSERLESS_QUEUED) { $env:BROWSERLESS_QUEUED } else { "20" }
    $dockerCmd = "docker run --rm -p 3000:3000 --shm-size=2g --dns 8.8.8.8 --dns 1.1.1.1 --add-host mstr-prod.bayer.com:54.84.130.141 --add-host mstr-qa.bayer.com:54.84.103.229 -e TOKEN=$token -e CONCURRENT=$concurrent -e QUEUED=$queued -e TIMEOUT=$timeoutMs -e CORS=true -e 'DEFAULT_LAUNCH_ARGS=$args' ghcr.io/browserless/chromium:v2.55.4"
    Start-ChildCommand $root $dockerCmd
    Wait-Port 3000 "Browserless" 180 | Out-Null
  }
}

# ------------------------------------------------------------------ SSO ------
if (-not $SkipSso) {
  Write-Step "Starting the Snowflake SSO sidecar (optional)"
  if (Test-Port 8002) { Write-Ok "already listening on 8002" }
  elseif (Test-Path (Join-Path $root "scripts\dev-sso.ps1")) {
    Start-Child (Join-Path $root "scripts\dev-sso.ps1")
    Wait-Port 8002 "Snowflake SSO" 60 | Out-Null
  }
  else { Write-Warn2 "scripts\dev-sso.ps1 not found - skipping (only needed for Snowflake queries)" }
}

# -------------------------------------------------------------- backend ------
Write-Step "Starting the Deno backend (edge functions on :8000)"
if (Test-Port 8000) {
  Write-Ok "already listening on 8000 - reusing it"
}
elseif (Test-Path (Join-Path $root "scripts\dev-backend.ps1")) {
  Start-Child (Join-Path $root "scripts\dev-backend.ps1")
  Wait-Port 8000 "Deno backend" 120 | Out-Null
}
else {
  $backend = Join-Path $root "backend"
  Start-ChildCommand $backend "deno run --unsafely-ignore-certificate-errors --allow-net --allow-env --allow-read --allow-write server.ts"
  Wait-Port 8000 "Deno backend" 120 | Out-Null
}

# health probe - the gateway exposes /healthz
try {
  $h = Invoke-WebRequest -Uri "http://127.0.0.1:8000/healthz" -TimeoutSec 5 -UseBasicParsing
  if ($h.StatusCode -eq 200) { Write-Ok "backend /healthz responded 200" }
} catch { Write-Warn2 "backend /healthz not answering yet - it may still be loading functions" }

# --------------------------------------------------------------- status ------
Write-Step "Service status"
$svc = @(
  @{ n = "Browserless"; p = 3000 },
  @{ n = "SSO sidecar"; p = 8002 },
  @{ n = "Deno backend"; p = 8000 }
)
$down = @()
foreach ($x in $svc) {
  if (Test-Port $x.p) { Write-Ok "$($x.n) listening on $($x.p)" }
  else { Write-Warn2 "$($x.n) NOT listening on $($x.p)"; $down += $x.n }
}
if ($down -contains "Deno backend") {
  Write-Host ""
  Write-Bad "The UI will load but every /functions/v1/* call fails with ECONNREFUSED."
  Write-Host "    Start the backend by hand in its own terminal and watch the error:" -ForegroundColor Yellow
  Write-Host "        cd `"$root\scripts`"; .\dev-backend.ps1" -ForegroundColor White
  Write-Host "    or directly:" -ForegroundColor Yellow
  Write-Host "        cd `"$root\backend`"; deno run --unsafely-ignore-certificate-errors --allow-net --allow-env --allow-read --allow-write server.ts" -ForegroundColor White
  Write-Host ""
}

# ------------------------------------------------------------- frontend ------
Write-Step "Starting the Vite frontend (foreground)"
Write-Host @"

  --------------------------------------------------
   UI            http://localhost:8080
   Backend       http://127.0.0.1:8000/healthz
   Browserless   http://127.0.0.1:3000/active?token=local-dev-token
   SSO sidecar   http://127.0.0.1:8002

   Health check (use curl.exe - bare 'curl' is Invoke-WebRequest in PowerShell):
     curl.exe "http://127.0.0.1:3000/active?token=local-dev-token"
     curl.exe http://127.0.0.1:8000/healthz
     curl.exe http://localhost:8080
  --------------------------------------------------

  After it loads: open a scenario -> Regenerate script.
  Newly generated scripts include the hardened RTB filter core
  (bounded label binding + verified picks + error-dialog guard).
  Stored scripts keep their old code until you regenerate them.

  Ctrl+C stops the frontend. Close the other windows to stop the rest.

"@ -ForegroundColor White

npm run dev
