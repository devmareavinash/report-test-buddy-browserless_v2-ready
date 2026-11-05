# GLOBAL Performance RCA (read-only)

**Date:** 2026-11-04  
**Scope:** Execution-time regression after auth-session + cooperative cancellation + token-refresh wiring  
**Constraint:** No code changes; evidence from `backend/logs/agent-orchestrate.jsonl`, `logs/auth-session.jsonl`, source inspection  

Secrets redacted (no tokens, cookies, passwords, KPI values).

---

## Executive finding

**A global ~2× wall-clock regression is not proven for every run type.**

What *is* proven:

1. **Every run** now performs a **Supabase `runs.status` SELECT at every cancellation checkpoint** (plus `session.token()` which is **local** unless within 5 minutes of JWT expiry).
2. On clean solo runs after cancel, **time between Browserless calls is only ~1.7–2.9 s** — that upper-bounds **all** cancel SELECTs + auth-session wrap/save + orchestrate glue for that gap.
3. **Browserless/MSTR scrape duration still dominates** (tens–hundreds of seconds per call). Cancel/auth layers cannot explain a 2× increase in *those* call durations.
4. One measured **fresh-login after reference reuse miss** added ~+58 s on that reference leg (`4cbe9d90`).
5. Many “everything is slow” samples coincide with **Browserless contention / timeouts / overlapping runs**, not with cancel-check CPU.

---

## Code executed by EVERY run (shared path)

### Cooperative cancellation

`createRunCancellationGate` → each `throwIfCancelled` / `refresh`:

1. `ensureAuth()` → `session.token()` (if RunSession present)
2. `getClient()` → returns the **same** orchestrate `sb` object (no new `createClient` per check)
3. `sb.from("runs").select("status").eq("id", runId).maybeSingle()` → **network SELECT every checkpoint**

**Yes: cancellation currently performs a Supabase SELECT at every checkpoint.**

### `RunSession.token()` (every ensureAuth)

```text
if (!refreshToken || exp == null || exp - now > 5 minutes)
  return accessToken;          // LOCAL, no network
else
  refresh via /auth/v1/token   // NETWORK only near expiry
```

**Proven:** `token()` does **not** refresh on every checkpoint. Network refresh only inside the 5‑minute margin (or when already past margin with a refresh token).

**`run_session_refreshed` events in today’s orchestrate log:** **0**  
(Refresh may be armed — `caller_refreshing` on `4cbe9d90` — but no mid-run refresh has been observed yet.)

### Supabase client creation

**Once per orchestrate invocation** via `getSupabaseForAccessToken(() => session.token())` (or service client / request client).  
`getClient: () => sb` does **not** recreate the client per cancel check.

---

## Cancellation checkpoint density

### Source checkpoints (string literals)

| Checkpoint | Occurrences in source |
|---|---|
| `before_persist` | 6 |
| `after_pool` | 3 |
| `before_report` | 2 |
| `before_combo` | 2 |
| `before_scenario` | 1 |
| `before_reference` | 1 |
| `after_runtime` | 1 (plus dynamic `before_runtime` / `after_runtime` / `before_retry` via helper) |

### Per `reference_match` combo with filter matrix (typical PCC/Brand case)

**Scrape phase (isolated main→ref):**

| Order | Checkpoint | Meaningful work after? |
|---|---|---|
| 1 | `before_combo` | almost none → immediate `before_runtime` |
| 2 | `before_runtime` (main) | Browserless main |
| 3 | `after_runtime` (main) | almost none → `before_reference` |
| 4 | `before_reference` | almost none → `before_runtime` (ref) |
| 5 | `before_runtime` (ref) | Browserless ref |
| 6 | `after_runtime` (ref) | next combo or pool end |

**= 6 SELECTs per combo during scrape alone.**

**Persist phase (later mapPool):** +`before_combo` +`before_persist` (+ optional analyze refresh) ≈ **+2–3 SELECTs/combo**.

**Redundant adjacent pairs (safe to coalesce later, not removed here):**

- `before_combo` → `before_runtime`
- `after_runtime` (main) → `before_reference` → `before_runtime` (ref)

---

## Measured cancel-check latency

Cancel checks are **not timed** in logs when they succeed.

Only failure sample (`91c2e93f`, JWT expired): consecutive check failures were **~0.25–1.2 s** apart → implies per-check round-trip on the order of **~0.3–0.6 s** under that failure mode (VDI → Supabase).

### Overhead estimate (not a wall-clock proof of 2×)

Assume **0.4 s/check** (mid of observed fail deltas) × **6 scrape checks/combo**:

**≈ 2.4 s cancel DB overhead per combo scrape phase**

That matches the order of magnitude of **solo inter-call gaps** (~2–3 s), which also include session wrap/save.

| Metric | Solo AFTER-cancel runs |
|---|---|
| `88e6de8c` (non-PCC report) inter-call gap mean | **2.24 s** |
| `91c2e93f` (PCC) inter-call gap mean | **2.88 s** |
| `4cbe9d90` (PCC + refresh armed) inter-call gap mean | **1.68 s** |

**Conclusion:** Cancellation DB overhead is **seconds per combo**, not minutes. It cannot be the primary cause of a **2× multi-minute** regression in Browserless-bound runs.

---

## BEFORE vs AFTER Browserless metrics (log evidence)

### Representative samples

| Era | Run | Scope | Conc | PW p50 | PW mean | Inter-call gap (solo+) | Reuse wraps | Fresh miss | Retries |
|---|---|---|---|---|---|---|---|---|---|
| Before auth-session log era | `b2277454` | workstream | 1 | **72 s** | 75 s | ~0–0.4 s | 0* | 0 | 7 |
| Before | `5b0b7f00` | workstream | 3 | **96 s** | 105 s | overlapped | 0* | 0 | 3 |
| After auth-session | `de3c3915` | workstream | 1 | **76 s** | 82 s | ~3.6 s (pos) | 6/8 | 0 | 2 |
| After + cancel | `88e6de8c` | report | 1 | **108 s** | 99 s | **2.24 s** | 8/8 | 0 | 0 |
| After + cancel PCC | `91c2e93f` | report | 1 | **190 s** | 189 s | **2.88 s** | 12/12 | 0 | 0 |
| After + cancel + refresh PCC | `4cbe9d90` | report | 1 | **243 s** | 227 s | **1.68 s** | 5/5 | **1** | 0 |

\* Early runs show `reuse=0` because auth-session JSONL / wrap events were not present or not yet emitting — not proof that MSTR login was skipped.

### Contended / pathological AFTER samples (do **not** use as “cancel tax”)

| Run | PW p50 | Notes |
|---|---|---|
| `874845a3` | **620 s** | Browserless timeouts under overlap |
| `59408a71` | **228 s** | Heavy PCC + contention |

These are **queue/contention/timeout** effects, previously linked to cancel-not-stopping-workers / overlapping Brand+PCC — not SELECT latency.

---

## Browserless calls per expected extraction

| Situation | Expected extractions | Gateway POSTs | Ratio |
|---|---|---|---|
| Normal main+ref (no miss) | 2 | 2 | **1.0** |
| `4cbe9d90` combo1 (ref reuse miss → fresh login) | 2 | **3** | **1.5** |

**Added call path:** `auth_session_reuse_miss_retry_fresh` → `auth_session_cleared` → second `/chromium/function` POST inside the same orchestrate reference invocation (`reason=auth_failure_evidence`, login URL path).

**Today’s `reuse_miss_fresh` count in auth log:** **1** (that reference call only).

Extraction retries (`combo_extraction_retry`): **0** on recent solo PCC/report samples above (not the driver).

---

## Layered time model (AFTER path)

```
run start
→ cancel checks (SELECT each checkpoint)     [~0.3–0.6s each, estimated]
→ session.token()                            [local unless near expiry]
→ auth-session load/wrap                     [<<1s in logs]
→ Browserless main                           [~1–4+ min — DOMINANT]
→ auth-session save                          [<<1s]
→ cancel checks (after_runtime → before_ref) [~1–2s combined, in ~2–3s gap]
→ Browserless reference                      [~1–4+ min — DOMINANT]
→ (+ optional fresh-login POST)              [+~60s when reuse miss]
→ persist / finalize                         [after all combos for scenario]
```

### Time between Browserless calls (proven)

Solo AFTER: **~1.7–2.9 s mean** (cancel + session I/O + glue).  
BEFORE-ish Brand solo: gaps near **0** in the proxy metric (or slightly positive &lt;0.5 s) — **delta ≈ +1.5–2.5 s per gap** attributable to new layers collectively.

---

## Separation of slowdown (timestamp-backed)

| Bucket | Proven contribution | Can explain global 2×? |
|---|---|---|
| **Browserless/MSTR time** | Dominates every solo sample; PCC legs 3–4 min | **Yes for PCC/heavy screens**; cross-type 2× vs light Brand calls is workload mix |
| **Cancellation DB overhead** | ≤ inter-call gap; ~2.4 s/combo estimate | **No** for 2× |
| **RunSession/auth overhead** | `token()` local; 0 refreshes observed | **No** |
| **Auth-session file I/O** | wrap/save within same ~2 s gaps | **No** |
| **Fresh-login/retry** | +~58 s on one ref leg (`4cbe9d90`); ratio 1.5 POSTs/extraction that combo | **Local spikes only** (1 event today) |
| **Extraction retry overhead** | 0 on recent solo PCC/report | **No** |
| **Queue/idle** | `queued:0` on healthy solo; negative gaps when concurrent | **Yes when overlapping runs** (timeouts) |
| **Other (UI “0 scenarios”)** | Results persist only after **all combos** scraped | Feels slow; **does not lengthen** Browserless sum |

---

## Scenario / report / Brand comparison (honest)

| Type | What changed in shared path | What logs show |
|---|---|---|
| Individual scenario | Same cancel SELECTs + session wrap | Extra ~2 s between calls; scrape still minutes |
| Report/screen | Same | Solo non-PCC `88e6de8c` p50 **108 s** vs earlier Brand p50 **72 s** — **different screens**; not a controlled A/B |
| Brand/workstream | Same + child dispatch cancel checks | Early after auth-session `de3c3915` p50 **76 s** ≈ before; slow Brand samples are **overlap/timeout** |

**Apples-to-apples same-day PCC** (`91c2e93f` vs `4cbe9d90` first combo pair): **428.8 s → 442.3 s ≈ 1.03×**, with the +14 s explained by reference fresh-login — **not cancel**.

---

## Validation answers (checklist)

| Question | Answer |
|---|---|
| Cancel SELECT every checkpoint? | **YES** |
| `cancel_check_count × avg_latency` | ~6/combo scrape × ~0.4 s ≈ **~2.4 s/combo** (estimate); not timed when healthy |
| `session.token()` network every check? | **NO** — only within 5 min of expiry |
| `getClient()` new client every check? | **NO** — returns same `sb` |
| Redundant adjacent checks? | **YES** — `before_combo`→`before_runtime`; `after_runtime`→`before_reference`→`before_runtime` |
| Browserless calls/extraction increased? | **Only when reuse-miss fresh login** (1.0 → 1.5 for that combo) |

---

## Previous / current averages (Browserless call duration)

Using **solo, non-overlapped** call p50 as the fairest available proxy:

| | Value | Source |
|---|---|---|
| Previous average (Brand-like, pre-cancel log era) | **~72–96 s** p50 | `b2277454`, `5b0b7f00` |
| Current average (solo report after cancel, non-PCC) | **~108 s** p50 | `88e6de8c` |
| Current average (solo PCC after cancel) | **~190–243 s** p50 | `91c2e93f`, `4cbe9d90` |

Cross-type multiplier is **not one number**. Same-day PCC first-combo multiplier ≈ **1.03×**. Non-PCC Brand→report proxy ≈ **1.1–1.5×** with **confounded workloads**. Contended runs ≫2× due to **timeouts**, not cancel SELECTs.

---

## Footer (required)

```
Previous average execution time: ~72–96s Browserless p50 (solo Brand-era samples); PCC same-day first combo ~429s wall for main+ref
Current average execution time:  ~108s Browserless p50 (solo non-PCC after cancel); PCC first combo ~442s wall (4cbe9d90)
Multiplier:                      ~1.03× (same-day PCC first combo); ~1.1–1.5× (cross-type proxy, confounded); ≫2× only under Browserless contention/timeouts

Browserless time added:          Dominant; PCC/contention drive most wall-clock perception. Same-day PCC +~14s on first combo (ref fresh-login), not cancel.
Cancellation overhead added:     ~1.5–2.5s per inter-call gap envelope; ~2.4s/combo estimate (6×~0.4s). Not timed when healthy. Cannot explain 2×.
Authentication overhead added:   ~0 observed mid-run (token() local; 0 run_session_refreshed events).
Auth-session overhead added:     Wrapped into ~2s inter-call gaps (load/wrap/save). Seconds, not minutes.
Fresh-login/retry overhead added:+~58s on one reference leg (1 reuse_miss_fresh today); Browserless POST ratio 1.5 for that combo.

Primary regression source:       Browserless/MSTR scrape duration (+ contention/timeouts when runs overlap). Not cancellation SELECTs.
Secondary regression source:     Occasional auth reuse-miss → fresh login; multi-combo serial dual-scrape + late persistence (UI appears idle).

Top 3 minimal optimizations:
1. Coalesce/TTL-cache adjacent cancel SELECTs (after_runtime→before_reference; before_combo→before_runtime) without removing safety — save ~1–2s/gap.
2. Investigate/fix reference reuse-miss (loginPage) rate — avoid +~1 min fresh-login spikes and extra Browserless POSTs.
3. Persist per-combo (or emit progress) before finishing full scenario scrape pool — improves perceived speed; does not cut Browserless sum.

Estimated runtime after optimization:
  Wall Browserless sum: approximately unchanged (still MSTR-bound), minus rare fresh-login spikes (~0–60s when miss avoided).
  Inter-call overhead: ~2s → ~0.5–1s per gap if cancel checks coalesced.
  UI time-to-first-result: much earlier if per-combo persist (perception only).
```

---

## Recommendation

**Do not implement cancel/auth “performance fixes” expecting a 2× speedup** — measured shared-path overhead is **seconds per combo**, while scrapes are **minutes**.  

Next measurement upgrade (optional, later): log `duration_ms` on each `run_cancellation_check` success to replace the 0.4 s estimate.  

No code was modified for this RCA.
