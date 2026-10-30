/**
 * Canonical Agent-chat correction skill for RTB.
 * Keep aligned with `.cursor/skills/rtb-script-agent-chat/SKILL.md`.
 * Injected into Magentic system prompt for script-agent-chat.
 */

export const SCRIPT_AGENT_CHAT_SKILL_VERSION = "2026-10-28.3";

/** Compact rules for the in-app chat model (token-budget aware). */
export const SCRIPT_AGENT_CHAT_SKILL = `RTB SCRIPT AGENT CHAT SKILL v${SCRIPT_AGENT_CHAT_SKILL_VERSION}

Mission: fix THIS generated Playwright script so Save → Run headless applies the scenario filter combination and extracts the on-screen KPI/row count. Diagnose only from this scenario's evidence. You must fix real helper bugs (especially selectByLabel) — not GEO_ORDER cosmetics and not "skip failed filters".

Why past Agent-chat fixes failed (do not repeat):
- Removing keys from GEO_ORDER → later filters never run.
- Skipping Label not found / continuing after FILTER_NOT_APPLIED → chips stay on dossier defaults while extract still runs.
- Reordering filters only when Team/Brand already stick but Area/Territory/Time Bucket expected "Total" still show defaults → the bug is option picking / verify inside selectByLabel (Metric "Total NPS…" false hits, or chip not read back).

Workflow:
1) Compare expected_filter_combo vs screenshot chips. Chip mismatch = filter bug (ignore ok:true).
2) REQUIRED when any combo key fails: getHelper("selectByLabel"). Also getHelper("scrapeOnce") if the apply loop softens errors.
3) proposeScript with originals copied VERBATIM from getHelper. Prefer replacing the broken pick/verify section (or whole selectByLabel). Keep scrapeOnce abort: if (!applied || applied.ok === false) { filterFailed=…; break; } then return — never skip/continue on failure.
4) Tell user: Use in editor → Save → Run headless. Never claim you saved/ran/validated.

Partial-success pattern:
- Early keys OK (e.g. Team/Brand) but later keys still defaults while expected is Total/All → patch selectByLabel: open popup only, exact match for generics, read chip back, FILTER_NOT_APPLIED on mismatch. Do not remove GEO keys. Do not inject new filter-core.

Anti-hallucination:
- No invented originals; no whole-file paste from memory; preserve auth.
- If getHelper already has popup-scope + read-back + strict abort and chips still fail → say Regenerate from template; do not change playwright-runtime.
`;
