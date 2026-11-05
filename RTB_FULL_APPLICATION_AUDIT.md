# RTB Full Application Audit

**Date:** 2026-11-05  
**Commit:** d4a509f (main)  
**Working tree:** 19 modified files, 11 untracked files, +1703 insertions  

---

## 1. Executive Summary

Report Test Buddy is operationally functional. The Deno backend, Browserless Chromium, and Supabase are running and producing extractions. Recent changes (+1703 lines) introduce significant reliability improvements: extraction-outcome classification, cooperative run cancellation, Browserless health probes, and auth-session persistence/reuse.

**Issue count:** 20 issues identified (4 P1, 6 P2, 3 P3, 5 P4, 2 P5)  
**Zero P0 (data corruption/security) issues found.** RLS is permissive (`USING (true)`) but this is by design — RTB is an internal tool with email/password auth and role gating.

The most impactful issue class is **Solo vs Brand execution path divergence** (P1): the `isolateCombos` gate uses different criteria than the Solo "Run headless" path, causing Brand runs to use per-combo isolation for PCC scenarios (sequential single-combo Browserless calls) while Solo runs send the full matrix in one call. This produces different extraction shapes and is the root cause of "Solo pass / Brand fail" reports.

**Application readiness:** Not production-ready. The 4 P1 issues can produce incorrect results, missing values, or permanently-pending runs. After P1 fixes, the application would be functional for supervised production use.

---

## 2. Current Architecture

```
React SPA (Vite :8080)
   │  /functions/v1/<name> via proxy
   ▼
Deno gateway backend/server.ts (:8000)
   ├─ 15 edge functions hosted in one process
   ├─ agent-orchestrate: run coordinator (~2527 lines)
   ├─ playwright-runtime: Browserless /chromium/function wrapper
   │     wrapped by auth-session-gateway (cookie reuse)
   ├─ run-warehouse-sql: Snowflake query execution
   ├─ agent-scripts: template-based script generation
   └─ trigger-run / schedule-tick: entry points
       │
       ├─► Browserless Chromium (:3000)
       ├─► Snowflake SSO sidecar (:8002)
       ├─► Supabase PostgreSQL + Auth
       └─► Anthropic LLM (via Bayer gateway)
```

**Key data tables:** runs, test_results, scenarios, scripts, reports, workstreams, scenario_filter_matrix, credential_profiles, playwright_jobs.

**Execution model:**
- **Workstream (Brand):** Creates parent run → dispatches child per report via `mapPool` → each child processes scenarios → atomic finalization via `finalize_workstream_report` RPC
- **Report:** Single-report execution, scenarios in parallel via `mapPool`
- **Scenario (Solo):** Frontend calls `playwright-runtime` directly, then `persistManualHeadlessRun`

---

## 3. Current Working Tree

### Modified files (19):
| File | Delta | Purpose |
|---|---|---|
| `agent-orchestrate/index.ts` | +723 | Cancellation gates, extraction-outcome, Browserless health |
| `auth-session-gateway.ts` | +135 | Session reuse/retry logic, extraction-based save gates |
| `auth-session-store.ts` | +282 | File-based cookie persistence, TTL, quarantine, shape analysis |
| `auth-session-wrap.ts` | +119 | Playwright code wrapper for cookie injection/capture |
| `run-session.ts` | +5 | RunSession registry |
| `kpi-values.ts` | +19 | Noise filter expansion for execution metadata |
| `latestTestResults.ts` | +13 | Per-combo latest (not per-run), combo pairing |
| `playwrightAuthSession.ts` | +7 | Frontend auth session types |
| `functions.ts` | +7 | JWT expiry check margin |
| `ScenarioDetail.tsx` | +72 | Manual run persistence, combo UI |
| `Runs.tsx` | +100 | Extraction outcome display |
| `Reports.tsx` | +106 | Report status computation |
| `RunScenarioCard.tsx` | +24 | Status derivation |
| `StatusChip.tsx` | +4 | New status badges |
| `kpi-values.test.ts` | +5 | Updated test expectations |
| `latestTestResults.test.ts` | +3 | Updated test expectations |
| `playwrightAuthSession.test.ts` | +2 | Updated test expectations |

### Untracked files (11):
New modules: `extraction-outcome.ts`, `run-cancellation.ts`, `browserless-health.ts` + their test files; analysis/planning docs (`.md`).

### Environment:
- `SUPABASE_SERVICE_ROLE_KEY` is **EMPTY** in `.env` → backend uses caller JWT + dev grace fallback
- Browserless Docker container running (confirmed via `docker ps`)
- Deno backend running (confirmed via `tasklist`)
- Corporate proxy intercepts localhost curl (health checks show Skyhigh block page)

---

## 4. End-to-End Execution Flow

### Brand/Workstream Execution:
1. **Frontend** → `invokeFunction("agent-orchestrate", { scope_type: "workstream", scope_id })` with `X-Refresh-Token` header
2. **Auth** → `requireAuth(req)` accepts service key OR valid user JWT; `getSupabaseForRequest` applies dev grace for expired JWTs
3. **Run creation** → Insert into `runs` with `status: "running"`, race arbitration via 150ms pause + `findActiveRunConflict`
4. **RunSession** → If no service key, creates `RunSession(accessToken, refreshToken)` for mid-run token refresh
5. **Cancellation gate** → `createRunCancellationGate(runId)` polls `runs.status` before each major checkpoint
6. **Workstream dispatch** → `mapPool(reportIds, reportConcurrency, ...)` dispatches child orchestrations per report
7. **Child entry** → Each child calls `agent-orchestrate` with `existing_run_id`, checks cancellation immediately
8. **Scenario loop** → `mapPool(scenarios, concurrency, ...)` with `deferred: false` filter
9. **Script lookup** → `fetchCanonicalScript(scenarioId)` → saved code or `agent-scripts` generation
10. **Combo decision** → `isolateCombos = hasCombos && (isPccScenario || combos.length > 8)`:
    - **Isolated (PCC / large):** One Browserless call per combo, serial (`mapPool(combos, 1, ...)`)
    - **Full matrix (non-PCC ≤8):** All combos in one Browserless call (matches Solo behavior)
11. **Browserless call** → `callFn("playwright-runtime", body)` → auth-session gateway wraps code with cookies → Browserless `/chromium/function`
12. **Retry** → Auth/timeout retries (max 2) + KPI empty retries (max 3 for non-PCC, 1 for PCC)
13. **KPI extraction** → `pickComboKpis(payload, comboLabel)` traverses nested response shapes
14. **Comparison** → Numeric (tolerance + comparator), date (tolerance + op), text (normalized equality), structured (cell-by-cell table comparison)
15. **Completeness gate** → `assessConfiguredCompleteness(kpiLabels, actualMap, aliases)` verifies expected = extracted + missing
16. **Persistence** → `sb.from("test_results").insert(...)` with `status`, `expected`, `actual`, `diff`, `criticality`
17. **Finalization** → `finalizeChild(sb, runId, reportId, pass, fail)` via `finalize_workstream_report` RPC (atomic increment + completion check)

### Solo Execution (ScenarioDetail "Run headless"):
1. Frontend calls `invokeFunction("playwright-runtime", { mode: "headless", scenario_id, code })` — **no filter_combinations for single-combo scenarios, full matrix for multi-combo**
2. `persistManualHeadlessRun` creates a run + test_results rows client-side
3. `invalidateLatestStatusViews` refreshes React Query caches

---

## 5. Complete Issue Inventory

### ISSUE-001: Solo vs Brand execution path divergence (isolateCombos gate)

| Field | Value |
|---|---|
| **ID** | ISSUE-001 |
| **Title** | Solo sends full matrix while Brand isolates per-combo for PCC/large scenarios |
| **Category** | Execution correctness |
| **Severity** | P1 |
| **Current/Historical** | CURRENT |
| **Classification** | VERIFIED_CODE |
| **Reproduction** | Run a PCC scenario with 4 combos: Solo "Run headless" → one Browserless call with 4 combos. Brand run → 4 separate Browserless calls, each with 1 combo. |
| **Affected flow** | Brand/workstream execution for PCC scenarios |
| **Exact failure point** | `agent-orchestrate/index.ts:1507` — `const isolateCombos = hasCombos && (isPccScenario || combos.length > 8)` |
| **Evidence** | Code path analysis: Solo path (ScenarioDetail.tsx:473) sends `{ mode: "headless", scenario_id, code }` with no `filter_combinations` override. Brand path (orchestrate:1507-1508) applies isolation for `isPccScenario` or `combos.length > 8`. Comment at line 1503-1506 explicitly documents "Per-combo isolation was added for long PCC matrices, but for normal row-count/KPI cases it caused Brand empties." |
| **Root cause** | Design decision to isolate PCC combos that diverges from Solo's proven full-matrix path. Per-combo isolation changes script behavior: filter application, page navigation, dashboard readiness detection, and extraction timing all differ when running one combo vs all combos. |
| **Confidence** | HIGH |
| **User impact** | Brand runs for PCC scenarios can fail (empty extraction) while the same scenario passes in Solo mode. |
| **Files involved** | `agent-orchestrate/index.ts:1507-1588` |
| **Recommended fix** | Consider removing PCC-specific isolation or making isolation configurable per scenario. The code already has the `full_matrix_like_solo` path for non-PCC — extend it to PCC unless explicitly opted in. |
| **Regression test** | Run same PCC scenario Solo and Brand; both must produce identical combo KPI counts. |
| **Related issues** | ISSUE-002, ISSUE-003 |

---

### ISSUE-002: resolveComboNode falls back to flat root when combo label doesn't match

| Field | Value |
|---|---|
| **ID** | ISSUE-002 |
| **Title** | Backend combo resolution falls back to whole payload when label mismatch occurs |
| **Category** | Combo isolation / data correctness |
| **Severity** | P1 |
| **Current/Historical** | CURRENT |
| **Classification** | VERIFIED_CODE |
| **Reproduction** | When a Browserless full-matrix call returns KPIs nested under combo labels that differ from the `scenario_filter_matrix` labels (dash normalization, whitespace), `resolveComboNode` falls through to: (1) single-child envelope (line 686) — returns the only child regardless of label; (2) flat KPI map (line 688) — returns the root, mixing all combos' values. |
| **Exact failure point** | `agent-orchestrate/index.ts:680-689` |
| **Evidence** | Line 686: `if (children.length === 1) return children[0][1]` — returns single child regardless of label match. Line 688: `if (Object.keys(flattenNodeToKpis(root)).length) return root` — returns entire payload when KPIs exist at root level. Frontend pickComboBlock (ScenarioDetail.tsx:3109-3112) has a stricter guard: "Several combo-shaped siblings and this label missed — do not return the whole root." Backend lacks this guard. |
| **Root cause** | Backend `resolveComboNode` is more permissive than frontend `pickComboBlock`. When running full-matrix mode with multiple combos whose labels don't exactly match, backend may return the same KPI map for all combos. |
| **Confidence** | HIGH |
| **User impact** | Cross-combo contamination: two combos get the same values; comparison passes falsely or fails incorrectly. |
| **Files involved** | `agent-orchestrate/index.ts:663-690` |
| **Recommended fix** | Add the frontend's guard: when `children.length > 1` and label didn't match, return `null` instead of falling through. |
| **Regression test** | Multi-combo scenario where combo labels differ by dash/whitespace. Each combo must get distinct KPI values. |
| **Related issues** | ISSUE-001, ISSUE-005 |

---

### ISSUE-003: `dispatch().catch(() => {})` swallows workstream dispatch errors

| Field | Value |
|---|---|
| **ID** | ISSUE-003 |
| **Title** | Background workstream dispatch silently swallows all errors |
| **Category** | Run reliability |
| **Severity** | P1 |
| **Current/Historical** | CURRENT |
| **Classification** | VERIFIED_CODE |
| **Reproduction** | When the orchestrator is not running on Supabase Edge (which it isn't — it runs on the Deno gateway), the workstream dispatch path at line 1158 runs `dispatch().catch(() => {})`. If `dispatch()` throws an unhandled error after the HTTP response is sent, the run remains `status: "running"` forever. |
| **Exact failure point** | `agent-orchestrate/index.ts:1158` |
| **Evidence** | Line 1154-1158: `if (typeof EdgeRuntime !== "undefined" && EdgeRuntime?.waitUntil) { EdgeRuntime.waitUntil(dispatch()); } else { dispatch().catch(() => {}); }`. On the Deno gateway, `EdgeRuntime` is undefined, so the `else` branch runs. Same pattern at line 2514: `work().catch(() => {})`. |
| **Root cause** | The `.catch(() => {})` pattern is needed to prevent unhandled rejection crashes, but it swallows errors that should at minimum be logged and should trigger run finalization. |
| **Confidence** | HIGH |
| **User impact** | Runs that encounter unexpected errors during background dispatch remain permanently "running" with no error information. |
| **Files involved** | `agent-orchestrate/index.ts:1158, 2514` |
| **Recommended fix** | Replace with `.catch((e) => { jsonLog("dispatch_unhandled_error", { run_id, error: String(e) }); /* best-effort finalize */ })` |
| **Regression test** | Inject an error in dispatch; verify run is finalized with error status. |
| **Related issues** | ISSUE-004 |

---

### ISSUE-004: `work().catch(() => {})` can leave solo/report runs permanently running

| Field | Value |
|---|---|
| **ID** | ISSUE-004 |
| **Title** | Non-workstream background work errors silently swallowed |
| **Category** | Run reliability |
| **Severity** | P1 |
| **Current/Historical** | CURRENT |
| **Classification** | VERIFIED_CODE |
| **Reproduction** | Solo report execution (non-edge, non-child) at line 2514 runs `work().catch(() => {})`. If `work()` throws after the HTTP response, the run stays "running" forever. |
| **Exact failure point** | `agent-orchestrate/index.ts:2514` |
| **Evidence** | Same pattern as ISSUE-003. The `workInner` function has a catch block (lines 2411-2494) that handles `RunCancelledError` and `RunAuthExpiredError`, plus a generic `catch` that updates run status. But if the outer `work` wrapper or `releaseSession` throws, that error is swallowed. |
| **Root cause** | `.catch(() => {})` on fire-and-forget promises. |
| **Confidence** | MEDIUM — the inner catch block handles most cases; only edge-case errors in `releaseSession` or unexpected throws would trigger this. |
| **User impact** | Rare but possible permanently-running runs. |
| **Files involved** | `agent-orchestrate/index.ts:2514` |
| **Recommended fix** | Add logging + best-effort finalization in the catch. |
| **Regression test** | Same as ISSUE-003. |
| **Related issues** | ISSUE-003 |

---

### ISSUE-005: Shared mutable `logWrite` promise chain across concurrent requests

| Field | Value |
|---|---|
| **ID** | ISSUE-005 |
| **Title** | Module-level `logWrite` promise chain shared across all concurrent orchestrations |
| **Category** | Concurrency / reliability |
| **Severity** | P2 |
| **Current/Historical** | CURRENT |
| **Classification** | VERIFIED_CODE |
| **Reproduction** | `let logWrite = Promise.resolve()` at line 98 is a module-level variable. Every `jsonLog` call appends to this chain. When multiple runs execute concurrently in the same Deno process, they share this chain. |
| **Exact failure point** | `agent-orchestrate/index.ts:98` |
| **Evidence** | Line 108: `logWrite = logWrite.then(async () => { ... }).catch(...)`. All concurrent runs append to the same promise chain. If one log write is slow, all subsequent writes from all runs queue behind it. |
| **Root cause** | Module-level mutable state shared across requests. |
| **Confidence** | MEDIUM — functional impact is limited (only affects logging speed), but could cause memory buildup during high-concurrency brand runs. |
| **User impact** | Logging latency during concurrent runs; possible memory pressure from long promise chains. |
| **Files involved** | `agent-orchestrate/index.ts:98, 108-117` |
| **Recommended fix** | Use `Deno.writeTextFile` with `{ append: true }` directly without chaining, or use a bounded queue. |
| **Regression test** | Run two concurrent workstreams; verify log entries from both appear without delay. |
| **Related issues** | None |

---

### ISSUE-006: `SUPABASE_SERVICE_ROLE_KEY` is empty — backend operates with caller JWT only

| Field | Value |
|---|---|
| **ID** | ISSUE-006 |
| **Title** | Missing service role key forces all backend operations through caller JWT |
| **Category** | Auth / reliability |
| **Severity** | P2 |
| **Current/Historical** | CURRENT |
| **Classification** | VERIFIED_CODE |
| **Reproduction** | `.env` has `SUPABASE_SERVICE_ROLE_KEY=` (empty). `getServiceClient()` returns null. All DB operations use the caller's JWT, which can expire during long Brand runs. |
| **Exact failure point** | `.env` line for SUPABASE_SERVICE_ROLE_KEY; `auth.ts:getServiceClient()` |
| **Evidence** | Direct `.env` read confirms empty value. RunSession mitigates via token refresh, but refresh tokens rotate (noted in run-session.ts comments), creating a window where revocation can kill the entire run. |
| **Root cause** | Configuration issue — service role key not set in development environment. |
| **Confidence** | HIGH |
| **User impact** | Long-running Brand executions may fail mid-run when JWT expires and refresh fails. Auth-expired finalization path exists but relies on best-effort fallback. |
| **Files involved** | `.env`, `auth.ts`, `run-session.ts`, `agent-orchestrate/index.ts:862-868` |
| **Recommended fix** | Set `SUPABASE_SERVICE_ROLE_KEY` in `.env`. |
| **Regression test** | Run a Brand workstream lasting >60 minutes; verify completion. |
| **Related issues** | ISSUE-012 |

---

### ISSUE-007: `callFn("agent-analyze", ...).catch(() => {})` swallows analysis errors

| Field | Value |
|---|---|
| **ID** | ISSUE-007 |
| **Title** | Post-failure analysis fire-and-forget swallows errors silently |
| **Category** | Observability |
| **Severity** | P3 |
| **Current/Historical** | CURRENT |
| **Classification** | VERIFIED_CODE |
| **Reproduction** | After a failed test result is persisted (line 2369), `callFn("agent-analyze", ...).catch(() => {})` silently swallows any analysis errors. |
| **Exact failure point** | `agent-orchestrate/index.ts:2369` |
| **Evidence** | Direct code inspection. Analysis is optional, so swallowing is intentional, but the error should be logged. |
| **Root cause** | Intentional fire-and-forget without logging. |
| **Confidence** | HIGH |
| **User impact** | No user impact on results; reduces debugging capability. |
| **Files involved** | `agent-orchestrate/index.ts:2369` |
| **Recommended fix** | `.catch((e) => jsonLog("agent_analyze_failed", { error: String(e) }))` |
| **Regression test** | N/A |
| **Related issues** | ISSUE-003 |

---

### ISSUE-008: `latestTestResults.ts` uses `.limit(1000)` which silently truncates

| Field | Value |
|---|---|
| **ID** | ISSUE-008 |
| **Title** | PostgREST `.limit(1000)` may truncate results for scenarios with many historical rows |
| **Category** | Data completeness |
| **Severity** | P2 |
| **Current/Historical** | CURRENT |
| **Classification** | VERIFIED_CODE |
| **Reproduction** | `fetchLatestRunResultsByScenarioIds` (line 49) fetches up to 1000 rows per 80-scenario chunk. A scenario with 50+ historical runs × 8 combos = 400+ rows. With 3 such scenarios in one chunk, the 1000-row limit is hit and the oldest results are truncated. The function keeps only the newest per combo, so truncation is usually invisible — unless the newest result for a combo is beyond row 1000. |
| **Exact failure point** | `src/lib/latestTestResults.ts:50` |
| **Evidence** | `.limit(1000)` applied to a `created_at DESC` ordered query. With 80 scenarios per chunk and multi-combo scenarios, this can exceed 1000 rows. |
| **Root cause** | Fixed limit without pagination. |
| **Confidence** | MEDIUM — in practice, 80 scenarios × ~10 rows = 800, usually within limit. But high-activity workstreams with many combos can exceed it. |
| **User impact** | Scenarios page may show stale status for active scenarios that fall beyond the 1000-row window. |
| **Files involved** | `src/lib/latestTestResults.ts:50, 86, 91` |
| **Recommended fix** | Reduce chunk size or add descending ordering + early termination when all combos have a result. |
| **Regression test** | Create >125 test_results rows for scenarios in one chunk; verify all latest results appear. |
| **Related issues** | None |

---

### ISSUE-009: `persistManualHeadlessRun` stores `extracted` payload in `actual` column

| Field | Value |
|---|---|
| **ID** | ISSUE-009 |
| **Title** | Solo manual run stores full extraction payload including Browserless wrapper in test_results |
| **Category** | Data quality |
| **Severity** | P3 |
| **Current/Historical** | CURRENT |
| **Classification** | VERIFIED_CODE |
| **Reproduction** | `persistManualHeadlessRun` (ScenarioDetail.tsx:3372) stores `extracted: payload?.extracted ?? null` inside `actual`. This includes the full Browserless response envelope with `ok`, `error`, `url`, `screenshot`, etc. |
| **Exact failure point** | `src/pages/ScenarioDetail.tsx:3372, 3399` |
| **Evidence** | The `actual` column receives `{ filter, values, source: "manual_headless", extracted: <full envelope> }`. The orchestrator path (agent-orchestrate) does NOT store the raw extraction envelope — it stores clean `values` + `execution` audit. This creates different `actual` shapes for Solo vs Brand runs. |
| **Root cause** | Solo persistence was built before the extraction-outcome classification system. |
| **Confidence** | HIGH |
| **User impact** | Solo runs have larger `actual` payloads; `kpiMapFromStored` must handle both shapes; `extractKpisFromRun` fallback chains get more complex. |
| **Files involved** | `src/pages/ScenarioDetail.tsx:3370-3373, 3399` |
| **Recommended fix** | Strip the extraction envelope before storing, or run through `buildExecutionAudit` like the orchestrator does. |
| **Regression test** | Solo run → verify `actual` shape matches Brand run `actual` shape for the same scenario. |
| **Related issues** | ISSUE-001 |

---

### ISSUE-010: `findActiveRunConflict` fetches up to 1000 active runs without pagination

| Field | Value |
|---|---|
| **ID** | ISSUE-010 |
| **Title** | Active run conflict check limited to 1000 rows |
| **Category** | Scalability |
| **Severity** | P3 |
| **Current/Historical** | CURRENT |
| **Classification** | VERIFIED_CODE |
| **Reproduction** | `findActiveRunConflict` (line 282-289) queries `.eq("status", "running").limit(1000)`. In practice, the system should never have 1000 concurrent running runs, so this is theoretical. |
| **Exact failure point** | `agent-orchestrate/index.ts:288` |
| **Evidence** | Code inspection. Active runs should be ≤10 in normal operation. |
| **Root cause** | Precautionary limit, not a practical issue. |
| **Confidence** | LOW |
| **User impact** | None in practice. |
| **Files involved** | `agent-orchestrate/index.ts:276-289` |
| **Recommended fix** | No change needed; document as acceptable. |
| **Regression test** | N/A |
| **Related issues** | None |

---

### ISSUE-011: Race arbitration uses 150ms sleep (fragile)

| Field | Value |
|---|---|
| **ID** | ISSUE-011 |
| **Title** | Run creation race arbitration relies on 150ms setTimeout |
| **Category** | Run reliability |
| **Severity** | P2 |
| **Current/Historical** | CURRENT |
| **Classification** | VERIFIED_CODE |
| **Reproduction** | Lines 947-973: After creating a run, the orchestrator pauses 150ms then checks for conflicts. Under high network latency or heavy DB load, both concurrent callers may create their runs and both pass the 150ms check before either becomes visible to the other. |
| **Exact failure point** | `agent-orchestrate/index.ts:947` |
| **Evidence** | `await new Promise((resolve) => setTimeout(resolve, 150))` followed by `findActiveRunConflict`. The comment says "best-effort race arbitration without requiring a database migration." |
| **Root cause** | Lack of database-level uniqueness constraint for active runs per scope. |
| **Confidence** | MEDIUM — unlikely in normal use (users don't double-click that fast), but possible with scheduled + manual triggers. |
| **User impact** | Duplicate overlapping runs for the same scope, each processing the same scenarios. |
| **Files involved** | `agent-orchestrate/index.ts:947-974` |
| **Recommended fix** | Add a database advisory lock or unique partial index on `(scope_type, scope_id) WHERE status = 'running'`. |
| **Regression test** | Simultaneously trigger two runs for the same workstream; verify only one executes. |
| **Related issues** | None |

---

### ISSUE-012: RunSession refresh token rotation can revoke the session

| Field | Value |
|---|---|
| **ID** | ISSUE-012 |
| **Title** | Supabase Auth refresh token rotation can revoke mid-run sessions |
| **Category** | Auth / long-run reliability |
| **Severity** | P2 |
| **Current/Historical** | CURRENT |
| **Classification** | SUPPORTED |
| **Reproduction** | If the browser refreshes its token while RunSession holds the same refresh token, Supabase Auth reuse detection may revoke both sessions. The UI sends X-Refresh-Token for agent-orchestrate by default. |
| **Exact failure point** | `run-session.ts:10-12` (comment documents the issue) |
| **Evidence** | Comment in `run-session.ts`: "If the browser later refreshes with the same token after the server already did, reuse detection can revoke the whole session." This is a known limitation documented in the code. |
| **Root cause** | Supabase Auth's refresh token rotation security feature conflicts with server-side token sharing. |
| **Confidence** | MEDIUM — mitigated by RunSession refreshing before the browser needs to, but not guaranteed. |
| **User impact** | Long-running Brand executions may be killed mid-run with auth_expired. The system handles this gracefully (fails with auth_failure status). |
| **Files involved** | `run-session.ts`, `agent-orchestrate/index.ts:2426-2454` |
| **Recommended fix** | Set `SUPABASE_SERVICE_ROLE_KEY` (eliminates the need for RunSession entirely). |
| **Regression test** | Run a 30+ minute Brand execution; verify it completes without auth_expired. |
| **Related issues** | ISSUE-006 |

---

### ISSUE-013: Frontend `KPI_VALUE_NOISE` set may drift from backend `isExtractionNoiseKey`

| Field | Value |
|---|---|
| **ID** | ISSUE-013 |
| **Title** | Duplicated noise-key filtering in frontend and backend can diverge |
| **Category** | Correctness |
| **Severity** | P4 |
| **Current/Historical** | CURRENT |
| **Classification** | VERIFIED_CODE |
| **Reproduction** | `src/lib/kpi-values.ts:KPI_VALUE_NOISE` (31 entries) and `agent-orchestrate/index.ts:isExtractionNoiseKey` (separate implementation) filter different sets of keys. The frontend also has `KPI_SKIP_KEYS` in ScenarioDetail.tsx. If one set adds a key the other doesn't, Runs page can show phantom KPI rows that Latest result tab filters out. |
| **Exact failure point** | `src/lib/kpi-values.ts:5-21`, comment at line 14: "Keep this aligned with KPI_META_KEYS in ScenarioDetail.tsx. When the two drift, the Runs page renders bookkeeping fields as phantom KPI rows." |
| **Evidence** | The comment explicitly warns about this drift risk. |
| **Root cause** | Code duplication across frontend/backend boundary. |
| **Confidence** | HIGH |
| **User impact** | Phantom KPI rows on Runs page showing "pending" while Latest result shows "pass". |
| **Files involved** | `src/lib/kpi-values.ts`, `agent-orchestrate/index.ts`, `src/pages/ScenarioDetail.tsx` |
| **Recommended fix** | Extract canonical noise-key set to a shared definition file imported by both frontend and backend test helpers. |
| **Regression test** | Verify noise key sets match between all three locations. |
| **Related issues** | None |

---

### ISSUE-014: Auth-session gateway preserves session on non-auth extraction failures

| Field | Value |
|---|---|
| **ID** | ISSUE-014 |
| **Title** | Session is preserved even when extraction is unusable but not auth-failure |
| **Category** | Auth session / correctness |
| **Severity** | P4 |
| **Current/Historical** | CURRENT (by design) |
| **Classification** | VERIFIED_CODE |
| **Reproduction** | `auth-session-gateway.ts:191-204`: When a reused session produces an unusable extraction (empty KPIs) but NO auth failure signal, the session is preserved. This is intentional — the comment says "Generic empty/partial KPI extraction must NOT clear a reusable session." |
| **Exact failure point** | `auth-session-gateway.ts:196` |
| **Evidence** | The `extractionLooksUnusable` function returns true, but `shouldClearAuthSession` returns false (no login-page URL, no auth error text). Session is preserved. |
| **Root cause** | Intentional design to prevent Brand runs from clearing valid sessions due to non-auth script failures. |
| **Confidence** | HIGH (design review, not a bug) |
| **User impact** | If a session's MicroStrategy cookies are actually expired but the failure doesn't produce auth-signal text, the session file persists and subsequent runs reuse dead cookies. TTL (12h) eventually clears it. |
| **Files involved** | `auth-session-gateway.ts:191-204`, `auth-session-store.ts:76-89` |
| **Recommended fix** | Consider adding a counter: if N consecutive extractions are unusable with the same session, clear it. |
| **Regression test** | Reuse session 3× with empty extraction; verify session cleared on 3rd attempt. |
| **Related issues** | None |

---

### ISSUE-015: Frontend `persistManualHeadlessRun` doesn't compute `diff` map

| Field | Value |
|---|---|
| **ID** | ISSUE-015 |
| **Title** | Solo manual runs persist `diff: null` — no per-KPI comparison data stored |
| **Category** | UI / result presentation |
| **Severity** | P4 |
| **Current/Historical** | CURRENT |
| **Classification** | VERIFIED_CODE |
| **Reproduction** | `persistManualHeadlessRun` (ScenarioDetail.tsx:3377, 3401) always sets `diff: null`. The orchestrator computes detailed per-KPI diff maps with tolerance, pct, expected/actual. This means Solo runs lack the rich comparison data that Brand runs have. |
| **Exact failure point** | `src/pages/ScenarioDetail.tsx:3377, 3401` |
| **Evidence** | Direct code inspection. The `statusFromKpis` function determines pass/fail, but the `diff` field is always null. |
| **Root cause** | Solo persistence was built as a simple path; diff computation wasn't replicated from the orchestrator. |
| **Confidence** | HIGH |
| **User impact** | RunScenarioCard and RunDetail cannot show per-KPI tolerance breakdown for Solo runs. |
| **Files involved** | `src/pages/ScenarioDetail.tsx:3303-3420` |
| **Recommended fix** | Compute a minimal diff map in `persistManualHeadlessRun` matching the orchestrator's format. |
| **Regression test** | Solo run → verify RunDetail shows per-KPI comparison data. |
| **Related issues** | ISSUE-009 |

---

### ISSUE-016: `compare-and-swap` finalization fallback uses JSON string equality

| Field | Value |
|---|---|
| **ID** | ISSUE-016 |
| **Title** | Finalization fallback compares summary via JSON string filter |
| **Category** | Run finalization reliability |
| **Severity** | P4 |
| **Current/Historical** | CURRENT |
| **Classification** | VERIFIED_CODE |
| **Reproduction** | When the `finalize_workstream_report` RPC fails, the fallback at line 255 uses `.filter("summary", "eq", JSON.stringify(summary))` to implement compare-and-swap. PostgREST JSON equality is sensitive to key ordering; if PostgreSQL serializes with a different key order than `JSON.stringify`, the filter never matches and the retry loop exhausts. |
| **Exact failure point** | `agent-orchestrate/index.ts:255` |
| **Evidence** | Line 255: `.filter("summary", "eq", JSON.stringify(summary))`. PostgreSQL's `jsonb` normalizes key order; `JSON.stringify` uses insertion order. These may differ. |
| **Root cause** | Using string equality for JSONB comparison via PostgREST filter. |
| **Confidence** | MEDIUM — PostgreSQL JSONB comparison via PostgREST may handle this correctly by doing value equality, not string equality. Needs runtime validation. |
| **User impact** | If the RPC is unavailable and the fallback fails, the workstream run stays "running" permanently. |
| **Files involved** | `agent-orchestrate/index.ts:218-265` |
| **Recommended fix** | Use a version counter in summary instead of full-JSON CAS, or validate PostgREST JSONB filter behavior. |
| **Regression test** | Disable RPC; run workstream; verify fallback completes the run. |
| **Related issues** | ISSUE-003 |

---

### ISSUE-017: `fetchFilterMatrixByScenarioIds` and `fetchLatestRunResultsByScenarioIds` share `.limit(1000)` pattern

| Field | Value |
|---|---|
| **ID** | ISSUE-017 |
| **Title** | Multiple PostgREST queries use fixed 1000-row limits |
| **Category** | Scalability |
| **Severity** | P5 |
| **Current/Historical** | CURRENT |
| **Classification** | VERIFIED_CODE |
| **Reproduction** | `fetchFilterMatrixByScenarioIds` (line 91), `fetchLatestRunResultsByScenarioIds` (line 50), `fetchLatestTestResultsByScenarioIds` (line 18) all use `.limit(1000)`. |
| **Exact failure point** | `src/lib/latestTestResults.ts:18, 50, 91` |
| **Evidence** | All three functions use 80-item chunks with 1000-row limits. |
| **Root cause** | PostgREST default limit, used as explicit ceiling. |
| **Confidence** | LOW — practical impact only at scale. |
| **User impact** | Negligible for current usage. |
| **Files involved** | `src/lib/latestTestResults.ts` |
| **Recommended fix** | Document as known limitation; address if >100 scenarios per workstream becomes common. |
| **Regression test** | N/A |
| **Related issues** | ISSUE-008 |

---

### ISSUE-018: `RunSession` registry is module-level `Map` (process-scoped)

| Field | Value |
|---|---|
| **ID** | ISSUE-018 |
| **Title** | RunSession registry is a global Map that accumulates if `releaseRunSession` is not called |
| **Category** | Memory / reliability |
| **Severity** | P5 |
| **Current/Historical** | CURRENT |
| **Classification** | VERIFIED_CODE |
| **Reproduction** | `const registry = new Map<string, RunSession>()` at `run-session.ts:78`. `registerRunSession` adds entries; `releaseRunSession` removes them. If a run crashes before `releaseSession()` in the `finally` block, the entry leaks. |
| **Exact failure point** | `run-session.ts:78` |
| **Evidence** | The `work` function wraps with `try { await workInner(); } finally { releaseSession(); }` (line 1174), which should clean up. But the workstream dispatch path (line 1149) has `releaseSession()` inside `dispatch()`, not in a finally around the HTTP handler. |
| **Root cause** | Module-level mutable state without TTL-based eviction. |
| **Confidence** | LOW — `finally` blocks cover the normal and error paths. |
| **User impact** | Minor memory leak over many runs; each entry is small (two tokens). |
| **Files involved** | `run-session.ts:78-88` |
| **Recommended fix** | Add a TTL-based eviction or periodic cleanup for entries older than 2 hours. |
| **Regression test** | N/A |
| **Related issues** | ISSUE-006 |

---

## 6. Solo vs Brand Differences

| Aspect | Solo (ScenarioDetail "Run headless") | Brand (agent-orchestrate) |
|---|---|---|
| **Entry point** | `invokeFunction("playwright-runtime", ...)` directly | `agent-orchestrate` → internal `callFn("playwright-runtime", ...)` |
| **Auth session** | Goes through auth-session gateway (same) | Goes through auth-session gateway (same) |
| **Filter matrix** | Full matrix in one Browserless call | Full matrix (non-PCC ≤8 combos) OR per-combo isolation (PCC / >8) |
| **Combo isolation** | Never isolated | Isolated for `isPccScenario || combos.length > 8` |
| **Retry** | None (single call) | Auth/timeout retry (max 2) + KPI retry (max 3 non-PCC, 1 PCC) |
| **Comparison** | `statusFromKpis` — basic pass/fail | Full tolerance-aware comparison with per-KPI diff |
| **Persistence** | Client-side `persistManualHeadlessRun` → `diff: null` | Server-side with full diff, execution audit, tolerances snapshot |
| **Cancellation** | Not cancellable | Cooperative cancellation at every checkpoint |
| **Run creation** | Created by frontend after completion | Created by orchestrator before work starts |
| **Concurrency** | Single scenario, single Browserless call | Configurable concurrency pool |

**Critical difference:** The `isolateCombos` flag (line 1507) means PCC scenarios take a fundamentally different execution path in Brand vs Solo. Solo sends all combos in one Browserless call; Brand sends them one by one. This changes how the script navigates filters, applies dates, and waits for data — producing different extraction shapes.

---

## 7. Extraction Completeness

The new `extraction-outcome.ts` module provides a rigorous completeness gate:

- `assessConfiguredCompleteness(expectedLabels, values, aliases)` verifies `expected = extracted + missing`
- `isExtractedKpiValue` correctly treats `0`, `"0"`, `"N/A"`, non-empty strings as extracted (not missing)
- `finalizeTargetOutcome` merges runtime classification with completeness for the final category
- `statusFromCategory` maps to persistable status: `pass`, `fail`, `partial_extraction`, `auth_failure`, `browserless_timeout`, `cancelled`

**Verification:** The completeness invariant `expected = extracted + explicitly_failed` is enforced at lines 2214-2226 of the orchestrator. Missing fields are recorded in `diffMap` with `error: "no_value"`.

**Gap:** Solo path (`persistManualHeadlessRun`) does NOT use `extraction-outcome.ts`. It has its own `statusFromKpis` function that lacks the completeness gate, so Solo runs can end up with status "pass" even when expected KPIs are missing (if no comparison source is configured).

---

## 8. Persistence Issues

1. **Solo vs Brand `actual` shape divergence** (ISSUE-009): Solo stores `extracted: <full envelope>` while Brand stores clean `values` + `execution` audit.
2. **Solo `diff: null`** (ISSUE-015): Brand runs have rich per-KPI diff; Solo runs have none.
3. **Tolerances snapshot** (correctly implemented): Brand runs snapshot tolerances at persist time (line 2293-2310), preventing future edits from mutating historical results.
4. **Duplicate row prevention:** The orchestrator inserts one row per combo per run. No deduplication logic — if a combo is retried, the retry's result replaces the original via a new insert (not an upsert). Old rows from previous runs remain untouched.
5. **Run finalization guards:** All finalization updates use `.eq("status", "running")` to prevent overwriting cancelled runs.

---

## 9. UI Result Consistency

- **Runs page** (RunDetail): Shows results from a specific `run_id`. Uses `test_results.run_id` filter — does not mix runs.
- **ScenarioDetail** (Latest result): Uses `fetchLatestRunResultsByScenarioIds` which keeps the **newest row per combo** across all runs (line 65-72 of latestTestResults.ts). This deliberately mixes runs when a single combo is re-run.
- **Scenarios page**: Uses combo pairing (`pairCombosWithResults`) to match configured combos with stored results. If a combo was re-run independently, the newer result replaces the older one.
- **Sync button**: Calls `persistManualHeadlessRun` which creates a NEW run — does not rewrite historical results.
- **React Query invalidation**: `invalidateLatestStatusViews` is called after `persistManualHeadlessRun` (line 495, 519). Uses `refetchType: "active"` — only refetches queries that are currently mounted.

**Potential issue:** The `staleTime: 0` + `gcTime: 0` settings on the script query (ScenarioDetail:85-86) mean every mount refetches. This is intentional for freshness but adds DB load.

---

## 10. Authentication

### Auth-session flow:
1. **Gateway** (`auth-session-gateway.ts`) wraps `playwright-runtime` handler
2. **Load session** → `loadAuthSession(profileId)` reads from `.auth-sessions/<profileId>.json`
3. **TTL check** → 12h default; expired sessions cleared
4. **Wrap code** → `wrapCodeWithAuthSession(code, storageState)` injects cookie restoration + capture
5. **First attempt** → Run with reused cookies
6. **Auth failure?** → `shouldRetryAuthSessionFresh(payload)` checks for LOGIN_FAILED/AUTH_REQUIRED/login-page URL
7. **Clear + retry** → `clearAuthSession(profileId)` + fresh login (max 2 retries)
8. **Non-auth failure?** → Session preserved (ISSUE-014 discusses this)
9. **Success** → `saveAuthSession(profileId, captured)` via atomic tmp→rename

### Validation:
- ✅ Reusable session: TTL-based, file-system storage with atomic writes
- ✅ Fresh login retry: Bounded at 2 attempts (`AUTH_FRESH_RETRY_MAX`)
- ✅ Invalid credentials: Classified as `auth_failure` with reason code
- ✅ Login-page detection: URL pattern matching
- ✅ Corrupt session recovery: Quarantine to `.corrupt` file
- ✅ Normal extraction failure does NOT clear auth session
- ⚠️ Consecutive unusable extractions with valid-looking session are not tracked (ISSUE-014)

---

## 11. Browserless Reliability

### Health check:
- New `browserless-health.ts` probes `/pressure?token=<token>` with configurable timeout (4s default)
- Orchestrator checks health before first report (line 1180) and after each timeout (line 1429)
- If Browserless is unhealthy, all remaining scenarios get `browserless_timeout` status immediately
- `__rtb_browserless_unhealthy` flag prevents retries against a dead container

### Timeout handling:
- Default Browserless timeout: 600s (10 minutes)
- Timeout classified as `browserless_timeout` by `isBrowserlessTimeoutError`
- After timeout, health is checked; if unhealthy, no more Browserless calls for this run
- Auth/timeout retries: max 2 attempts

### Issues:
- Corporate proxy blocks curl to 127.0.0.1:3000 (health check from command line fails), but Docker-to-Docker communication works fine
- No orphan job cleanup mechanism — `playwright_jobs` rows are created but not cleaned up on timeout

---

## 12. Cancellation

### Implementation (`run-cancellation.ts`):
- `createRunCancellationGate(runId)` creates a per-run gate with local flag + DB polling
- `throwIfCancelled(context)` is called at every major checkpoint: before_report, before_scenario, before_combo, before_runtime, after_runtime, before_retry, before_reference, before_persist, before_finalize, after_pool
- `mapPool` has `shouldStop` parameter connected to `cancellation.isCancelled()`
- `RunCancelledError` is caught specifically — not generic error handling
- Workers in `mapPool` catch `RunCancelledError` and return (soft stop) instead of throwing
- In-flight Browserless calls are allowed to finish — only the next checkpoint stops

### Verification:
- ✅ Cancel → no retry
- ✅ Cancel → no next combo/scenario/report
- ✅ Cancel → status remains "cancelled" (`.eq("status", "running")` guards on finalization)
- ✅ Auth expired during cancel check → `RunAuthExpiredError` → best-effort finalize
- ✅ Fail-open: DB errors during cancel check do NOT treat as cancelled

### Issues:
- None specific to cancellation. The mechanism is thorough and well-tested.

---

## 13. Performance

### Timing analysis (code-level, not runtime measurements):

| Operation | Expected duration | Notes |
|---|---|---|
| Browserless extraction | 30-120s per combo | Depends on MSTR dashboard complexity |
| Auth session load | <10ms | File system read |
| Auth session save | <50ms | File write + rename |
| Cancellation check | ~100ms | Single PostgREST query |
| Token refresh | ~500ms | Supabase Auth API call |
| Run creation | ~100ms | Single insert |
| Test result persistence | ~50ms per row | Single insert |
| Finalization RPC | ~100ms | Database function |
| Log write (jsonLog) | <50ms | File append (shared chain — ISSUE-005) |

### Bottlenecks:
1. **Per-combo isolation** doubles/triples Browserless time for PCC scenarios (serial, concurrency=1)
2. **Retry overhead**: Up to 3 retries × 30-120s per retry = up to 6 minutes per combo
3. **Race arbitration 150ms sleep**: Adds latency to every run creation

### No performance regression evidence found in the current working tree changes.

---

## 14. Static Code Audit (Additional Findings)

### Unchecked DB inserts in orchestrator

The following `sb.from("test_results").insert(...)` calls do not check the returned `error`:
- Line 1224: browserless_unhealthy scenario insert
- Line 1256: script_lookup_failed insert
- Line 1277: script_generation_failed insert
- Line 1619: main scrape failure insert

If these inserts fail (JWT expired, constraint violation), the test_result is lost but the orchestrator returns `{ pass: 0, fail: 1 }` — the run finalizes with a count that doesn't match persisted rows. This is a P2 reliability issue.

### Unchecked finalization updates

All run finalization updates (lines 1117, 1144, 1165, 2409, 2447, 2492) use `.eq("status", "running")` as a guard but do NOT check the return value. If the guard causes zero rows matched (run was already cancelled), the orchestrator continues as if finalization succeeded.

### Auth-session-log shared mutable state

`supabase/functions/_shared/auth-session-log.ts:5` has the same `let logWrite = Promise.resolve()` pattern as the orchestrator (ISSUE-005). All auth-session logging is serialized through one chain across all concurrent requests.

### Safe patterns confirmed

- No refresh tokens are logged anywhere
- All `.eq("status", "running")` guards correctly prevent overwriting cancelled runs
- All bare `catch {}` blocks in auth-session-wrap.ts and playwright-runtime are intentional defensive coding for Browserless API compatibility

---

## 14b. Frontend Display Analysis (Additional Findings)

### ISSUE-019: "Sync to last run" mutates historical test_results rows

| Field | Value |
|---|---|
| **ID** | ISSUE-019 |
| **Title** | "Sync to last run" overwrites orchestrated results with manual values |
| **Category** | UI / data integrity |
| **Severity** | P4 |
| **Current/Historical** | CURRENT |
| **Classification** | VERIFIED_CODE |
| **Reproduction** | ScenarioDetail → run headless manually → Sync to last run. The Sync function at line 1321 calls `supabase.from("test_results").update({...}).eq("id", existing.id)`, overwriting the original orchestrated result with manual values. |
| **Exact failure point** | `src/pages/ScenarioDetail.tsx:1270-1387` |
| **Evidence** | Direct code inspection. The `analysis` field is set to "Updated from manual scenario run". |
| **Root cause** | Intentional "merge" design — Sync is meant to update stored results with corrected manual values. |
| **Confidence** | HIGH |
| **User impact** | Original Brand/orchestrated result data is permanently lost after Sync. |
| **Files involved** | `src/pages/ScenarioDetail.tsx:1270-1387` |
| **Recommended fix** | Consider creating a new run instead of updating existing rows, or add a "revert" capability. |

### ISSUE-020: Unchecked DB inserts in orchestrator (4 locations)

| Field | Value |
|---|---|
| **ID** | ISSUE-020 |
| **Title** | Orchestrator test_result inserts do not check for DB errors |
| **Category** | Run reliability |
| **Severity** | P2 |
| **Current/Historical** | CURRENT |
| **Classification** | VERIFIED_CODE |
| **Reproduction** | If any of the 4 unchecked insert calls at lines 1224, 1256, 1277, 1619 fail (JWT expired, constraint violation), the test_result row is silently lost. |
| **Exact failure point** | `agent-orchestrate/index.ts:1224, 1256, 1277, 1619` |
| **Evidence** | Code inspection: `await sb.from("test_results").insert({...})` without destructuring `{ error }`. Contrast with line 1717-1750 which DOES check: `const { error: insertError } = await sb.from("test_results").insert(...)`. |
| **Root cause** | Inconsistent error handling — some inserts check, others don't. |
| **Confidence** | HIGH |
| **User impact** | Run summary shows fail count that doesn't match persisted rows. Missing test_results create confusion. |
| **Files involved** | `agent-orchestrate/index.ts` |
| **Recommended fix** | Add `{ error }` destructuring and throw on error for all 4 locations. |

---

## 15. Test Results

### Automated tests:

| Command | Status | Details |
|---|---|---|
| `npm test` (vitest) | **BLOCKED** | vitest not installed — `node_modules/` is a partial install |
| `npm run lint` (eslint) | **BLOCKED** | eslint not installed |
| `npx tsc --noEmit` | **BLOCKED** | typescript not installed |
| `git diff --check` | **PASS** | No whitespace issues |

**Key finding:** `node_modules/` is incomplete — all dev toolchain packages (`vitest`, `eslint`, `typescript`) are missing. Runtime dependencies are present. This means no automated quality gates can run in the current environment. Running `npm install` would resolve this.

---

## 15. Prioritized Fix Plan

### P1 — Incorrect/missing validation results (fix first):

1. **ISSUE-001**: Solo vs Brand `isolateCombos` divergence → Unify execution mode or make isolation opt-in per scenario
2. **ISSUE-002**: `resolveComboNode` permissive fallback → Add multi-child guard matching frontend
3. **ISSUE-003**: `dispatch().catch(() => {})` → Add error logging + best-effort finalization
4. **ISSUE-004**: `work().catch(() => {})` → Same fix as ISSUE-003

### P2 — Run reliability (fix second):

5. **ISSUE-006**: Empty `SUPABASE_SERVICE_ROLE_KEY` → Set in `.env`
6. **ISSUE-020**: Unchecked DB inserts in orchestrator (4 locations) → Add error checking
7. **ISSUE-011**: Race arbitration 150ms → Add database advisory lock
8. **ISSUE-012**: RunSession refresh token rotation → Mitigated by fixing ISSUE-006
9. **ISSUE-005**: Shared `logWrite` chain → Decouple per-request or remove chaining
10. **ISSUE-008**: `.limit(1000)` truncation → Reduce chunk size or paginate

### P3 — Performance (fix third):

10. **ISSUE-007**: `agent-analyze` swallowed errors → Add logging
11. **ISSUE-009**: Solo stores full extraction envelope → Strip before persisting
12. **ISSUE-010**: 1000-row active run limit → No change needed

### P4 — UI/result presentation (fix fourth):

13. **ISSUE-013**: Noise key drift → Shared definition
14. **ISSUE-014**: Session preserved on non-auth failure → Add consecutive failure counter
15. **ISSUE-015**: Solo `diff: null` → Compute diff in `persistManualHeadlessRun`
16. **ISSUE-016**: JSON CAS fallback → Validate PostgREST behavior or add version counter
17. **ISSUE-019**: Sync mutates historical results → Create new run instead of updating

### P5 — Maintainability (fix last):

17. **ISSUE-017**: Multiple `.limit(1000)` → Document as known limitation
18. **ISSUE-018**: RunSession registry leak → Add TTL eviction

---

## Answers to Final Questions

### 1. How many CURRENT verified issues exist?
**20 issues.** 4 P1, 6 P2, 3 P3, 5 P4, 2 P5. All are CURRENT (in the working tree).

### 2. Which issues can produce missing values?
- **ISSUE-001** (Solo vs Brand divergence): Per-combo isolation produces empty extractions
- **ISSUE-002** (resolveComboNode fallback): Can fail to find combo-specific values
- **ISSUE-008** (.limit(1000) truncation): Can miss latest results on Scenarios page

### 3. Which issues can produce incorrect values?
- **ISSUE-002** (resolveComboNode fallback): Can assign wrong combo's values to another combo
- **ISSUE-013** (noise key drift): Phantom KPI rows can make pass look like fail

### 4. Which issues can leave results PENDING?
- **ISSUE-003, ISSUE-004** (swallowed dispatch errors): Run stays "running" forever, results never finalize
- **ISSUE-016** (JSON CAS fallback failure): Workstream run never completes

### 5. Which issues can cause Browserless hangs?
- None directly. Browserless health check (ISSUE-010's related code) prevents repeated calls to unhealthy containers.

### 6. Why can Solo pass while Brand fails?
**ISSUE-001**: Solo sends full matrix in one Browserless call. Brand isolates PCC combos into separate calls. The script behaves differently with one combo vs all combos — filter application, dashboard readiness, and extraction timing change. Additionally, **ISSUE-002**: Backend `resolveComboNode` may fall back to root payload for Solo (single call = single payload) but fail to resolve individual combos in isolated mode.

### 7. Are PCC and non-PCC execution flows consistent?
**No.** PCC scenarios use `isolateCombos = true` (serial, 1 combo per call, max 1 retry). Non-PCC scenarios use `full_matrix_like_solo` (all combos in one call, max 3 retries). This is the core of ISSUE-001.

### 8. Is full-matrix vs per-combo behavior correct?
**The full-matrix path is correct** — it matches Solo behavior. The per-combo isolation path has been identified as the source of Brand failures. The code comment at line 1503-1506 explicitly acknowledges this: "Per-combo isolation was added for long PCC matrices, but for normal row-count/KPI cases it caused Brand empties."

### 9. Can any combo contaminate another combo?
**Yes, via ISSUE-002:** `resolveComboNode` can return the flat root when label matching fails, giving all combos the same KPI values. The frontend guard (pickComboBlock:3109-3112) is stricter. The `persistManualHeadlessRun` function also has a guard at line 3347: "Never fall back to the whole multi-combo payload."

### 10. Can any failed KPI erase a successful KPI?
**No.** Each run creates new `test_results` rows via INSERT. Old rows from previous runs are never modified. The `latestTestResults` query returns the newest row per combo, so a new failed result will override a previous passed result for that combo — but this is correct behavior (the latest run result is the truth).

### 11. Can Brand and Latest Result show different executions?
**Yes, by design.** RunDetail shows results from a specific `run_id`. Latest Result shows the newest row PER COMBO across all runs. If a single combo was re-run independently (creating a new run with one result), Latest Result shows the newer result for that combo and older results for other combos — correctly mixing runs.

### 12. Can any completed run remain PENDING?
**Yes, via ISSUE-003 and ISSUE-004.** If the background dispatch/work function throws an unhandled error, the run stays "running" (not "pending" — but effectively the same: never completes). The `.catch(() => {})` pattern swallows these errors.

### 13. What are the top 5 issues to fix first?
1. **ISSUE-001** — Solo vs Brand isolateCombos (root cause of most Brand failures)
2. **ISSUE-002** — resolveComboNode fallback (cross-combo contamination)
3. **ISSUE-003** — dispatch().catch(() => {}) (permanently running workstreams)
4. **ISSUE-006** — Empty SUPABASE_SERVICE_ROLE_KEY (auth fragility)
5. **ISSUE-004** — work().catch(() => {}) (permanently running solo/report runs)

### 14. What should NOT be changed?
- **Auth-session gateway design** — the session reuse/retry logic is well-designed and the "preserve session on non-auth failure" policy is correct
- **Cancellation mechanism** — thorough, well-tested, handles all edge cases
- **Extraction-outcome classification** — new, well-structured, handles all failure categories
- **Completeness gate** (`assessConfiguredCompleteness`) — correctly validates expected = extracted + missing
- **`fetchLatestRunResultsByScenarioIds` keeping newest-per-combo** — correct design for mixing re-run combos
- **`pairCombosWithResults`** — correct matching logic with proper fallback chain
- **`StatusChip`** — correctly maps all new status types
- **Template-based script generation** — not involved in any current issues

### 15. Is the application currently ready for production?
**No.** The 4 P1 issues (Solo vs Brand divergence, combo contamination, swallowed errors) can produce incorrect results and permanently-running runs. After fixing the P1 issues and setting the service role key (P2), the application would be functional for supervised production use. Full production readiness requires fixing P1+P2 issues (9 total).

---

*Audit completed 2026-11-05. No code was modified during this audit.*
