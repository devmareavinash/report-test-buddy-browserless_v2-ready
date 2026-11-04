# Reconciled Brand Extraction RCA

Status: **Two independent mechanism families confirmed, plus a third (non-auth partial extraction). The failure chain behind the current missing values is established, but the terminal fresh-login failure cause remains unverified.**
Date: 2026-11-04
Supersedes the statistics in [BRAND_EXTRACTION_RCA.md](BRAND_EXTRACTION_RCA.md). That RCA's conclusions stand; its numbers are refreshed here with a later data cutoff.
Reconciles: that RCA and the Cursor RCA (October logs, no auth-session log).

Evidence labels:

| Label | Meaning |
|---|---|
| **VERIFIED** | Proven from code, git history or configuration |
| **SUPPORTED** | Shown by existing runtime logs |
| **PLAUSIBLE** | Consistent with the evidence but not demonstrated |
| **NOT SUPPORTED** | Contradicted by, or absent from, the evidence |
| **NOT EXECUTED** | Test defined but not run |

Redaction: no credentials, cookie names or values, tokens, keys or extracted KPI values appear here. Cookies are reported by count only. MSTR hosts are written as "main MSTR host" and "reference MSTR host". IDs are 8-character prefixes.

---

## 1. Executive Summary

Cursor's RCA and the earlier RCA describe **different failures in different periods**. They are independent, and neither explains the other.

| | Mechanism A: Browserless infrastructure | Mechanism B: MSTR session loss → unstable fresh login | Mechanism C: Partial extraction on a valid session |
|---|---|---|---|
| Period | October (Oct 12, Oct 16) | November (Nov 3) | Oct and Nov |
| Signature | `playwright-runtime` HTTP 500/401: Chromium crash, connection reset/refused, caller 401 | HTTP 200; session deleted or unreadable; repeated fresh logins with `cookies=0` | HTTP 200; session saved normally; configured KPI or structured value missing |
| Concurrency involved | Partially (5 of 6 Chromium crashes at 3–5 simultaneous sessions); outage bursts also occur at concurrency 1 | No (all cases at 1 simultaneous call) | No |
| Auth-session involved | No (the gateway did not exist yet; see §2) | Yes | No |
| Status | SUPPORTED | SUPPORTED (chain); terminal cause unverified | SUPPORTED (occurrence); cause unverified |

**Current missing values** (the Nov 2–4 Brand runs) come from **B and C, not A**:

- 0 Chromium crashes and 0 Browserless connection failures since 2026-11-02.
- One 401 from expired caller auth.

The earlier figure "fresh login fails 35%" needs correcting. Fresh login is **not intrinsically unreliable**:

- Outside two failure windows, **13 of 13** fresh logins succeeded.
- Inside those windows, **23 of 23** failed.
- What fails during those windows is still unknown, because the error text is not logged.

## 2. Evidence Sources and Time Windows

| Source | Coverage | Notes |
|---|---|---|
| `backend/logs/agent-orchestrate.jsonl` | 2026-10-09 → 2026-11-04T07:43:34Z, 2,675 events | Cursor's analysis used it up to ~2026-10-26 |
| `logs/auth-session.jsonl` | 2026-11-03T08:13:25Z → 2026-11-04T07:43:35Z, 651 events | Not available to Cursor |
| Git history of the gateway | `auth-session-gateway/wrap/store.ts` and the `backend/server.ts` wrap first appear in commit `237133d` (2026-11-02 13:43Z). `auth_session_reuse_miss_retry_fresh` (the clear + fresh-retry logic) first appears in `dede5bf` (2026-11-04) | VERIFIED |
| Working-copy timestamps | `auth-session-gateway.ts` last modified 2026-11-03 08:09Z, and the auth log starts 08:13Z. The clear + fresh-retry logic was therefore running from ~Nov 3 08:13Z, before it was committed | SUPPORTED |
| Browserless logs | **Not available.** The current container `rtb-browserless-local` has only been up ~1 h. The old `rtb-browserless` container exited ~47 h ago, and its logs predate neither failure window usefully | — |
| Supabase `runs`, `test_results`, `playwright_jobs` | **Not readable.** The local `.env` has no service-role key | — |
| `PROJECT_DIAGNOSIS.md` | Re-read; P-4 (no global Browserless limit) and I-25/I-26 are relevant to Mechanism A | — |

**Consequence:** in October there was **no auth-session reuse at all**. Every October Browserless call logged in fresh inside the template. October failures therefore **cannot** come from Mechanism B. (VERIFIED by git history)

Windows compared:

| Window | Runs | Calls (`playwright-runtime`) | Peak simultaneous |
|---|---|---|---|
| October (2026-10-09 → 10-16) | 15 runs (3 report, 12 workstream) | 1,045 | **10** (2026-10-16T09:59Z) |
| November (2026-11-02 → 11-04) | 11 workstream runs | 323 | **3** (2026-11-04T06:42Z) |

## 3. Actual Execution Model

These code facts are unchanged from the earlier RCA (VERIFIED):

- A Brand (workstream) run calls `mapPool(reportIds, concurrency)`. Each child report runs with `concurrency: 1`, so scenarios within a report run one at a time ([agent-orchestrate/index.ts:969-981](supabase/functions/agent-orchestrate/index.ts#L969-L981)).
- **Cursor finding 1 is correct.** With workstream concurrency N, up to N reports run at once, so scenarios **from different reports** can overlap.
- Combos run one at a time. Main runs before reference, except in no-combo scenarios, where they run in parallel ([index.ts:1218-1255](supabase/functions/agent-orchestrate/index.ts#L1218-L1255)).
- Each attempt is a separate Browserless `/chromium/function` POST: up to 3 orchestrator attempts with no backoff, times 1 gateway fresh retry.

Effective concurrency seen in `run_created` events:

| Period | Workstream runs | Concurrency |
|---|---|---|
| Oct 12–13 | 298ba34d, 672f8dec, 73176b3e, 85198493, 57527677 | 1 |
| Oct 16 | 156b4de5, 21d8583f, 6b1e6c17, e335c215, 5d5c52d4, 2a516f5d | **2** |
| Oct 16 | 8f808f7c | 1 |
| Nov 2–4 | all 11 | 1 |

- **Cursor finding 2 ("some runs used concurrency=3") is NOT SUPPORTED** by the available log: no `run_created` has `concurrency: 3`.
- **Cursor finding 3 (up to 6 overlapping calls) is SUPPORTED, and is an understatement.** Simultaneous calls peaked at 10. The extra overlap came from **several runs active at once**: five runs on Oct 16, including two pairs on the same Brand (156b4de5/21d8583f, e335c215/5d5c52d4). It did not come from a single run at concurrency 3.

Overlapping runs of the same Brand are possible because:

- UI cancel only sets `status='cancelled'`.
- The worker never checks it.
- The lock only checks `status='running'`.

(VERIFIED in code: [RunDetail.tsx:232](src/pages/RunDetail.tsx#L232), [Runs.tsx:266](src/pages/Runs.tsx#L266), [index.ts:258-270](supabase/functions/agent-orchestrate/index.ts#L258-L270).)

The same happened again on Nov 4: f86d813b and bf744ae9 (same Brand 118be533) both ran from 06:42Z until at least 07:43Z, processing the same reports. (SUPPORTED)

## 4. Failure Taxonomy

The "observed" counts come from log events. Failures on a final attempt are not logged as retries, so extraction counts are lower bounds.

| Type | Description | Status | Observed occurrences | Concurrency involved | Auth/session involved | Causes missing actual/reference values | Retry recovers |
|---|---|---|---|---|---|---|---|
| **1** | Browserless Chromium launch/crash (HTTP 500 "Chromium failed to launch or crashed") | SUPPORTED | 6 calls: 1 on Oct 12, 5 on Oct 16 in run 21d8583f | 5 of 6 at 3–5 simultaneous sessions; 1 at 1 simultaneous session | No (no gateway in October) | Yes (scrape failed → that combo/target has no value) | Unknown (October retry events carry no attempt number) |
| **2** | Reused session gives an "unusable" extraction → gateway deletes the session and retries fresh in the same call | SUPPORTED | 4 (`reuse_miss_retry_fresh`: Nov 3 10:20:30, 11:09:47; Nov 4 06:47:42, 07:22:51) | No (3 of 4 had no other main call running for that profile) | Yes | Only when the in-call fresh retry also fails | In-call fresh retry recovered **3 of 4**; the 4th led into Type 3 |
| **3** | Session deleted → fresh-login extractions keep failing → nothing saved → the rest of the Brand runs fresh | SUPPORTED (chain) | 1 window: run a97c1b72, 2026-11-03 10:20–10:36Z, **17 of 17** fresh calls `not_saved`, `cookies=0`, `unusable=true` across 3 reports and 3 scenarios | No (1 simultaneous call throughout) | Yes | Yes (main values missing) | **No**: orchestrator retries were fresh logins too, and none succeeded within the run |
| **4** | Session write fails → file unreadable → every load fails → repeated fresh logins | SUPPORTED | 1 `save_failed` (2026-11-03 11:15:07Z), 7 `load_failed` (through 2026-11-04 06:36Z), 6 fresh calls `not_saved`, `cookies=0`, `unusable=false` | No (1 simultaneous call at the write failure) | Yes | Yes (main values for f1f0d5df and 5218e458) | **No** within the run; a successful save the next day (06:37:37Z) repaired it |
| **5** | Extraction incomplete although auth is fine (session saved, cookies captured), failing the orchestrator's stricter check of configured KPIs and structured values | SUPPORTED (occurrence); cause unverified | Nov: **6** calls with a reused session and a saved session (e.g. 05ee1833 main attempts 2–3 and reference attempt 2, Nov 4 07:33–07:43Z; 338a58a4 Nov 3). Oct: 121 retry events of type `runtime_or_empty_extraction`/`pcc_all_values_missing`, which **cannot** be separated from login failures | No (Oct: 46 of 67 retries were at 0 overlap) | No for the November cases | Yes, when all attempts fail | Partially: 2 of 11 November chains with attempt numbers recovered before the last attempt |
| **6a** | Browserless unavailable: connection reset/refused (mislabelled "TLS" by `formatFetchError`), HTTP 404 | SUPPORTED | 58 calls in 3 bursts: Oct 9 (1), **Oct 12 08:16Z** (25, in run 298ba34d at concurrency 1 plus 2 report runs), **Oct 16 06:06–06:07Z** (32 of 32 failed in run 156b4de5, each in ~2–5 s) | Mixed: the Oct 16 burst began at low load (1–2 simultaneous) | No | Yes (the whole report fails) | **No**: 3 attempts without backoff finish in seconds, inside the outage |
| **6b** | Caller JWT expired → HTTP 401 `unauthorized` from `playwright-runtime` | SUPPORTED | 17 (16 on Oct 16 10:59Z across 5 overlapping runs, 1 on Nov 3 09:02Z) | Coincident only | No (Supabase caller auth, not MSTR) | Yes | No |
| **6c** | Supabase/upstream errors (HTML error page on finalize RPC, "schema cache" on job insert) | SUPPORTED | 1 schema-cache error + several finalize RPC failures (Oct 16 10:59–11:21Z) | No | No | Yes (run or report finalization) | No |

## 5. October Browserless Failure Analysis

### 5.1 Cursor's cluster at 2026-10-16T10:51:24Z

**NOT SUPPORTED by the available log.** Every `playwright-runtime` call ending between 10:50 and 10:53Z returned HTTP 200, with two extraction retries (Type 5). All 6 Chromium crash events are listed below. Cursor may have used a different log copy, or a computed start time. This document does not use the 10:51:24Z cluster.

### 5.2 Chromium crashes (Type 1)

| End (UTC) | Start | Duration | Run (attributed by start time) | Concurrency | Simultaneous at start / peak | Auth session |
|---|---|---|---|---|---|---|
| 2026-10-12 06:08:03.733 | 06:03:07 | 296 s | 41a215ae (report scope) | 1 | 1 / 1 | n/a (no gateway) |
| 2026-10-16 06:15:37.862 | 06:14:14 | 83 s | 21d8583f | 2 | 4 / 4 | n/a |
| 2026-10-16 06:25:49.781 | 06:23:37 | 132 s | 21d8583f | 2 | 5 / 5 | n/a |
| 2026-10-16 06:36:14.681 | 06:34:54 | 80 s | 21d8583f | 2 | 4 / 5 | n/a |
| 2026-10-16 07:02:10.461 | 07:01:31 | 39 s | 21d8583f | 2 | 4 / 4 | n/a |
| 2026-10-16 07:16:41.354 | 07:16:03 | 37 s | 21d8583f | 2 | 3 / 3 | n/a |

All of these were HTTP 500 with "Internal Server Error — Chromium failed to launch or crashed". Scenario, report and main/reference are not recorded on `internal_call_*` events (`run_id`/`report_id` are null); run attribution uses start time and is approximate while runs overlap.

What this shows:

- **"Browserless concurrency/resource contention is supported as the cause of the 5 Chromium crashes in run 21d8583f on 2026-10-16 06:14–07:16Z" (SUPPORTED, correlational).**
  - They occurred only while 3–5 sessions ran at once, against a local Browserless `CONCURRENT=3` default.
  - Two workstream runs of the same Brand (930ff1b8) were active together.
  - The crash cause (memory, `/dev/shm`, CPU) is unverified: there are no Browserless or container metrics.
- The 2026-10-12 06:08Z crash happened with **1** simultaneous session after 296 s. **Contention is NOT SUPPORTED for that event.** A long-running page crash is PLAUSIBLE.
- Most high-overlap calls succeeded: of 412 calls with 5+ overlapping calls, 26 had infrastructure failures (6%). Contention raises the risk of a crash; it does not make crashes routine.

### 5.3 Browserless unavailability bursts (Type 6a)

- **Oct 12 08:16:03Z:** three runs (298ba34d workstream plus report runs ce84dedf and 1a142368) had their in-flight calls reset **within the same 300 ms**. Calls were then refused for ~40 s. That pattern is a Browserless process or container going away, not per-session contention. Run 298ba34d was at concurrency 1. (SUPPORTED)
- **Oct 16 06:06:26–06:07:26Z:** run 156b4de5 failed **32 of 32** calls, each in 2–5 s, from its very first call, when 1–2 calls were running. Browserless was unreachable at run start. (SUPPORTED)
- Whether a Type 1 crash caused these outages (for example, an out-of-memory kill leading to a restart): **PLAUSIBLE**, unverifiable without container logs.

### 5.4 October extraction retries (Type 5, mixed)

- 67 Browserless calls that returned HTTP 200 were followed by an extraction retry. 46 of them had **0** overlap: an 11% rate at 0 overlap, against 2–4% for overlapping calls.
- Reference accounted for 45 of the 121 October retry events.
- **Cursor finding 6 is SUPPORTED:** extraction retries occur at concurrency 1 and are not explained by contention.
- With no gateway in October, these cannot be split into "login failed" and "dashboard or extraction failed".

## 6. November Auth-Session Failure Analysis

Data cutoff: 2026-11-04T07:43Z. Calls since the auth log started (2026-11-03 08:13Z): 218. "Failed" means an extraction retry or a failed internal call. The figures below replace those in BRAND_EXTRACTION_RCA.md.

| Factor | Failed / calls | Rate |
|---|---|---|
| 0 overlapping calls | 18 / 133 | 14% |
| 1+ overlapping calls | 1 / 85 | 1% |
| Reused session | 7 / 184 | 4% |
| Fresh login | 11 / 32 | 34% |
| Ended with `cookies=0` | 12 / 22 | 55% |
| Main | 15 / 131 | 11% |
| Reference | 3 / 85 | 4% |
| Browserless infrastructure failures (Types 1 and 6a) | 0 | — |

The single overlapping failure is 05ee1833 on Nov 4, which is Type 5 with the session saved normally.

### 6.1 Window B1: run a97c1b72, Brand c7b8d98d (Types 2 → 3)

| Field | Value |
|---|---|
| Concurrency | 1; 1 simultaneous Browserless call throughout |
| Reports | 3d5047ed, 0ec0f561, 8177e2f1 |
| Scenarios | c8d4a6c9, 60290531, 62cb8a6a (combo_1, combo_2) |
| Target | main (profile 56066164) |
| Browserless HTTP | 200 for every call |
| Chromium crash | none |

```
10:17:39.438  saved 56066164 cookies=5            (valid session, from a reused-session call)
10:19:07.222  c8d4a6c9 combo_1 main  reused=true
10:20:30.857  reuse_miss_retry_fresh → 10:20:30.860 cleared            [Type 2]
10:21:24.708  in-call fresh retry: not_saved cookies=0 unusable=true
10:21:25 → 10:35:07  16 further fresh-login calls, each not_saved cookies=0 unusable=true,
                    40–87 s each; orchestrator attempts 2 and 3 for every combo   [Type 3]
10:36:35.514  last call starts; no end event (run stopped)
10:43:10.222  next Brand (33d02cd1, 60bd1335) fresh login → saved cookies=5; reuse recovers
```

- The session that "missed" at 10:19 had been saved 2.9 minutes earlier, so TTL expiry is NOT SUPPORTED.
- No fresh login by any caller came before the miss, so "another login invalidated it" is NOT SUPPORTED for this trigger.
- Something made a valid reused session produce an unusable extraction, and then made every fresh login in this run fail. What that was is unknown (§7).

### 6.2 Window B2: run 2c09e4fd, Brand 118be533 (Type 4)

| Field | Value |
|---|---|
| Concurrency | 1; 1 simultaneous call |
| Report | second report of the run |
| Scenarios | f1f0d5df, 5218e458 ("Total / Total / Total / Latest Week") |
| Target | main, plus reference for 5218e458 |
| Browserless HTTP | 200 |
| Chromium crash | none |

```
11:13:04.575  main reused=true (last call of report 49aceb34)
11:15:07.669  save_failed 56066164        (no concurrent writer)
11:15:15 → 11:38:40  6 main calls: load_failed → fresh login → not_saved cookies=0 unusable=false,
                     160–334 s each; f1f0d5df and 5218e458 each used attempts 1–3
11:38:40 → 11:41:20  5218e458 reference: reused 633f41da → not_saved cookies=0 unusable=false → retry
2026-11-04 06:36:15  load_failed still present; 06:37:37 saved → repaired
```

- The signature **differs from B1**: `unusable=false` (the gateway saw some values), long durations, and `cookies=0`.
- The session was never saved because 0 cookies were captured, not because extraction was empty.
- The reference call for 5218e458 shows the same `cookies=0` signature on a separate, valid profile. Something specific to this scenario or report is PLAUSIBLE.
- The same scenarios showed no extraction retries in the next day's runs of this Brand, which reused sessions. (SUPPORTED)

### 6.3 Session-state races (shared state, no failure seen)

- Nov 4 06:47:42Z: one execution's in-call fresh retry deleted `56066164.json` while other executions were running.
- The next two calls logged in fresh (06:47:54, 06:48:53) and both **saved**.
- A race on shared state is VERIFIED in code and SUPPORTED as an event, but **no failure resulted.**

### 6.4 Are A and B independent?

**Yes (VERIFIED/SUPPORTED):**

1. **Different time periods.** Types 1 and 6a occur only in October. Mechanism B occurs only from 2026-11-03, after the gateway existed.
2. **No shared code path in October.** The gateway is absent before commit `237133d` (2026-11-02), so October crashes cannot involve auth-session state.
3. **Different signatures.**
   - A: HTTP 500 from Browserless, in seconds (6a) or at minutes with high load (1).
   - B: HTTP 200 with a well-formed payload, at 1 simultaneous call.
4. **No Chromium crash or connection failure** in the November window, including the 1-hour overlap of two same-Brand runs on Nov 4 (peak 3 simultaneous).

There is **no evidence that auth-session handling caused any Chromium crash**, and none that a Chromium crash caused any session loss.

## 7. Fresh Login Failure Analysis

### 7.1 Fresh login is not uniformly unreliable (SUPPORTED)

| Fresh-login attempt (wrap `reused=false` or in-call retry) | Outcome |
|---|---|
| Nov 3 08:13, 08:15, 08:24; 10:43; 11:09:47 (in-call); Nov 4 06:36 ×2, 06:38, 06:47:42 (in-call), 06:47:54, 06:48:53, 07:22:51 (in-call), 07:23 | **13 of 13 saved** (3 or 5 cookies) |
| Window B1 (Nov 3 10:20:30–10:35:07) | **17 of 17** `not_saved`, `cookies=0`, `unusable=true` |
| Window B2 (Nov 3 11:15–11:36) | **6 of 6** `not_saved`, `cookies=0`, `unusable=false` |

- October, when every call logged in fresh, had an extraction-retry rate of about 6% (67 of 1,045 calls).
- The November 34% is therefore an artefact of **two windows in which every fresh login failed**. Fresh login is not intrinsically fragile.

### 7.2 The fresh-login path in the templates (VERIFIED from code)

The same auto-injected block appears in the overview, grid and date templates; in the chart/show-data and record-count reference scripts; and in LLM-generated scripts (`agent-scripts/index.ts:1468`). Reference: [mstr-overview-template.ts:298-352](supabase/functions/_shared/mstr-overview-template.ts#L298-L352). The block runs these steps:

1. `goto(reportUrl, domcontentloaded, 60 s)`, with errors swallowed. Then sleep 2 s.
2. **Login-page detection:** a user field, a password field, *or any* button or link whose text matches `/log ?in/`.
3. If a login page is found:
   - Optionally `goto(loginUrl)`.
   - `page.type` the username and password. **Errors are swallowed** (`.catch(() => {})`).
   - Click "log in", or submit the form.
   - `Promise.race(waitForNavigation 15 s, sleep 3 s)`, then sleep 1.5 s. **The wait after authentication can be as short as 4.5 s.**
   - Check the body text for login-failure phrases; if found, return `LOGIN_FAILED`.
4. `goto(reportUrl)` again, then sleep 2 s. If a login form is still present, return `LOGIN_FAILED` ("Still on login page").
5. Only the later dashboard waits apply: `waitForDossierReady` (25 s), `waitForDashboard` (15 s), `waitForLoadingToFinish` (≤20 s).

How fresh login differs from reused-session execution:

| Path | What happens |
|---|---|
| Reused session | The gateway wrapper calls `addCookies` (Playwright) or `setCookie` (Puppeteer) before the script. Step 2 finds no login form, so steps 3–4 are skipped. |
| Fresh login | Steps 3–4 run: two extra navigations, a credential submit, and the short post-login wait. |

Cookie capture ([auth-session-wrap.ts:66-90](supabase/functions/_shared/auth-session-wrap.ts#L66-L90)):

- Capture happens **after** `__sessionInnerFn` returns. That call has **no try/catch**, so if the script throws, `__storageState` is never captured.
- On Browserless `/chromium/function`, `ctx.context` is the user context object `{}` and has no `storageState()`. Capture therefore falls back to `page.cookies()`, which returns only cookies for the **current page URL**.
- Saved sessions hold 3–5 cookies on the MSTR host, with paths `/` and the MSTR library path. Any page that ended on that host would return at least the `/` cookies.

### 7.3 What the evidence rules in and out

| Question | Finding | Label |
|---|---|---|
| Did MSTR reject the credentials? | No. The template returns `LOGIN_FAILED`/`AUTH_REQUIRED` through a normal return. The gateway would have matched it with `shouldClearAuthSession` and logged `auth_session_cleared`, but the logs show `not_saved` | NOT SUPPORTED |
| Was the login form still shown after submit? | Same reasoning (that case also returns `LOGIN_FAILED`) | NOT SUPPORTED |
| Did the script end on the MSTR host normally? | No. `cookies=0` means the final page was not on the MSTR host, or `page.cookies()` threw, or the script threw before capture | VERIFIED (inference from code) |
| B1: did the script throw before capture? | Fits `unusable=true` + `cookies=0` + 40–87 s duration (an early exit) | PLAUSIBLE |
| B2: did the script return values but end off-host or on a crashed or closed page? | Fits `unusable=false` + `cookies=0` + 160–334 s | PLAUSIBLE |
| Did auth succeed while extraction started before the dashboard was ready? | Not distinguishable without the error text or final URL. The short post-login wait (≥4.5 s) is a real weakness, but it doesn't explain why 13 other fresh logins succeeded | PLAUSIBLE |
| Do repeated MSTR logins for one credential invalidate earlier sessions? | The 4 Type 2 triggers were **not** preceded by any fresh login. The fresh logins on Nov 4 06:47–06:48 did not break the concurrently reused sessions | NOT SUPPORTED as a trigger |
| Does an MSTR per-user session cap fill up from un-logged-out fresh sessions? | Each failed fresh attempt adds a server session and nothing logs out. B1 issued 17 in 15 minutes. No MSTR-side evidence | PLAUSIBLE |
| Template- or report-specific failure? | B1 spanned 3 reports in one Brand; B2 was one report. Each window covered one Brand only, so time-bound and Brand-bound causes cannot be separated | PLAUSIBLE |
| Timeouts? | No `BROWSERLESS_TIMEOUT` and no HTTP 408; every call ended well under 600 s | NOT SUPPORTED |

**Logging is insufficient to identify the terminal fresh-login failure.** None of the available logs records:

- the script exception or `extracted.error`
- the final page URL
- whether cookie capture threw
- MSTR server-side session state

`playwright_jobs.last_event` in Supabase may hold the error and URL (query in §12), but it was not readable for this investigation.

## 8. Current Root Cause Assessment

- **"Browserless concurrency/resource contention is supported as the cause of the 5 Chromium crashes in run 21d8583f on 2026-10-16 between 06:14 and 07:16Z."** It is not supported for the 2026-10-12 06:08Z crash, which happened with 1 session running.
- **"Browserless unavailability is supported as the cause of the 2026-10-12 08:16Z and 2026-10-16 06:06Z connection-failure bursts (58 calls)."** Whether this was load-driven is unverified.
- **"Auth-session loss followed by unstable fresh login is supported as the mechanism for the November extraction failures in run a97c1b72 (Brand c7b8d98d, 3 scenarios, main) and run 2c09e4fd (Brand 118be533, scenarios f1f0d5df and 5218e458, main).** Both ran at concurrency 1."
- **"Partial extraction on a valid, reused session is supported as a separate, low-rate source of missing values (6 November calls, e.g. 05ee1833 main and reference).** It is independent of authentication and concurrency." Its cause is unverified.
- **"The failure chain is established, but the terminal fresh-login failure cause remains unverified."**
- **No root cause is asserted** for the Type 2 trigger, the B1/B2 terminal failures, or Type 5.

How these show up for users:

| Category | Mechanisms | Status |
|---|---|---|
| **A. Historical Browserless infrastructure failures** | Types 1, 6a (Oct 12 and Oct 16), plus 6b/6c (Oct 16 10:59Z) | Not present since 2026-11-02 |
| **B. Current actual/reference extraction failures** | Types 2 → 3, Type 4, Type 5 | All at concurrency 1 |
| **C. Shared UI symptom** | Every type ends as a `test_results` row with a missing actual or expected value, or `scrape failed`. Telling them apart needs the backend signature: HTTP 500 vs 200, auth-session events, `cookies`, `unusable`. The current UI and `test_results` don't capture these | — |

## 9. Issues Ruled Out

| Hypothesis | Label | Evidence |
|---|---|---|
| Concurrency causes the current (November) failures | NOT SUPPORTED | 18 of 19 failures at 0 overlap; both failure windows at 1 simultaneous call |
| Scenarios within one report run concurrently in Brand runs | NOT SUPPORTED | Children are forced to `concurrency: 1` (code) |
| Workstream runs at concurrency 3 in the available logs | NOT SUPPORTED | Only 1 or 2 recorded |
| Auth-session handling caused the October Chromium crashes | NOT SUPPORTED | No gateway existed before 2026-11-02 (git) |
| Chromium crashes cause the current failures | NOT SUPPORTED | 0 crashes since 2026-11-02 |
| Session TTL expiry triggered session loss | NOT SUPPORTED | Sessions were 1–3 minutes old when they "missed" |
| A concurrent fresh login invalidated the reused session | NOT SUPPORTED | No preceding fresh login for any of the 4 triggers |
| MSTR rejected credentials (`LOGIN_FAILED`) | NOT SUPPORTED | No `cleared` after the failing fresh calls |
| Browserless timeout (600 s budget) | NOT SUPPORTED | No 408 or `BROWSERLESS_TIMEOUT`; longest failing call was 334 s |
| Resource accumulation over the course of a Brand | NOT SUPPORTED | Failure rate does not rise with call position (first RCA, §4) |
| Main and reference contaminating each other's session | NOT SUPPORTED | Separate profiles, files and Browserless sessions |

## 10. Remaining Unknowns

1. The script exception or `extracted.error` and the final URL for the 23 failing fresh-login calls in B1 and B2.
2. Why a 1–3-minute-old valid session produced an unusable extraction at the Type 2 triggers.
3. Whether B1 and B2 are bound to a time window (MSTR server or session state) or to a Brand/report (script or dossier).
4. MSTR server-side session count for the main credential during B1. Needs MSTR admin or Intelligence Server logs.
5. Why the session write failed at 2026-11-03 11:15:07Z. The error is swallowed; the OneDrive-synced directory is a PLAUSIBLE factor.
6. Memory, `/dev/shm` and Chromium process counts during the October Type 1 crashes; Browserless logs for both October bursts.
7. The cause of Type 5 partial extractions (05ee1833, 338a58a4), e.g. dashboard readiness or chart/grid availability.
8. Whether f86d813b (Nov 4) and the Oct 16 duplicate runs had been cancelled in the UI. Needs `runs.status`.

## 11. Minimal Fixes by Failure Mechanism

**None implemented.** Each needs a spec and approval per `specs/README.md`.

### A. Browserless capacity/concurrency fix (Types 1, 6a)

1. Make the orchestrator stop when a run is cancelled, and make the lock catch runs still executing after cancel. This prevents two runs of the same Brand at once, the main source of high overlap on Oct 16 and Nov 4. ([index.ts:258-270](supabase/functions/agent-orchestrate/index.ts#L258-L270), the `workInner` loop)
2. Add a process-wide Browserless semaphore in `playwright-runtime`, capped at Browserless `CONCURRENT` (`PROJECT_DIAGNOSIS.md` P-4).
3. Retry Browserless connection reset/refused errors with backoff (seconds to tens of seconds), not immediately. Fix the misleading "TLS" label in `formatFetchError` ([playwright-runtime/index.ts:102-113](supabase/functions/playwright-runtime/index.ts#L102-L113)).

### B. Auth-session invalidation/persistence fix (Types 2, 3, 4)

1. **Logging first (no behaviour change).** In `auth_session_not_saved` and `auth_session_reuse_miss_retry_fresh`, add:
   - `extracted.error` (truncated)
   - the final URL path, without the query string
   - `extracted.ok`
   - whether storage capture ran
   - run, scenario and combo IDs, passed from the orchestrator

   Never log cookie values. ([auth-session-gateway.ts:137-176](supabase/functions/_shared/auth-session-gateway.ts#L137-L176))
2. Delete the shared session only on evidence of an auth failure (`shouldClearAuthSession`, or a login form on the final page), not on any unusable extraction. ([auth-session-gateway.ts:137](supabase/functions/_shared/auth-session-gateway.ts#L137))
3. Write the session file atomically (temp file + rename), rename an unreadable file to `*.corrupt` on load, log the error class, and set `AUTH_SESSION_DIR` to a folder outside OneDrive. ([auth-session-store.ts:141-184](supabase/functions/_shared/auth-session-store.ts#L141-L184))
4. Capture `__storageState` in a `try/finally` around `__sessionInnerFn`, so cookies are captured, and the error re-thrown, even when the script throws. ([auth-session-wrap.ts:69](supabase/functions/_shared/auth-session-wrap.ts#L69))

### C. Fresh-login reliability fix

**Withheld: the root cause is not established.** Decide after B1 logging and V1/V2. Candidates depend on the result:

- Wait for the dashboard after login.
- Stop swallowing errors from `page.type`.
- Log out of MSTR or cap the number of fresh-login retries.

## 12. Validation Plan

| # | Step | Pass criteria | Status |
|---|---|---|---|
| V1 | Pull `playwright_jobs` for windows B1 and B2 (SQL below) | Error and final URL explain the 23 fresh-login failures, and separate B1 from B2 | NOT EXECUTED (no DB access) |
| V2 | Fresh-login A/B on c8d4a6c9 and f1f0d5df: move the profile's session file aside and run 3×; restore it and run 3× | Fresh and reused pass at the same rate (time-bound cause) or different rates (path-bound cause) | NOT EXECUTED |
| V3 | Ask an MSTR administrator for the active session count of the main credential around 2026-11-03 10:19–10:36Z | Confirms or rules out a session cap | NOT EXECUTED |
| V4 | After fix B1: re-run Brands c7b8d98d and 118be533 at concurrency 1 | Every `not_saved`/`retry_fresh` event carries an error and URL | NOT EXECUTED |
| V5 | After fixes B2–B4: re-run the same Brands at concurrency 1, 2 and 3 | No `load_failed`/`save_failed`; no cascade (at most 1 fresh-login call per run); failure rate per run ≤ 4% (reused baseline) at every level | NOT EXECUTED |
| V6 | Load test for Mechanism A: run 2 Brands at concurrency 2 (≥4 simultaneous) with fixes A1–A2 off and then on, sampling Browserless `/pressure`, container memory, `/dev/shm` and the Chromium process count every 30 s | No HTTP 500 Chromium crash with fixes on; capture memory at any crash with fixes off | NOT EXECUTED |
| V7 | Type 5: collect screenshots and final URLs for 05ee1833 and 338a58a4 retries | Identifies whether the dashboard or chart was not ready, or the KPI was absent | NOT EXECUTED |

SQL for V1 (strip query strings from `final_url` before sharing):

```sql
select created_at, status,
       last_event->'extracted'->>'ok'    as ok,
       last_event->'extracted'->>'error' as error,
       last_event->'extracted'->>'url'   as final_url
from playwright_jobs
where (created_at between '2026-11-03 10:19:00+00' and '2026-11-03 10:37:00+00')
   or (created_at between '2026-11-03 11:13:00+00' and '2026-11-03 11:42:00+00')
order by created_at;
```

## 13. Final Recommendation

1. Treat this as **three mechanisms**, not one root cause:
   - **A:** October Browserless infrastructure, partly driven by concurrency.
   - **B:** November auth-session loss leading to unstable fresh login, at concurrency 1.
   - **C:** Low-rate partial extraction on valid sessions.
2. For the **current** missing values, prioritise B:
   - Ship B1 (logging) first, because it closes the evidence gap.
   - Then B2 (clear only on auth evidence) and B3 (atomic, quarantining store, outside OneDrive). These stop one bad extraction or one bad write from degrading the rest of a Brand.
   - Run V1–V3 in parallel to identify the terminal fresh-login cause before attempting any fix C.
3. Ship A1 (stop on cancel, enforce the lock) independently. It prevents two runs of the same Brand at once, the observed source of high Browserless load, and costs little.
4. Do **not** lower concurrency as a fix for current missing values. The failures persist at concurrency 1.
