# RCA: Intermittent actual/reference extraction failure during Brand execution

Status: **Investigation complete up to the failure mechanism. Root cause not yet verified at runtime.**
Date: 2026-11-04
Builds on: [PROJECT_DIAGNOSIS.md](PROJECT_DIAGNOSIS.md)

Evidence labels used throughout:

| Label | Meaning |
|---|---|
| **VERIFIED** | Proven from code and/or configuration |
| **SUPPORTED BY RUNTIME EVIDENCE** | Shown by existing runtime logs |
| **PLAUSIBLE** | Consistent with the evidence but not demonstrated |
| **NOT SUPPORTED** | Contradicted by, or absent from, the evidence |
| **NOT EXECUTED** | Test defined but not run |

Redaction: no credentials, cookie names or values, tokens, keys or extracted KPI values appear in this document. MicroStrategy (MSTR) hosts are written as "prod MSTR host" and "QA MSTR host". IDs are the 8-character prefixes used in the logs.

---

## 1. Executive summary

- The working hypothesis was that Brand failures come from scenarios running concurrently through `mapPool(scenarios, ORCHESTRATE_CONCURRENCY=3)`. **The hypothesis is NOT SUPPORTED.**
  - Brand (workstream) runs force each report child to concurrency 1.
  - All 11 logged Brand runs ran with `concurrency: 1`.
  - None of the 16 failed Browserless calls overlapped another call.
  - The 64 calls that did overlap another call had 0 failures.
- The failures line up with the **shared per-profile MSTR login-session file** (`.auth-sessions/<profile>.json`). That file can be lost in two ways (both **SUPPORTED BY RUNTIME EVIDENCE**):
  - **Path A:** a single failed extraction makes the auth-session gateway delete a good session.
  - **Path B:** a failed write leaves the file unreadable, and a failed load never repairs it.
- In both cases a session is only saved again after a successful extraction. So once the file is lost, every later scenario in the Brand logs in fresh. Fresh-login calls fail at **35% (11/31)** against **3% (5/163)** for calls that reuse a session.
- **Not yet known:** *why* the fresh-login calls fail during these windows. The thrown error text is not written to any log available to this investigation. Two hypotheses remain open; see §7.

## 2. Scope and environment

| Item | Value |
|---|---|
| Scope | Intermittent main ("actual") and reference extraction failures during Brand (= workstream scope) runs only |
| Out of scope | Security, UI, SQL, LLM and Supabase issues not on this path |
| Code base | `report-test-buddy-browserless_v2-ready` at commit `2b5cf72`, no local source changes |
| Runtime | Local stack: Deno gateway `backend/server.ts`, Browserless OSS `ghcr.io/browserless/chromium:v2.55.4` |
| Orchestrator log | `backend/logs/agent-orchestrate.jsonl`: 2,623 events, 2026-10-09 to 2026-11-04 |
| Auth-session log | `logs/auth-session.jsonl`: 566 events, 2026-11-03 08:13Z to 2026-11-04 07:19Z |
| Brand runs analysed | 11 workstream runs, 2026-11-02 to 2026-11-04 (all `concurrency: 1`) |
| Credential profiles | Main `56066164` (prod MSTR host cookies); reference `633f41da` (QA MSTR host cookies) |
| Session directory | `.auth-sessions/` in the repo root, inside a OneDrive-synced folder |
| Concurrency config | `.env`: `ORCHESTRATE_CONCURRENCY=3`; compose/local Browserless `CONCURRENT=3`; ECS task definition `ORCHESTRATE_CONCURRENCY=3`, `CONCURRENT=10`, `QUEUED=10` |
| Gaps | Supabase `runs`, `test_results` and `playwright_jobs` were **not readable**: the local `.env` has no service-role key. Browserless container logs only cover the current container uptime, not the failure windows. |

## 3. Actual execution model

Brand → reports → scenarios → combos → main, then reference:

| Step | Behaviour | Code | Label |
|---|---|---|---|
| Brand → report | `mapPool(reportIds, concurrency)`; each child report is invoked with `concurrency: 1` | [agent-orchestrate/index.ts:969-981](supabase/functions/agent-orchestrate/index.ts#L969-L981) | VERIFIED |
| Effective concurrency | The value in the request body overrides `ORCHESTRATE_CONCURRENCY`. Every Brand `run_created` event logged `concurrency: 1` | [index.ts:236-241](supabase/functions/agent-orchestrate/index.ts#L236-L241) | VERIFIED / SUPPORTED |
| Report → scenario | `mapPool(scenarios, concurrency)` with concurrency = 1 for Brand children, so scenarios run one at a time | [index.ts:1047](supabase/functions/agent-orchestrate/index.ts#L1047) | VERIFIED |
| Scenario → combo | `mapPool(combos, 1)`: one combo at a time, each in its own Browserless call | [index.ts:1218](supabase/functions/agent-orchestrate/index.ts#L1218) | VERIFIED |
| Combo → main, reference | Main is awaited before reference starts | [index.ts:1225-1236](supabase/functions/agent-orchestrate/index.ts#L1225-L1236) | VERIFIED |
| No-combo scenarios | Main and reference run **in parallel** (`Promise.all`) | [index.ts:1246-1255](supabase/functions/agent-orchestrate/index.ts#L1246-L1255) | VERIFIED |
| Combo comparison | `mapPool(combos, min(c, 8))` only compares and persists results; no Browserless calls | [index.ts:1302](supabase/functions/agent-orchestrate/index.ts#L1302) | VERIFIED |
| Orchestrator retry | Up to `EXTRACTION_MAX_ATTEMPTS` (3), with no backoff; PCC scenarios get 1 attempt | [index.ts:742-745](supabase/functions/agent-orchestrate/index.ts#L742-L745), [:1187-1212](supabase/functions/agent-orchestrate/index.ts#L1187-L1212) | VERIFIED |
| Gateway retry | If a reused session gives an unusable result: delete the session file, then retry once with a fresh login | [_shared/auth-session-gateway.ts:137-148](supabase/functions/_shared/auth-session-gateway.ts#L137-L148) | VERIFIED |
| Browserless | One `/chromium/function` POST per call, so a separate browser each time; 600 s budget | [playwright-runtime/index.ts:128-176](supabase/functions/playwright-runtime/index.ts#L128-L176) | VERIFIED |
| Reference URL/profile | `reference_url`; `reference_credential_profile_id`, falling back to the main profile | [playwright-runtime/index.ts:418-462](supabase/functions/playwright-runtime/index.ts#L418-L462) | VERIFIED |

Worst case for one combo and target: 3 orchestrator attempts × 2 gateway attempts = 6 Browserless sessions in sequence. They never run in parallel with each other.

**Where overlap actually came from** (64 of 195 calls since 2026-11-03, peak of 3 at once):

1. Main and reference running in parallel in no-combo scenarios. They use different profiles. (VERIFIED)
2. Direct runs from the ScenarioDetail page during a Brand run. Example: auth-session wraps at 06:40:10Z and 06:40:13Z on 2026-11-04 have no matching orchestrator call. (SUPPORTED)
3. Two runs of the same Brand at once: f86d813b, and bf744ae9 started at 06:42:37Z while f86d813b was still on report a2a3334c. (SUPPORTED)
   - UI cancel ([RunDetail.tsx:232](src/pages/RunDetail.tsx#L232), [Runs.tsx:266](src/pages/Runs.tsx#L266)) only sets `status='cancelled'`, and the orchestrator worker never checks it. (VERIFIED)
   - The run lock only looks for `status='running'` ([index.ts:258-270](supabase/functions/agent-orchestrate/index.ts#L258-L270)). (VERIFIED)
   - Whether f86d813b was in fact cancelled: **unverified**, because there was no DB access.

## 4. Concurrency 1/2/3 reproduction results

**NOT EXECUTED.** No new Brand runs were started at concurrency 1, 2 or 3. Each run drives the production MSTR host with the shared credential for 30–60 minutes and needs explicit approval.

What the existing logs show instead:

| Observation | Result | Label |
|---|---|---|
| Do failures occur at concurrency 1? | Yes. Both failing runs (a97c1b72, 2c09e4fd) were `concurrency: 1` | SUPPORTED |
| Failure rate vs number of overlapping calls | 0 overlaps: 16/131 failed (12%). 1–4 overlaps: 0/64 failed | SUPPORTED |
| Browserless queuing | Peak of 3 simultaneous calls = `CONCURRENT=3`. Overlapping calls were not slower (72–97 s average vs 86 s) | NOT SUPPORTED as a factor |

"Failed" means a call that was immediately followed by a `combo_extraction_retry`. A failure on the last attempt is not logged, so these counts are a lower bound.

Failure by position in the run (resource accumulation check):

| Position | Calls | Failed | Rate |
|---|---|---|---|
| 1–5 | 35 | 5 | 14% |
| 6–10 | 29 | 6 | 21% |
| 11–25 | 48 | 3 | 6% |
| 26–50 | 50 | 0 | 0% |
| 51+ | 33 | 2 | 6% |

Failures do not increase as a Brand progresses, so resource accumulation is **NOT SUPPORTED**. Memory, Chromium process counts and Browserless pressure were not captured for the failure windows (**NOT EXECUTED**).

## 5. Failed execution timeline

All times are UTC on 2026-11-03. Every call below started only after the previous one ended.

### 5.1 Run a97c1b72 (Brand c7b8d98d): Path A, session deleted after one failed extraction

```
10:17:39.438  session saved for profile 56066164 (5 cookies) — valid session
10:19:07.222  scenario c8d4a6c9 combo_1 main  reused=true
10:20:30.857  gateway: reused result unusable -> retry_fresh; 10:20:30.860 session FILE DELETED
10:21:24.708  fresh attempt: not_saved cookies=0 unusable=true -> orchestrator retry 2
10:21:25.664  main reused=false ... not_saved cookies=0 unusable=true -> retry 3
   ... 17 consecutive fresh-login calls across reports 3d5047ed, 0ec0f561, 8177e2f1
       (scenarios c8d4a6c9, 60290531, 62cb8a6a), every one: not_saved cookies=0 unusable=true
10:36:35.514  last call starts; no end event logged
10:43:10.222  next Brand run (33d02cd1, different Brand): fresh login -> saved (5 cookies), reuse recovers
```

### 5.2 Run 2c09e4fd (Brand 118be533): Path B, session file unreadable after a failed write

```
11:13:04.575  main reused=true (last call of report 49aceb34)
11:15:07.669  auth_session_save_failed (only one call in flight — not a concurrent writer)
11:15:15.750  auth_session_load_failed -> fresh login (scenario f1f0d5df, "Total / Total / Total / Latest Week")
11:15:14 – 11:30:36  f1f0d5df main attempts 1–3: fresh login, not_saved cookies=0, 292–334 s each
11:30:38 – 11:38:40  5218e458 main attempts 1–3: load_failed -> fresh login, not_saved cookies=0, ~160 s each
11:38:40 – 11:41:20  5218e458 reference attempt 1: reused profile 633f41da, not_saved cookies=0 -> retry
11:41:22             5218e458 reference attempt 2 starts
2026-11-04 06:36:15  load_failed still present (7 occurrences in total)
2026-11-04 06:37:37  first successful save — file repaired
```

### 5.3 Same Brand, next day (control)

Run bf744ae9 (Brand 118be533, 2026-11-04): 55 Browserless calls, 0 retries, sessions reused. f1f0d5df and 5218e458 are not in the retry log for this run. (SUPPORTED)

## 6. Code and runtime evidence

### 6.1 Code (VERIFIED)

| Location | Behaviour |
|---|---|
| [auth-session-gateway.ts:137-143](supabase/functions/_shared/auth-session-gateway.ts#L137-L143) | Deletes the shared profile session whenever a reused-session extraction is "unusable" (any error, empty values, or a skipped script), not only when there is an auth failure |
| [auth-session-gateway.ts:164-176](supabase/functions/_shared/auth-session-gateway.ts#L164-L176) | Saves a session only after a usable extraction with captured cookies; otherwise logs `auth_session_not_saved` without the error text |
| [auth-session-store.ts:141-159](supabase/functions/_shared/auth-session-store.ts#L141-L159) | A file that fails to load (read or parse error) is not removed or quarantined; returns `null` every time |
| [auth-session-store.ts:161-184](supabase/functions/_shared/auth-session-store.ts#L161-L184) | `Deno.writeTextFile` with no temp-file-and-rename (not atomic); the exception is swallowed |
| [auth-session-store.ts:186-197](supabase/functions/_shared/auth-session-store.ts#L186-L197) | `clearAuthSession` deletes the shared file for every caller using the profile; there is no lock or single-flight |
| [auth-session-wrap.ts:69](supabase/functions/_shared/auth-session-wrap.ts#L69) | `__sessionInnerFn` is called with no try, so if the script throws, `__storageState` is never captured (`cookies=0`) |
| [mstr-overview-template.ts:337-351](supabase/functions/_shared/mstr-overview-template.ts#L337-L351) | A rejected login returns `LOGIN_FAILED`/`AUTH_REQUIRED`, which the gateway handles as `auth_session_cleared`, not `not_saved` |

### 6.2 Runtime (SUPPORTED BY RUNTIME EVIDENCE)

Auth-session event counts for Nov 3–4:

| Event | Count |
|---|---|
| `wrap` | 199 |
| `reuse` | 166 |
| `saved` | 165 |
| `not_saved` | 23 |
| `load_failed` | 7 |
| `cleared` | 4 |
| `reuse_miss_retry_fresh` | 3 |
| `save_failed` | 1 |

Failure correlation across 195 orchestrator Browserless calls since 2026-11-03 08:13Z:

| Factor | Value | Calls | Failed | Rate |
|---|---|---|---|---|
| Session | reused | 163 | 5 | 3% |
| Session | **fresh login** | 31 | 11 | **35%** |
| Captured cookies at end | 3 or 5 (saved) | 165 | 4 | 2% |
| Captured cookies at end | **0 (not saved)** | 22 | 12 | **55%** |
| Target | main | 119 | 14 | 12% |
| Target | reference | 75 | 2 | 3% |
| Overlap | none | 131 | 16 | 12% |
| Overlap | 1+ | 64 | 0 | 0% |

How these numbers were derived:

- A call's start is its end timestamp minus `duration_ms`.
- Each call is matched to its auth-session `wrap` (±3 s from start) and to its `saved`/`not_saved` event (≤200 ms before end).

Shared-state race seen in the logs (2026-11-04):

- At 06:47:42 one execution's fresh-login retry deleted `56066164.json` while other executions were running.
- Two fresh logins followed (06:47:54, 06:48:53) before the next save at 06:49:13.
- **No failure resulted.** (SUPPORTED)

## 7. Confirmed root cause

**Root cause not yet verified at runtime.**

What is established:

| # | Finding | Label |
|---|---|---|
| 1 | Brand scenarios do not run concurrently; concurrency=1 runs fail | VERIFIED / SUPPORTED |
| 2 | Concurrency, retries overlapping other scenarios, and Browserless queuing are not linked to the failures | NOT SUPPORTED as cause |
| 3 | Main and reference use separate profiles, session files and Browserless sessions | VERIFIED |
| 4 | **Failure mechanism:** the shared session file is lost (Path A: deleted after one failed extraction; Path B: unreadable after a failed write), and every later call in the Brand logs in fresh | SUPPORTED |
| 5 | Fresh-login calls fail far more often (35% vs 3%) and are never saved, so the Brand stays in that state for the rest of the run | SUPPORTED |
| 6 | The failing fresh-login calls **threw** inside the user script (`cookies=0`, `unusable=true`, no `LOGIN_FAILED`) | PLAUSIBLE (inferred from code + log shape; error text not logged) |

Still unverified (the remaining link):

| Hypothesis | Label |
|---|---|
| H1: MSTR rejects new logins once un-logged-out server sessions pile up. Every fresh-login retry creates another session, so failures make it worse | PLAUSIBLE |
| H2: the fresh-login path breaks in some templates or reports (c7b8d98d reports, f1f0d5df/5218e458) | PLAUSIBLE |
| H3: the Path B write failure was caused by OneDrive sync locking `.auth-sessions/*.json` | PLAUSIBLE (write error is swallowed) |
| Resource exhaustion (memory, Chromium processes, screenshots) | NOT SUPPORTED |
| Cookie/session contamination between concurrent scenarios | NOT SUPPORTED |

## 8. Minimal proposed fix

**Not implemented.** Following `specs/README.md`, these need a spec and approval first. Item 1 should land first because it closes the evidence gap.

1. **Logging only (no behaviour change).** In `auth_session_not_saved` and `auth_session_reuse_miss_retry_fresh`, log:
   - `extracted.error` (truncated)
   - the final page URL path (no query string)
   - `reused`
   - run, scenario and combo IDs, passed through from the orchestrator

   Never log cookie values. Targets: [auth-session-gateway.ts:137-176](supabase/functions/_shared/auth-session-gateway.ts#L137-L176).
2. **Delete the session only on evidence of an auth failure.** Delete when `shouldClearAuthSession` matches or the login form is on the final page, not on any unusable extraction. This stops one scenario's failure from evicting a good session for the rest of the Brand. Target: [auth-session-gateway.ts:137](supabase/functions/_shared/auth-session-gateway.ts#L137).
3. **Make the session store robust:**
   - Write atomically (temp file + rename).
   - Rename an unreadable file to `*.corrupt` on load.
   - Log the error class on save or load failure.
   - Set `AUTH_SESSION_DIR` to a folder outside OneDrive.

   Target: [auth-session-store.ts:141-184](supabase/functions/_shared/auth-session-store.ts#L141-L184).
4. **Separate hardening (not linked to the failures by evidence):** make the orchestrator stop when a run is cancelled; allow only one fresh login per profile at a time.

## 9. Validation plan

| # | Step | Pass criteria | Status |
|---|---|---|---|
| V1 | Get the thrown errors for the failure windows from Supabase (needs DB access; SQL below) | Error text explains the fresh-login failures (supports or rules out H1/H2) | NOT EXECUTED |
| V2 | Fresh-login A/B: move `.auth-sessions/56066164-*.json` aside, then run scenario c8d4a6c9 individually 3×. Restore the file and repeat 3× | If runs without a session fail and runs with one pass, the fresh-login path is broken independent of Brand runs | NOT EXECUTED |
| V3 | After fix 1: re-run Brands c7b8d98d and 118be533 at concurrency 1 | Every `not_saved`/`retry_fresh` event carries an error and URL | NOT EXECUTED |
| V4 | After fixes 2–3: re-run the same Brands at concurrency 1, 2 and 3; record failure rate and scenario position | No `load_failed`/`save_failed`; no `reused=false` after the first call per run; failure rate per run ≤ 3% at every concurrency level | NOT EXECUTED |
| V5 | During V4, sample Browserless `/pressure`, container memory and Chromium process count every 30 s | No growth correlated with failures | NOT EXECUTED |

SQL for V1:

```sql
select created_at,
       status,
       last_event->'extracted'->>'error' as error,
       last_event->'extracted'->>'url'   as final_url
from playwright_jobs
where (created_at between '2026-11-03 10:19:00+00' and '2026-11-03 10:37:00+00')
   or (created_at between '2026-11-03 11:15:00+00' and '2026-11-03 11:42:00+00')
order by created_at;
```

Strip query strings from `final_url` before sharing; they may contain session parameters.

## 10. Conclusion

Brand runs run their scenarios one at a time, and the failures happen without any concurrency. The evidence instead points to the shared MSTR session file for a credential profile:

- Either one failed extraction deletes a valid session (Path A), or a failed write leaves it unreadable (Path B).
- From then on, every scenario in the Brand logs in fresh, and fresh-login calls fail at 35% vs 3%.
- Because sessions are saved only after a successful extraction, the Brand stays in this state until the run ends.

This explains why the same scenarios pass on their own or in a later run, and why Brand failures are intermittent.

Still unverified at runtime: why fresh-login calls fail during these windows (H1 vs H2). The next step is V1/V2 plus logging fix 1. No source code has been changed.
