// Heal a Playwright script given the current code + runtime error + screenshot.
import { corsHeaders } from "../_shared/cors.ts";
import { requireAuth } from "../_shared/auth.ts";
import {
  anthropicMessagesUrl,
  fetchAnthropicMessages,
  getSupabase,
  resolveClaudeModel,
  tryParseJson,
} from "../_shared/llm.ts";

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });
  const unauthorized = await requireAuth(req);
  if (unauthorized) return unauthorized;
  try {
    const { scenario_id, code = "", error = "", run_result = null, screenshot_b64 = null, screenshot_url = null, playwright_version = "1.47.0", prior_attempts = [] } = await req.json();
    if (!scenario_id) throw new Error("scenario_id required");

    const apiKey = (Deno.env.get("ANTHROPIC_API_KEY") || "").trim();
    if (!apiKey) throw new Error("Missing ANTHROPIC_API_KEY");

    const sb = getSupabase();
    const { data: scenario } = await sb
      .from("scenarios")
      .select("title, description, reports(name,url)")
      .eq("id", scenario_id)
      .maybeSingle();

    const sys = `You are an expert Playwright self-healing agent for BI reports.

TARGET RUNTIME: Playwright v${playwright_version} (Node.js, Chromium). Only use APIs and locator syntax that exist in this exact version. Do NOT use APIs added in later releases. The script runs inside an "export default async ({ page }) => { ... }" wrapper executed by our in-app runtime — 'page' is a real Playwright Page from that version.

Output STRICT JSON:
{"patched_playwright_code": string, "rationale": string, "changes": string[]}

You will receive FOUR signals — use ALL of them:
1. The latest JSON run_result (extracted KPIs, ok/error, url, etc.) — find which assertions/extractions returned null/empty/wrong values.
2. The final screenshot of the page — visually identify the real KPI labels, numbers, tiles, tabs, and layout actually rendered.
3. The current script and the latest runtime error.
4. PRIOR_ATTEMPTS — a chronological list of every previous failed attempt in THIS healing loop, each with its error, rationale, and changes. LEARN FROM THEM: do not repeat a fix that already failed; if the same error class keeps recurring, change strategy entirely (CSS → text/role/visual fallbacks, waitForSelector → waitForFunction, add explicit waits, change navigation strategy, etc.).

NEVER TOUCH THE RTB FILTER CORE:
The block between "// @@RTB_FILTER_CORE_START@@" and "// @@RTB_FILTER_CORE_END@@"
(selectByLabel, applyFiltersVerified, all __rtb* helpers) is generated from
mstr-filter-core.ts and is already hardened. Copy it through byte-for-byte.
Do NOT rewrite selectByLabel, do NOT re-derive label→dropdown binding from
geometry, do NOT remove the read-back verification, the dependent-list cascade
wait, or the __rtbCheckErrorDialog guard. Re-introducing a content-first
selector match silently binds a filter to its neighbour's dropdown (e.g. Region
picking the Territory selector) and the script then reports ok:true for a filter
that never moved. If a filter genuinely fails, the core reports
FILTER_NOT_APPLIED / OPTION_NOT_AVAILABLE / MSTR_ERROR_DIALOG with the actual
on-screen value — heal the NAV/label/value inputs, not the core.

Healing strategy (apply progressively when selectors fail):
- Cross-reference what the screenshot shows vs what the script tries to read. Update selectors to match the actual rendered text/labels.
- Replace brittle CSS/XPath with resilient locators: getByRole, getByText (with regex), getByLabel, locator('text=...').or(locator('css=...')), .filter({ hasText }), .first().
- When no stable selector exists, fall back to VISUAL/positional techniques:
  * page.locator('css').screenshot() and .boundingBox() to confirm position.
  * page.evaluate(() => document.body.innerText) + regex to grep KPI numbers.
  * page.locator(':text-matches("\\\\d[\\\\d.,]*%?", "i")') to find numeric tiles near a label.
  * page.locator('xpath=//*[contains(normalize-space(.), "Label")]/following::*[1]') to read the value next to a label.
  * page.waitForFunction(() => /* DOM check */) when content is async.
  * Intermediate page.screenshot({ encoding: 'base64' }) returned in debug for visual inspection.
- ALWAYS keep the "export default async ({ page }) => { ... }" wrapper. Never hardcode credentials — use __creds?.username / __creds?.password.
- Prefer page.waitForLoadState("domcontentloaded"); avoid "networkidle".
- Wrap each KPI extraction in try/catch so one missing tile does not abort the whole run. Return { ok: true, extracted: {...}, debug: { ... } }.
- Use short timeouts (5-15s) and .first() to avoid hanging.

ALWAYS return the FULL rewritten script (not a diff), hardening the ENTIRE script using lessons from ALL prior attempts in this loop — not just the line that errored.`;

    const priorBlock = Array.isArray(prior_attempts) && prior_attempts.length > 0
      ? `\nPRIOR_ATTEMPTS (oldest → newest, ${prior_attempts.length} total — do NOT repeat these failed fixes):\n${JSON.stringify(prior_attempts).slice(0, 6000)}\n`
      : "";

    const userText = `Scenario: ${scenario?.title}
Report: ${(scenario as any)?.reports?.name} (${(scenario as any)?.reports?.url})
Playwright runtime version: ${playwright_version}

Latest runtime error / issue:
${error || "(none — improve robustness)"}

${run_result ? `Latest run result excerpt:\n${JSON.stringify(run_result).slice(0, 2000)}\n` : ""}${priorBlock}
Current script:
\`\`\`javascript
${code}
\`\`\``;

    const userContent: any[] = [{ type: "text", text: userText }];
    let imageBlock: any = null;
    if (screenshot_b64) {
      imageBlock = {
        type: "image",
        source: { type: "base64", media_type: "image/png", data: screenshot_b64 },
      };
    } else if (screenshot_url) {
      imageBlock = { type: "image", source: { type: "url", url: screenshot_url } };
    }
    if (imageBlock) userContent.push(imageBlock);

    const messagesUrl = anthropicMessagesUrl();
    const model = resolveClaudeModel();
    console.log(`[llm] agent-heal-script model=${model} url=${messagesUrl}`);

    const resp = await fetchAnthropicMessages(messagesUrl, {
      method: "POST",
      headers: {
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model,
        max_tokens: 4096,
        system: `${sys}\n\nRespond with a single valid JSON object only. No prose, no markdown fences.`,
        messages: [{ role: "user", content: userContent }],
        temperature: 0.2,
      }),
    });

    if (!resp.ok) throw new Error(`Anthropic ${resp.status} (${messagesUrl}): ${await resp.text()}`);
    const data = await resp.json();
    const raw = (data.content || []).map((c: any) => c?.text || "").join("") || "";
    const parsed = tryParseJson(raw) || {};
    if (typeof parsed.patched_playwright_code === "string") {
      parsed.patched_playwright_code = parsed.patched_playwright_code
        .replace(/^\s*```(?:javascript|js)?\s*/i, "")
        .replace(/\s*```\s*$/i, "");
    }

    return new Response(JSON.stringify({ proposal: parsed, used_screenshot: !!imageBlock }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (e: any) {
    return new Response(JSON.stringify({ error: String(e?.message || e) }), {
      status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
