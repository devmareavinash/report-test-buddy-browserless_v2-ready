# Paired scrape reuse (Prod / Pre-prod)

Status: approved for implementation (product request 2026-11-03).

## Problem
Brand runs scrape both Main (prod) and Reference (pre-prod) every time. Monday only needs a fresh pre-prod scrape; Tuesday only needs a fresh prod scrape.

## Behaviour
| Run preset | `reuse_main` | `reuse_reference` | Live scrape | From Supabase |
|------------|--------------|-------------------|-------------|---------------|
| Pre-prod (Mon) | true | false | reference → `expected` | prior live `actual` (prod) |
| Prod (Tue) | false | true | main → `actual` | prior live `expected` (pre-prod) |
| Default | false | false | both | n/a |

- Donor source: existing `test_results` only (no snapshot table).
- Donor must have `scrape.mode === "live"`, matching URL, credential profile, filter combo, needed KPI keys, age &lt; 9 days.
- Miss → fall back to live Playwright scrape.
- Unpaired scenarios always scrape live.
- Confirm popup before orchestrated runs that use a reuse preset.
- Do not change `playwright-runtime`, scripts, or comparison logic.

## Data
- `reports.paired_report_id`
- `scenarios.pair_key`
- `schedules.reuse_main` / `reuse_reference`
- Provenance: `actual.scrape` / `expected.scrape` JSON tags on each insert.
