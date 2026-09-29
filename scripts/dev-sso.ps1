# Start Snowflake SSO Python service on :8002 (browser login on this VDI)
$ErrorActionPreference = "Stop"
. (Join-Path $PSScriptRoot "load-env.ps1")

$root = Join-Path $PSScriptRoot ".."
$venv = Join-Path $root ".venv"
$python = Join-Path $venv "Scripts\python.exe"
$uvicorn = Join-Path $venv "Scripts\uvicorn.exe"

# Windows ships a "python.exe" App-Execution-Alias that only opens the Microsoft
# Store. `python -m venv` then prints "Python was not found", creates nothing,
# and every later call fails with a confusing "term not recognized" against a
# venv path that never existed. Detect a REAL interpreter before doing anything.
function Get-RealPython {
  foreach ($candidate in @("python", "python3", "py")) {
    $cmd = Get-Command $candidate -ErrorAction SilentlyContinue
    if (-not $cmd) { continue }
    if ($cmd.Source -and $cmd.Source -like "*\WindowsApps\*") { continue }
    try {
      $v = & $candidate --version 2>&1
      if ($LASTEXITCODE -eq 0 -and "$v" -match "Python\s+3\.(\d+)") {
        if ([int]$Matches[1] -ge 9) { return $candidate }
        Write-Host "  Found $v - Python 3.9+ required." -ForegroundColor Yellow
      }
    } catch { }
  }
  return $null
}

if (-not (Test-Path $python)) {
  $py = Get-RealPython
  if (-not $py) {
    Write-Host ""
    Write-Host "  Python 3.9+ was not found." -ForegroundColor Red
    Write-Host ""
    Write-Host "  The 'python' on PATH is the Microsoft Store alias, which cannot create a venv."
    Write-Host ""
    Write-Host "  Install it:" -ForegroundColor Yellow
    Write-Host "      winget install Python.Python.3.12"
    Write-Host "  Then close and reopen PowerShell and re-run this script."
    Write-Host ""
    Write-Host "  If 'python --version' still opens the Store, disable the alias:" -ForegroundColor Yellow
    Write-Host "      Settings > Apps > Advanced app settings > App execution aliases"
    Write-Host "      turn OFF python.exe and python3.exe"
    Write-Host ""
    Write-Host "  The SSO sidecar is OPTIONAL - it is only needed for Snowflake"
    Write-Host "  warehouse queries. The UI, script generation and Playwright runs"
    Write-Host "  all work without it. Start the rest with:"
    Write-Host "      .\run-rtb-local.ps1 -SkipSso"
    Write-Host ""
    exit 1
  }

  Write-Host "Creating Python venv using '$py'..."
  Push-Location $root
  try {
    & $py -m venv .venv
    if ($LASTEXITCODE -ne 0 -or -not (Test-Path $python)) {
      Write-Host "  venv creation failed. If this repo sits in a synced OneDrive folder," -ForegroundColor Red
      Write-Host "  pause OneDrive sync and try again - it can lock files mid-install." -ForegroundColor Red
      exit 1
    }
    & $python -m pip install --upgrade pip
    & $python -m pip install -r backend\snowflake-sso\requirements.txt
    if ($LASTEXITCODE -ne 0) {
      Write-Host "  pip install failed." -ForegroundColor Red
      Write-Host "  Behind the corporate proxy, retry with:" -ForegroundColor Yellow
      Write-Host "      `$env:HTTPS_PROXY='http://10.185.190.10:8080'"
      Write-Host "      .venv\Scripts\python.exe -m pip install -r backend\snowflake-sso\requirements.txt"
      exit 1
    }
  } finally {
    Pop-Location
  }
}

if (-not (Test-Path $uvicorn)) {
  Write-Host "  uvicorn is missing from the venv. Reinstall the requirements:" -ForegroundColor Red
  Write-Host "      .venv\Scripts\python.exe -m pip install -r backend\snowflake-sso\requirements.txt"
  exit 1
}

Write-Host "Starting Snowflake SSO on http://localhost:8002"
Write-Host "  Browser login will open on THIS machine (VDI)."
Write-Host "  Health: curl.exe http://127.0.0.1:8002/healthz"

Push-Location $root
try {
  & $uvicorn backend.snowflake-sso.app:app --host 0.0.0.0 --port 8002
} finally {
  Pop-Location
}
