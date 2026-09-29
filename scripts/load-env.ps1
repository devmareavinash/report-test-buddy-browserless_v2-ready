# Load repository .env values into the current PowerShell process.
$root = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$envFile = Join-Path $root ".env"

if (-not (Test-Path -LiteralPath $envFile)) {
  throw "Missing $envFile. Complete the .env file before starting local services."
}

foreach ($line in Get-Content -LiteralPath $envFile) {
  $text = $line.Trim()
  if (-not $text -or $text.StartsWith("#") -or $text -notmatch "=") { continue }
  $name, $value = $text -split "=", 2
  $name = $name.Trim()
  $value = $value.Trim()
  if (
    ($value.StartsWith('"') -and $value.EndsWith('"')) -or
    ($value.StartsWith("'") -and $value.EndsWith("'"))
  ) {
    $value = $value.Substring(1, $value.Length - 2)
  }
  if ($name) { Set-Item -Path "Env:$name" -Value $value }
}

if (-not $env:NO_PROXY) {
  $env:NO_PROXY = "127.0.0.1,localhost,chat.int.bayer.com"
}
if (-not $env:DENO_TLS_CA_STORE) {
  $env:DENO_TLS_CA_STORE = "system"
}
