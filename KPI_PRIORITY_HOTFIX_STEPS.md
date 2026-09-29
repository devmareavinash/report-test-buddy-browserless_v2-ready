# KPI Priority Hotfix

Extract this archive into the authoritative RTB repository and replace the
matching files:

`C:\Users\EASXP\OneDrive - Bayer\Desktop\report-test-buddy-browserless_v2-ready\report-test-buddy-browserless_v2-ready`

No Supabase migration or manual database change is required.

Run:

```powershell
npm test
npm run build
```

Then restart the frontend and backend, refresh Tests Execution Status, and
expand the affected case.

Expected:

- Tests Execution Status uses the KPI configuration from Latest Result.
- The configured KPI is displayed as `Count`.
- Extractor metadata such as `_grid_ready` is not displayed as a KPI.
- Selecting **Sync to last run** replaces stored raw extractor KPI keys with
  the configured Latest Result KPI values.

