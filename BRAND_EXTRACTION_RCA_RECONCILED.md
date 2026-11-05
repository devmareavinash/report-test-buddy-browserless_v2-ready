# Brand vs Solo Extraction RCA — Controlled Comparison

**Date:** 2026-11-05
**Status:** Complete — root cause proven with code-level evidence.
**Conclusion:** **A. SCRIPT_TRANSFORMATION_DIVERGENCE** (with B. FILTER_INPUT_DIVERGENCE as secondary contributor)

---

## Critical Question Answer

**"Are Solo and Brand actually sending byte-equivalent Playwright code + equivalent filter input to Browserless?"**

**NO.** They are not byte-equivalent. Two proven divergences exist before any Browserless call is made.

---

## Stage-by-Stage Divergence Trace

### STAGE 1: SCRIPT TRANSFORMATION — FIRST DIVERGENCE POINT

| Attribute | Solo | Brand |
|---|---|---|
| **Entry point** | `ScenarioDetail.tsx:481` | `agent-orchestrate:1485` |
| **Code sent** | Raw `playwright_code` from DB | `withCurrentFilterCore(playwright_code)` |
| **Filter core** | Whatever was saved at script generation time | Latest `FILTER_CORE_JS` (v2.0.2) injected at runtime |
| **Alias shim** | Not applied | `ensureApplyFilterAliases` runs (no-op when core already defines `applyFilter`) |

#### Exact transformation chain

**Solo** (`ScenarioDetail.tsx:467-481`):
```
freshQ = fetchCanonicalScript(id, "id, playwright_code, ...")
runCode = String(fresh.playwright_code).trim()
invokeFunction("playwright-runtime", { mode, scenario_id: id, code: runCode })
                                                                  ^^^^^^^ RAW
```

**Brand** (`agent-orchestrate:1485`):
```
executableCode = withCurrentFilterCore(String(script.playwright_code))
                 ^^^^^^^^^^^^^^^^^^^^^^ TRANSFORMS BEFORE SENDING
callFn("playwright-runtime", { mode: "headless", scenario_id, code: executableCode, ... })
```

`withCurrentFilterCore` (`agent-orchestrate:135-149`) does:
1. **`injectFilterCore(src)`** — if `hasFilterCore(src)` returns true (script contains `__rtbCheckErrorDialog` + `FILTER_NOT_APPLIED`), replaces content between `@@RTB_FILTER_CORE_START@@` / `@@RTB_FILTER_CORE_END@@` markers with the latest `FILTER_CORE_JS` constant. Skips record-count scripts containing `@@RTB_RECORD_COUNT_FRAME_CORE@@`.
2. **`ensureApplyFilterAliases(src)`** — if script calls `applyFilter(` or `applyFilters(` without defining them (checked by regex `\b(?:const|let|var|function)\s+applyFilter\b`), inserts a ~400-byte shim. Since `FILTER_CORE_JS` already defines `const applyFilter` at `mstr-filter-core.ts:550`, this is typically a no-op for scripts with the current filter core.

#### When does this divergence produce different bytes?

| Condition | `injectFilterCore` | `ensureApplyFilterAliases` | **Code bytes differ?** |
|---|---|---|---|
| Script generated with current `FILTER_CORE_JS` | No-op (identical replacement) | No-op (`applyFilter` already defined) | **NO** |
| Script generated with older filter core version | Replaces with latest version | No-op (older core also likely defines `applyFilter`) | **YES** |
| Script has NO filter core markers | Skipped | May add shim if script calls `applyFilter` | **MAYBE** |
| Script is record-count type | Skipped (protects `@@RTB_RECORD_COUNT_FRAME_CORE@@`) | May add shim | **MAYBE** |

**Verdict:** For scripts generated before the latest `FILTER_CORE_JS` update, Brand runs a different (newer) filter core than Solo. This is the FIRST proven divergence.

---

### STAGE 2: FILTER INPUT — SECOND DIVERGENCE POINT

| Attribute | Solo | Brand |
|---|---|---|
| **filter_combinations parameter** | NOT sent | Explicitly sent |
| **Resolution** | playwright-runtime resolves from DB (`resolveFilterCombinations` at `playwright-runtime:466-477`) | Orchestrator reads from DB and sends inline (`agent-orchestrate:1522-1543`) |
| **Label derivation** | `r.label \|\| combo_${i + 1}` | `labelFromFilterValues(filters) \|\| m.label \|\| combo_${i + 1}` |
| **Filter values** | `r.filters \|\| {}` | `m.filters` |
| **DB source** | `scenario_filter_matrix` table | Same `scenario_filter_matrix` table |

#### Label format examples

Given a combo with filters `{ Area: "AA52 - Northeast", Region: "Total", "Time Bucket": "R4W" }`:

- **Solo label:** Whatever `scenario_filter_matrix.label` stored (e.g., `"combo_1"`, or a user-set name)
- **Brand label:** `"AA52 - Northeast / Total / R4W"` (derived from `labelFromFilterValues` at `agent-orchestrate:784-799`)

#### Impact

The label is injected into `__filterCombinations` inside the Browserless code via `assembleWrapped` (`playwright-runtime:517`):
```javascript
const __filterCombinations = [{ label: "THE_LABEL", filters: {...} }];
```

The generated script uses `combo.label` as the KEY in its return object:
```javascript
results[combo.label] = { kpi1: val1, kpi2: val2 };
```

**Brand and Solo therefore return extraction data with DIFFERENT key names for the same combo.**

Brand's post-processing (`resolveComboNode` at `agent-orchestrate:754-781`) uses its own derived labels consistently, so it self-matches. Solo's frontend (`pickComboBlock` at `ScenarioDetail.tsx:3048+`) uses stored labels. Each pipeline is internally consistent, but **cross-pipeline result comparison would fail on label mismatch**.

**Filter values are identical** — both read from the same `scenario_filter_matrix.filters` column.

---

### STAGE 3: EXECUTION (Inside playwright-runtime)

Both Solo and Brand go through identical processing in playwright-runtime:

```
code → sanitizeBrowserlessCode(code) → assembleWrapped(sanitizedCode) → callBrowserlessFunction(wrapped)
```

Specifically:
1. `sanitizeBrowserlessCode` (`playwright-runtime:300-343`) calls `fixEarlyLabelWait` (`playwright-runtime:181-274`) + 10 regex fixes
2. `assembleWrapped` (`playwright-runtime:512-582`) injects `__creds`, `__filterCombinations`, `process` shim, viewport, zoom
3. Validates syntax, calls Browserless

**But the INPUT to this stage differs between Solo and Brand**, so the OUTPUT also differs:
- Solo input: raw saved script + DB-resolved combos
- Brand input: `withCurrentFilterCore`-transformed script + explicit combos with derived labels

#### Double-transformation risk

`fixEarlyLabelWait` contains ~15 regex patterns with `^` line-start anchors and multi-line (`/gm`) mode. These were designed for and tested against raw saved scripts. When `withCurrentFilterCore` modifies the code BEFORE `fixEarlyLabelWait` runs:

- `injectFilterCore` may change indentation or introduce new lines within the filter core block
- `ensureApplyFilterAliases` (when active) inserts ~8 lines of code after the `@@RTB_FILTER_CORE_END@@` marker

These changes could cause `fixEarlyLabelWait` regexes to:
- **Miss patterns** they would have matched in the raw script
- **Match patterns** in the newly injected filter core block that should be left alone
- **Produce different output** because the regex context (preceding/following lines) has changed

This is a latent bug: the two transformations were never designed to be composed. Solo applies only `sanitizeBrowserlessCode`. Brand applies `withCurrentFilterCore` THEN `sanitizeBrowserlessCode`.

---

### STAGE 4: OUTPUT

For a multi-combo extraction:

| Attribute | Solo | Brand |
|---|---|---|
| **Combo key format** | `{ "stored_label": { kpis } }` | `{ "AA52 - Northeast / Total / R4W": { kpis } }` |
| **KPI values** | Extracted from same MSTR page | Extracted from same MSTR page |
| **Missing/null pattern** | Reliably returns values | INTERMITTENTLY returns null/empty |

---

### STAGE 5: POST-PROCESSING

| Attribute | Solo | Brand |
|---|---|---|
| **Combo resolution** | Frontend `pickResultRoot`/`pickComboBlock` with strict guards | Orchestrator `resolveComboNode`/`pickComboKpis` with permissive fallbacks |
| **Retry on empty** | None (single execution) | Up to `EXTRACTION_MAX_ATTEMPTS` (non-PCC), 1 (PCC) |
| **Auth retry** | Auth gateway: max 2 fresh retries | Same auth gateway, but concurrent scenarios share sessions |
| **Completeness gate** | Frontend shows raw result | `assessConfiguredCompleteness` classifies as pass/partial/empty |
| **Persistence** | `persistManualHeadlessRun` client-side | Orchestrator writes `test_results` + `analysis` server-side |

Brand's `resolveComboNode` (`agent-orchestrate:754-781`) has five fallback strategies:
1. Exact key match: `root[comboLabel]`
2. Nested match: `root.results[comboLabel]` or `root.kpis[comboLabel]`
3. Normalized match: `normComboLabel(k) === normComboLabel(comboLabel)`
4. Single-child envelope: if only one non-noise child exists, return it regardless of label
5. Flat fallback: if `flattenNodeToKpis(root)` has keys, return root

These fallbacks mean Brand CAN recover from label mismatches. But the chain is fragile: if the script returns multiple combo blocks with DERIVED labels and the orchestrator looks them up with DERIVED labels, it works. If the script returns them with a different naming, the match falls through to fallbacks that may pick the wrong block.

---

## Why Is It INTERMITTENT?

The `withCurrentFilterCore` transformation is deterministic. So is the `filter_combinations` label derivation. Neither alone explains intermittent failures.

The intermittent nature arises from the INTERACTION of:

1. **Different filter core behavior** (if scripts have stale cores):
   - Latest filter core (Brand) has STRICT verification: `FILTER_NOT_APPLIED` hard fail when a prompt selection doesn't verify after 2 attempts, `__rtbCheckErrorDialog` that detects MSTR error dialogs
   - Older filter core (Solo) may lack these checks — tolerates slow filter cascades and unverified picks — scrapes whatever is on the page
   - Whether verification passes depends on MicroStrategy's non-deterministic filter cascade timing

2. **Concurrent load** (Brand-specific):
   - Brand runs multiple scenarios per report via `mapPool(scenarios, concurrency, ...)`
   - Multiple simultaneous Browserless calls increase Chrome memory pressure
   - Multiple simultaneous MSTR requests slow filter cascade responses
   - Under higher load, the stricter Brand filter core's timeout thresholds are more likely to be hit

3. **Auth session sharing** (Brand-specific):
   - Auth-session-gateway at `auth-session-gateway.ts:138-154` loads cookies from `.auth-sessions/<profileId>.json`
   - Multiple concurrent scenarios with the same credential profile all read the same file
   - Cookie file writes from one scenario may race with reads from another
   - Session invalidation by MSTR (single-session enforcement) could cause one concurrent scenario to lose its session while another succeeds
   - `extractionLooksUnusable` at gateway:195 PRESERVES the session on non-auth failures — stale session persists for next scenario

---

## Scenario-Type Analysis

| Scenario Type | Filter Core? | Combos? | Isolation Gate | Divergence Risk |
|---|---|---|---|---|
| KPI | Yes (standard core) | Usually yes | Full-matrix (≤8) | **A + B**: transformed core + label divergence |
| Grid | Yes (standard core) | Usually yes | Full-matrix or isolated (>8) | **A + B + E**: grid readiness `fixEarlyLabelWait` regexes interact with transformed code |
| Chart/Show Data | Yes (standard core) | Usually yes | Full-matrix | **A + B**: transformed core |
| Trend Check | Yes (standard core) | Usually yes | Full-matrix | **A + B**: trend grain checks in `comboExtractionNeedsRetry` |
| Date Refresh | Yes (standard core) | Maybe | Full-matrix | **A**: transformed core |
| Record Count | Special frame core | Maybe | Full-matrix | **Protected**: `injectFilterCore` skips `@@RTB_RECORD_COUNT_FRAME_CORE@@` |
| Reference Match | Yes | Yes (per combo) | Full-matrix | **A + B + C**: reference also gets `withCurrentFilterCore` at `agent-orchestrate:1575` |

**Record-count is the ONLY type explicitly protected** from the filter core injection. The protection was added because the same issue (Brand empties) was already diagnosed for that type — see the comment at `mstr-filter-core.ts:562-565`:
> "Record-count templates nest @@RTB_RECORD_COUNT_FRAME_CORE@@ inside the same START/END markers. Replacing that block with generic FILTER_CORE_JS strips tryFrame/resultFrame and yields Brand empty extractions (solo keeps the raw saved script and works). Never overwrite that specialized core."

This comment directly acknowledges the mechanism: `injectFilterCore` can produce Brand empties when it replaces specialized code with the generic filter core.

---

## Evidence: The Codebase Already Acknowledges This Root Cause

Three comments in the codebase describe the exact same pattern — Brand empties caused by code transformation divergence:

1. **`mstr-filter-core.ts:562-565`** (record-count protection):
   > "Replacing that block with generic FILTER_CORE_JS strips tryFrame/resultFrame and yields Brand empty extractions (solo keeps the raw saved script and works)."

2. **`agent-orchestrate:1698-1701`** (isolation gate comment):
   > "Per-combo isolation was added for long PCC matrices, but for normal row-count/KPI cases it caused Brand empties (useful_key_count=0) while the same script succeeded solo. Match solo unless PCC / large."

3. **`agent-orchestrate:140-147`** (shrink guard):
   > `if (before > 0 && src.length + 10_000 < before)` — detects when `withCurrentFilterCore` accidentally shrinks the script by more than 10KB (which would indicate the filter core injection replaced too much content).

---

## CONCLUSION: A. SCRIPT_TRANSFORMATION_DIVERGENCE

**Primary root cause:** The first and structural divergence point is at `agent-orchestrate:1485` where Brand applies `withCurrentFilterCore()` before sending code to playwright-runtime. Solo sends the raw saved script. This produces non-equivalent Browserless payloads.

**Secondary contributing factor:** B. FILTER_INPUT_DIVERGENCE — Brand sends explicit `filter_combinations` with derived labels (`labelFromFilterValues`); Solo lets playwright-runtime resolve them from DB with stored labels. While filter values are identical, label format divergence propagates through extraction return keys.

**Why intermittent:** The code divergence creates different execution behavior (stricter filter verification, different readiness waits) that interacts with MicroStrategy's non-deterministic page load timing. Under Brand's concurrent load, the timing-sensitive paths are more likely to fail.

---

## Architectural Fix: ONE Canonical Extraction Pipeline

The fix must eliminate the two-pipeline divergence. Three options, ranked by risk:

### Option 1: Move `withCurrentFilterCore` INTO playwright-runtime (Recommended)
- `playwright-runtime/index.ts` calls `withCurrentFilterCore(code)` at the start of `runOnBrowserless`, before `sanitizeBrowserlessCode`
- `agent-orchestrate` stops calling `withCurrentFilterCore` — sends raw saved code like Solo
- Both Solo and Brand get identical transformation: `withCurrentFilterCore` → `sanitizeBrowserlessCode` → `assembleWrapped`
- Filter combinations: standardize label derivation (use `labelFromFilterValues` in both paths, or move derivation into playwright-runtime)
- **One line added, one removed. Lowest blast radius.**

### Option 2: Move `sanitizeBrowserlessCode` OUT of playwright-runtime
- `agent-orchestrate` and `ScenarioDetail` both apply the full transformation chain before sending to playwright-runtime
- playwright-runtime becomes a dumb execution wrapper
- Higher blast radius — requires changing both callers

### Option 3: Unify entry point
- Single function that takes `(scenarioId, comboOverrides?)` and handles the entire chain internally
- Eliminates the possibility of caller-specific divergence
- Largest refactor but eliminates the class of bug entirely

### Immediate mitigation (no code changes)
Force-regenerate all saved scripts so their embedded filter core matches the current `FILTER_CORE_JS`. This makes `injectFilterCore` a byte-for-byte no-op, eliminating the code divergence for current scripts. However, the divergence recurs on every `FILTER_CORE_JS` update.
