# PCC E2E / Performance Report (read-only)

**Generated:** 2026-11-04 (monitoring window through ~11:59Z)  
**Mode:** MONITORING/ANALYSIS ONLY — no restarts, no cancel, no code changes  
**Current run:** `4cbe9d90-3ee6-4c94-956f-5050a16a35a0`  
**Status at report time:** **IN PROGRESS** (not finished — no final totals)

Secrets redacted: no access/refresh tokens, cookies, passwords, or KPI values.

---

## 1. Current run status

| Field | Value |
|---|---|
| Run ID | `4cbe9d90-3ee6-4c94-956f-5050a16a35a0` |
| Start | `2026-11-04T11:51:12.232Z` |
| Elapsed (at last poll) | **~10.4 min** |
| Scope | `report` / `62088919…` (PCC) |
| Concurrency | `1` |
| `auth_source` at create | **`caller_refreshing`** (refresh token armed) |
| Browserless pressure | `running: 1`, `queued: 0` (healthy; no queue pile-up) |
| Orchestrate terminal events for this run | `run_created` only so far (no cancel / no auth-expired) |

---

## 2. Progress (proven so far)

| Metric | Proven value | Notes |
|---|---|---|
| Scenario count completed | **0** (UI-visible) | First scenario `d212422f…` still in multi-combo scrape pool |
| Scenarios remaining | Unknown (report has historically **17** cases on this PCC screen) | Not re-queried from DB in this pass |
| Combos completed (full main+ref pair logged) | **1** pair finished for scenario `d212422f…` | Combo 2 **main** in flight (`POST` at 11:58:44Z) |
| Combos remaining | Unknown | Filter matrix size not in orchestrate log |
| Actual extractions completed | **1** (useful keys present) | |
| Reference extractions completed | **1** (useful keys present after fresh login) | |
| Browserless calls (orchestrate-completed) | **2** | |
| Browserless POSTs (gateway) | **3** | See §5 |
| Extraction retries (`combo_extraction_retry`) | **0** | |
| `empty_extracted_main` | **0** | |

Persistence (`test_results` insert / analyze): **not yet observed** for this run — expected while isolated combo scrapes for scenario 1 continue.

---

## 3. Browserless timing (current)

| Call | End (UTC) | Duration | Role (inferred) |
|---|---|---|---|
| 1 | 11:54:32 | **194.6 s** | Actual / main (combo 1) |
| 2 | 11:58:41 | **247.7 s** | Reference (combo 1; includes reuse-miss + fresh login) |
| 3 | in flight | — | Actual / main (combo 2+) |

**Average actual (completed):** 194.6 s (n=1)  
**Average reference (completed):** 247.7 s (n=1)

**Idle gaps (wall clock):**
- Run start → first wrap: ~6 s  
- Main end → ref wrap: ~3 s  
- Ref end → next main wrap: ~3 s  

Idle/queue contribution so far: **negligible** vs scrape time. Pressure `queued: 0` throughout observed window.

---

## 4. Auth-session behavior (current)

| Metric | Count / result |
|---|---|
| Session wraps | 3 |
| Reused wraps | 3 (initial wrap flags) |
| Fresh-login path | **1** (`auth_session_reuse_miss_retry_fresh` → `auth_session_cleared`) |
| `auth_session_load_failed` | **0** |
| `auth_session_save_failed` | **0** |
| Saves | 2 |
| Partial extractions (ok) | 2 (main useful=63 empty=1; ref useful=63 empty=1) |
| `extraction_failed_session_preserved` | **0** |
| Cleared | **1** (reference profile only; reason `auth_failure_reuse_miss`) |

### Validation checks (this run)

| Check | Result |
|---|---|
| MSTR session reuse working | **YES** for main (reused=true, partial ok) |
| Non-auth failures clear session? | **No evidence** of non-auth clear; the one clear had **auth evidence** (`…/auth/ui/loginPage`) |
| Silent empty actual/reference? | **No** for completed pair — both sides reported useful_key_count=63 |
| JWT expired loop? | **No** (`run_cancellation_check_failed` / JWT errors = 0 on this run) |
| Token refresh mid-run? | Refresh **armed** (`caller_refreshing`); **`run_session_refreshed` not yet observed** (token not near expiry yet) |
| test_results persisting? | **Not yet proven** (no persist/analyze events for this run_id yet) |

---

## 5. Browserless calls vs expected extractions

For first combo (expected: 1 actual + 1 reference = **2** extractions):

| Layer | Count |
|---|---|
| Expected extractions | 2 |
| Orchestrate `playwright-runtime` completions | 2 |
| Gateway `/chromium/function` POSTs | **3** |

Extra POST caused by: reference reuse landed on login page → clear → **fresh-login** second POST inside the same orchestrate reference call (single `internal_call_completed` duration **247.7 s** spans both).

**Browserless calls per expected extraction (combo 1):** 3/2 = **1.5**

---

## 6. Cancellation `runs.status` checks

| Metric | Value |
|---|---|
| Successful check log events with duration | **Not instrumented** — no per-check duration fields in logs |
| `run_cancellation_check_failed` (this run) | **0** |
| `run_cancellation_detected` (this run) | **0** |
| Average / cumulative cancel-check duration | **Cannot compute** from available logs |

Proven: cancel checks are **not** producing JWT-expired failures on this run so far. Overhead cannot be quantified in ms without new instrumentation (out of scope).

---

## 7. Token refresh

| Item | Value |
|---|---|
| `auth_source` at run create | `caller_refreshing` |
| `run_session_refreshed` events | **0** so far |
| JWT expired errors | **0** so far |
| Service-role warning on internal calls | Still logged (`SUPABASE_SERVICE_ROLE_KEY missing`) — informational; refresh path is armed |

---

## 8. Representative timeline — scenario `d212422f…` combo 1

Timestamps from `auth-session.jsonl` + orchestrate/backend (sanitized):

```
11:51:12.232  run start (orchestrate)
11:51:18.651  session load/reuse (main)     reused path
11:51:18.655  session wrap (main)
11:51:18      actual Browserless START      (POST /chromium/function)
11:54:32.172  session save (main)
11:54:32.174  partial extraction (main)     useful=63 empty=1
11:54:32.188  actual Browserless END        duration 194.6s
(~cancel check)  not individually logged when OK
11:54:35.153  session load/reuse (reference)
11:54:35.173  session wrap (reference)      reused=true initially
11:54:35      reference Browserless START
11:55:40.840  reuse miss → loginPage        clear_and_fresh_login
11:55:40.851  session cleared (reference)
11:55:40      reference Browserless RETRY   (fresh login POST)
11:58:41.674  session save (reference)
11:58:41.675  partial extraction (reference) useful=63 empty=1 reused=false
11:58:41.684  reference Browserless END     duration 247.7s (includes miss+retry)
11:58:44.876  next combo main wrap          reused=true
11:58:44      next actual Browserless START (in flight at last poll)
(persistence)  not yet reached for scenario
```

---

## 9. Historical comparison (same PCC report `62088919`)

### Baseline: run `91c2e93f…` (2026-11-04T09:45:38Z, `auth_source=caller`)

| Metric | Value |
|---|---|
| Completed PW calls in sample | 12 |
| Sum Browserless time | **37.8 min** |
| p50 | **190 s** |
| max | **243 s** |
| Auth wraps | 12 reused / 0 fresh (in that window) |
| First combo pair (inferred main+ref) | **239.1 s + 189.7 s = 428.8 s** |

### Current: run `4cbe9d90…` (first combo only)

| Metric | Value |
|---|---|
| First combo pair | **194.6 s + 247.7 s = 442.3 s** |
| Runtime multiplier vs hist first pair | **442.3 / 428.8 ≈ 1.03×** |

| Leg | Historical | Current | Delta |
|---|---|---|---|
| Actual (main) | 239.1 s | 194.6 s | **−44.5 s (faster)** |
| Reference | 189.7 s | 247.7 s | **+58.0 s (slower)** |

---

## 10. Where time is going (proven contributors)

| Contributor | Evidence on current run | Verdict on “~2×” |
|---|---|---|
| Browserless execution | Dominates wall clock (~3–4 min/call) | Primary cost; **not 2× vs hist first combo** |
| Retries (`combo_extraction_retry`) | 0 | Not a factor |
| Fresh login | 1 clear + retry on reference | **+~58 s on ref leg** vs hist (reuse miss → loginPage) |
| Auth-session load/save/wrap | Seconds between calls | Negligible |
| Cancellation DB checks | No duration logs; 0 failures | **Not proven** as a slowdown source |
| Token refresh / auth calls | Refresh armed; no refresh event yet | Not a current cost |
| Idle / queue | gaps ~3 s; queued=0 | Negligible |

### Exact contributor to slowdown on the completed combo

**Not a general 2× regression in Browserless or cancel checks.**  
Proven extra time on combo 1 is almost entirely the **reference auth reuse miss → session clear → fresh login**, which inflated the reference orchestrate call from ~190 s (hist) to ~248 s (current). Main was faster than the historical pair.

A screen-wide 2× claim is **not supported yet** — run incomplete; only one combo pair finished.

---

## 11. Remaining issues / watch items

1. **Run still in progress** — do not treat multipliers as final.  
2. **Reference session instability** — one `loginPage` reuse miss already forced fresh login; watch whether reference profile clears repeatedly (would amplify wall time).  
3. **Cancel-check overhead unmeasured** — needs timed logs to quantify; absence of JWT errors is a positive signal on this run.  
4. **Persistence not yet visible** — confirm `test_results` after scenario 1 combo pool completes.  
5. **Token refresh** — validate `run_session_refreshed` if/when access token approaches expiry later in this run.  
6. Internal call still warns about missing service-role key; refresh path is the intended long-run auth for this environment.

---

## 12. Sources

- `backend/logs/agent-orchestrate.jsonl`
- `logs/auth-session.jsonl`
- Backend terminal (`dev-backend.ps1`)
- Browserless `/pressure`

---

## Bottom line (so far)

Current PCC run `4cbe9d90` is **healthy and progressing** with **session reuse on main**, **refresh token armed**, **no JWT-expired cancel loop**, and **no Browserless queue**.  

First completed combo is **~1.03×** historical first-combo wall time — **not 2×**. The only proven added cost is a **reference fresh-login after reuse miss** (~+1 minute on that leg). Final performance judgment requires the run to finish.
