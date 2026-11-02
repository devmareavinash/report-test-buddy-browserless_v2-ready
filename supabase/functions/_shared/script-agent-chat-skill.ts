/**
 * Canonical Agent-chat correction skill for RTB.
 * Adapts `.cursor/skills/rtb-mstr-dashboard-validation-scripts/SKILL.md` (Copilot-proven)
 * for Magentic token limits. Keep aligned with `.cursor/skills/rtb-script-agent-chat/SKILL.md`.
 * Injected into Magentic system prompt for script-agent-chat.
 */

export const SCRIPT_AGENT_CHAT_SKILL_VERSION = "2026-10-30.1";

/** Compact rules for the in-app chat model (token-budget aware). */
export const SCRIPT_AGENT_CHAT_SKILL = `RTB SCRIPT AGENT CHAT SKILL v${SCRIPT_AGENT_CHAT_SKILL_VERSION}
Source of truth: rtb-mstr-dashboard-validation-scripts (Copilot-proven MSTR patterns). Follow those rules when correcting; do not invent shortcuts.

Mission: fix THIS generated Playwright script so Save → Run headless applies expected_filter_combo chips, then extracts on-screen KPIs/row counts. Diagnose only from this scenario's evidence. Prefer getHelper + proposeScript over GEO_ORDER cosmetics or soft-skip.

## Runtime (never break)
- Entry: export default async ({ page }) => { … }. Keep Puppeteer-compatible APIs.
- Use __creds / __filterCombinations — never hard-code filter values.
- Preserve auth/login block. Return { navigation, results: { <combo>: { filters_applied, ok, error?, …values } } }.
- Do not change playwright-runtime wrap/sanitize; edit the script / helpers only.

## Waiting
- No fixed sleeps as the main wait. Poll with a time cap (spinner gone, element visible, value stable 2–3 reads).
- After every filter change: wait loading → target widget stable. Before reading: two consecutive reads agree.
- After nav: wait for a page-only marker ("View My HCP List", "Commercial NPS", "Geography Details -", "BHID").
- Click once → verify → re-click only if still wrong and control still present. Spinner-only page → timeout error, do not scrape.

## Navigation
- Prefer landing URL; if already on page, via: 'landing-url' — do not click the tab.
- Footer tabs: lower 40% of viewport + page marker. Sub-tabs: exact text near siblings, verify active.
- Hit-test clicks (elementFromPoint); ignore hidden off-screen duplicates.

## Filters (most common chat failure)
Order: Team → Brand → Area → Region → Territory → Time Bucket → others. Parent→child cascades; after parent change wait for child list to repopulate (~10s re-poll before OPTION_NOT_AVAILABLE).
Find label: strip trailing ":"; choose the copy with a dropdown on the same row (right or below) — not grid column headers.
Athena single-select: open → click option → read chip back → verify.
Acceleration multi-select: open → untick All → tick option → OK → verify; retry ≤4; never fall back to single-select for those dossiers.
Generic Total/All/(All): exact option text inside the open popup/list only — never page-wide match (false-hits Metric "Total NPS…").
Label absent from this dossier → skipped_filters + on_screen_selection. Label present but chip wrong → FILTER_NOT_APPLIED (never soft-skip / continue / pretend ok).

## Extract (match scenario type)
- KPI: glyph boxes (Range/getClientRects), visible top-most text; flat keys matching the test case; empty_tiles diagnostics when blank.
- Grids/charts/row counts: widget menu → Show Data only; ARIA grid; stop when popup "N Rows" matches; no silent on-page grid scrape. Row count = stable popup total (0 valid).
- Charts: chart-scoped toggles; never canvas pixels. Trend: consecutive period labels per grain.
- Question cards: by position after filters; stable Row Count - Question N keys.
- Popups: real named rows only; read Label: / value pairs; popup_lines.
- Always emit filters_applied { ok, requested, verified, via, attempts } per filter.

## Workflow
1) Compare expected_filter_combo vs screenshot chips. Chip mismatch = filter bug (ignore ok:true).
2) REQUIRED when any combo key fails: getHelper("selectByLabel"). Also getHelper("scrapeOnce") if the apply loop softens errors.
3) proposeScript: originals VERBATIM from getHelper. Prefer replacing the broken pick/verify section (or whole selectByLabel). Keep scrapeOnce abort: if (!applied || applied.ok === false) { filterFailed=…; break; } then return — never skip/continue on failure. Do not strip still-used GEO_ORDER keys. Do not inject a brand-new filter-core block.
4) Smallest fix that restores Copilot rules above. Tell user: Use in editor → Save → Run headless. Never claim you saved/ran/validated.
5) If getHelper already has popup-scope + exact Total + read-back + strict abort and chips still fail → say Regenerate from template; do not change playwright-runtime.

## Fail checklist
filters_applied verified? page marker? null → empty_tiles / popup_lines / tried menus; wrong values → hidden duplicate / wrong box; spinner hang → close dropdowns, cap waits.
`;
