[CmdletBinding()]
param()

$ErrorActionPreference = "Stop"
$root = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$envFile = Join-Path $root ".env"

if (-not (Test-Path $envFile)) {
  Write-Error "Missing $envFile. Copy .env.example to .env and fill the required keys."
  exit 1
}

foreach ($line in Get-Content $envFile) {
  $t = $line.Trim()
  if (-not $t -or $t.StartsWith("#") -or $t -notmatch "=") { continue }
  $name, $value = $t -split "=", 2
  $name = $name.Trim()
  $value = $value.Trim().Trim('"').Trim("'")
  if ($name) { Set-Item -Path "Env:$name" -Value $value }
}

if (-not $env:SNOWFLAKE_SSO_URL) { $env:SNOWFLAKE_SSO_URL = "http://127.0.0.1:8002" }
if (-not $env:LOCAL_FUNCTIONS_URL) { $env:LOCAL_FUNCTIONS_URL = "http://127.0.0.1:8000/functions/v1" }
if (-not $env:BROWSERLESS_HOST) { $env:BROWSERLESS_HOST = "http://127.0.0.1:3000" }
if (-not $env:NO_PROXY) { $env:NO_PROXY = "127.0.0.1,localhost,chat.int.bayer.com" }
if (-not $env:DENO_TLS_CA_STORE) { $env:DENO_TLS_CA_STORE = "system" }

Write-Host "Starting Deno backend on http://localhost:8000" -ForegroundColor Cyan
Write-Host "  SNOWFLAKE_SSO_URL   = $env:SNOWFLAKE_SSO_URL"
Write-Host "  LOCAL_FUNCTIONS_URL = $env:LOCAL_FUNCTIONS_URL"
Write-Host "  BROWSERLESS_HOST    = $env:BROWSERLESS_HOST"
Write-Host "  BROWSERLESS_TOKEN   = $(if ($env:BROWSERLESS_TOKEN) { '(set)' } else { '(missing)' })"
Write-Host "  HTTP_PROXY          = $env:HTTP_PROXY"
Write-Host "  NO_PROXY            = $env:NO_PROXY"
Write-Host "  DENO_TLS_CA_STORE   = $env:DENO_TLS_CA_STORE"

Set-Location (Join-Path $root "backend")
deno run `
  --unsafely-ignore-certificate-errors `
  --allow-net `
  --allow-env `
  --allow-read `
  --allow-write `
  server.ts
