docker build --progress=plain @Common `
  --build-arg "VITE_SUPABASE_URL=$env:VITE_SUPABASE_URL" `
  --build-arg "VITE_SUPABASE_PUBLISHABLE_KEY=$env:VITE_SUPABASE_PUBLISHABLE_KEY" `
  --build-arg "VITE_SUPABASE_PROJECT_ID=$env:VITE_SUPABASE_PROJECT_ID" `
  -f Dockerfile -t "rtb-web:$ReleaseTag" .
$WebExit = $LASTEXITCODE

docker build --progress=plain @Common -f backend/Dockerfile -t "rtb-backend:$ReleaseTag" .
$BackendExit = $LASTEXITCODE

docker build --progress=plain @Common -f backend/snowflake-sso/Dockerfile -t "rtb-snowflake-sso:$ReleaseTag" .
$SnowExit = $LASTEXITCODE

Write-Host "`n===== SUMMARY =====" -ForegroundColor Cyan
Write-Host "Tag: $ReleaseTag   Commit: $SourceCommit"
Write-Host "Web exit: $WebExit   Backend exit: $BackendExit   Snowflake exit: $SnowExit"
docker images --filter "reference=rtb-*:$ReleaseTag"