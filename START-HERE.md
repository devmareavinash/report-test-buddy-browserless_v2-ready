# RTB browserless_v2 ready folder

This archive contains the complete fixed source tree without `node_modules`,
build output, logs, or secrets.

## 1. Extract

Extract the archive to:

`C:\Users\EASXP\OneDrive - Bayer\Desktop\report-test-buddy-browserless_v2-ready`

## 2. Complete `.env`

Open `.env` and replace:

- `PASTE_EXISTING_ANON_KEY_HERE`
- `PASTE_EXISTING_SERVICE_ROLE_KEY_HERE`
- `PASTE_EXISTING_ANTHROPIC_KEY_HERE`

Copy those values from the `.env` belonging to your currently working app.

## 3. Install

```powershell
cd "C:\Users\EASXP\OneDrive - Bayer\Desktop\report-test-buddy-browserless_v2-ready"
npm install
```

`package-lock.json` is intentionally not included. `npm install` creates a fresh
lock file containing `cron-parser@4.9.0`.

## 4. Build

```powershell
npm run build
```

## 5. Start

```powershell
PowerShell -ExecutionPolicy Bypass -File .\run-rtb-local.ps1 `
  -RepoPath "C:\Users\EASXP\OneDrive - Bayer\Desktop\report-test-buddy-browserless_v2-ready"
```

This starts or reuses Browserless, Snowflake SSO, the Deno backend, and Vite.

Expected backend result:

`Backend listening on :8000 — 14/14 functions loaded`

## 6. Verify recent features

- Row-count generation produces approximately 56 KB.
- Tests execution status displays every configured filter combination.
- Scenario and combination Run buttons are visible.
- Filter combinations show `Apply all to report cases`.
- FE-to-BE mappings show `Save all for this report`.
