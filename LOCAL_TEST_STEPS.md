# RTB Local Validation

## Apply the files

Extract this archive directly into:

`C:\Users\EASXP\OneDrive - Bayer\Desktop\report-test-buddy-browserless_v2-ready\report-test-buddy-browserless_v2-ready`

Allow Windows to replace the matching files. This package contains code and
configuration changes only. It does not require a Supabase migration or manual
database change.

## Automated checks

```powershell
cd "C:\Users\EASXP\OneDrive - Bayer\Desktop\report-test-buddy-browserless_v2-ready\report-test-buddy-browserless_v2-ready"
npm test
npm run build
```

## Start local services

Use separate PowerShell windows.

### Snowflake SSO

```powershell
cd "C:\Users\EASXP\OneDrive - Bayer\Desktop\report-test-buddy-browserless_v2-ready\report-test-buddy-browserless_v2-ready"
.\scripts\dev-sso.ps1
```

### Backend

```powershell
cd "C:\Users\EASXP\OneDrive - Bayer\Desktop\report-test-buddy-browserless_v2-ready\report-test-buddy-browserless_v2-ready"
.\scripts\dev-backend.ps1
```

### Frontend

```powershell
cd "C:\Users\EASXP\OneDrive - Bayer\Desktop\report-test-buddy-browserless_v2-ready\report-test-buddy-browserless_v2-ready"
. .\scripts\load-env.ps1
npm run dev
```

Open `http://127.0.0.1:8080`.

## Result and history regression checks

1. Run one case from Tests Execution Status.
   - The Run page contains only that case.
   - No unrelated pending cases appear.
2. Confirm Latest Result and Tests Execution Status show the same KPIs.
3. Confirm Run Detail shows only configured KPIs.
   - No `ok`, `_grid_ready`, `_debug`, `_show_data`, or `_navigation` rows.
4. Run a passing reference comparison.
   - Tests Status, Latest Result, and Run Detail show PASS immediately.
   - Opening Latest Result is not required to synchronize the status.
5. Re-run one filter combination.
   - Other combinations retain their latest stored results.
6. Open an older completed run.
   - Its stored result remains visible.
   - It does not gain pending cases created after that run.
7. Open the September 25 HCO historical run.
   - Legacy `Row Count - View My HCO List` displays under configured KPI `Count`.
   - A stored PASS result does not render as Pending.
8. Validate a date comparison.
   - Actual and Reference display as date text in Latest Result and Run Detail.
   - Equal normalized dates pass; different dates fail.
9. Force a missing FE-to-BE mapping, internal function failure, Playwright error,
   or timeout.
   - The run shows an explicit failure.
   - It does not remain running or show a blank failed `0 passed / 0 failed` run.
10. Run a case with multiple filter combinations.
    - Dashboard, All Tests, Tests Execution Status, Latest Result, and Run Detail
      show the same aggregate status.

## Multi-user execution-lock checks

Use two browsers or one normal window and one private window, signed in as two
users.

1. User A starts one case.
   - User B sees that case as Running within about three seconds.
   - Its Run button is disabled.
   - The containing screen and report Run buttons are also disabled.
2. While that case is running, User B tries the same case using a page that has
   not refreshed yet.
   - The backend rejects the duplicate.
   - The message includes the active run's short ID.
3. User A starts a screen.
   - User B sees that screen as Running.
   - Every case in that screen is disabled.
   - The containing report is disabled.
4. User A starts a complete report.
   - User B sees the report as Running.
   - All descendant screen and case Run buttons are disabled.
5. When each run completes or fails:
   - The Running state disappears within about three seconds.
   - The corresponding Run buttons become available again.
6. Start the same entity from both users at nearly the same time.
   - Only the deterministic winning run proceeds.
   - The other run is cancelled/rejected before its scenarios execute.

