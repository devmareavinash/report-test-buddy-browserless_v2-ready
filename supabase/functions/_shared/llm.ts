// Anthropic Messages API dispatch.
// Supports direct Anthropic (api.anthropic.com) and Bayer Magentic gateway via:
//   ANTHROPIC_API_KEY, ANTHROPIC_BASE_URL, CLAUDE_MODEL
//
// Deno fetch honors HTTP_PROXY / HTTPS_PROXY / NO_PROXY from the process env
// (same path as other outbound calls). On Bayer VDI, scripts/dev-backend.ps1
// sets the corp proxy + DENO_TLS_CA_STORE=system + --unsafely-ignore-certificate-errors.
// Magentic (chat.int.bayer.com) is added to NO_PROXY by load-env.ps1 so the
// repair POST matches Python hello (direct to the internal gateway, not Skyhigh).

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";

type Msg = { role: "system" | "user" | "assistant"; content: string };

const ANTHROPIC_VERSION = "2023-06-01";
const DEFAULT_MODEL = "claude-sonnet-4.5";
/** Same Magentic host as scripts/test_anthropic_hello.py and .env.example. */
const DEFAULT_BASE_URL = "https://chat.int.bayer.com/anthropic";

/** VDI-realistic default. Repair sends a head+tail excerpt; 90s is too short on this gateway. */
const DEFAULT_ANTHROPIC_FETCH_TIMEOUT_MS = 240_000;
/** 1 initial try + 2 retries on timeout / fetch failed. */
const ANTHROPIC_FETCH_MAX_ATTEMPTS = 3;
const ANTHROPIC_FETCH_BACKOFF_MS = 2_000;

/** Base URL without trailing slash (gateway or public Anthropic). */
export function anthropicBaseUrl(): string {
  const raw = (Deno.env.get("ANTHROPIC_BASE_URL") || DEFAULT_BASE_URL).trim();
  return raw.replace(/\/+$/, "") || DEFAULT_BASE_URL;
}

/** Full Messages API endpoint. */
export function anthropicMessagesUrl(): string {
  const base = anthropicBaseUrl();
  if (/\/v1\/messages$/i.test(base)) return base;
  if (/\/v1$/i.test(base)) return `${base}/messages`;
  return `${base}/v1/messages`;
}

export function resolveClaudeModel(configured?: string | null): string {
  // Prefer explicit env (Bayer projects use CLAUDE_MODEL).
  const fromEnv = (Deno.env.get("CLAUDE_MODEL") || Deno.env.get("ANTHROPIC_MODEL") || "").trim();
  if (fromEnv) return fromEnv;
  if (configured && /^claude/i.test(configured)) return configured;
  return DEFAULT_MODEL;
}

export function anthropicFetchTimeoutMs(): number {
  const raw = Number(Deno.env.get("ANTHROPIC_FETCH_TIMEOUT_MS") || "");
  if (Number.isFinite(raw) && raw >= 30_000) return Math.min(Math.floor(raw), 600_000);
  return DEFAULT_ANTHROPIC_FETCH_TIMEOUT_MS;
}

function outboundProxyUrl(): string {
  return (
    Deno.env.get("HTTPS_PROXY") ||
    Deno.env.get("https_proxy") ||
    Deno.env.get("HTTP_PROXY") ||
    Deno.env.get("http_proxy") ||
    ""
  ).trim();
}

function noProxyList(): string {
  return (Deno.env.get("NO_PROXY") || Deno.env.get("no_proxy") || "").trim();
}

function hostInNoProxy(hostname: string): boolean {
  const list = noProxyList();
  if (!list) return false;
  const host = hostname.toLowerCase();
  return list.split(",").map((s) => s.trim().toLowerCase()).filter(Boolean).some((entry) => {
    if (entry === "*") return true;
    if (entry.startsWith(".")) return host === entry.slice(1) || host.endsWith(entry);
    return host === entry || host.endsWith(`.${entry}`);
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function fetchErrorCause(e: unknown): string {
  const err = e as { name?: string; message?: string; cause?: { message?: string } };
  return err?.cause?.message || err?.message || String(e);
}

function isTimeoutError(e: unknown): boolean {
  const err = e as { name?: string };
  return err?.name === "TimeoutError" || /timeout|abort/i.test(fetchErrorCause(e));
}

function isRetryableFetchError(e: unknown): boolean {
  const cause = fetchErrorCause(e);
  return isTimeoutError(e) || /fetch failed|network|connection|reset|refused/i.test(cause);
}

function wrapFetchError(messagesUrl: string, e: unknown): Error {
  const cause = fetchErrorCause(e);
  return new Error(
    isTimeoutError(e)
      ? `Anthropic fetch timed out (${messagesUrl}): ${cause}`
      : `Anthropic fetch failed (${messagesUrl}): ${cause}`,
  );
}

type DenoHttpClient = { close?: () => void };

/** Explicit proxy client when env proxy is set and the host is not in NO_PROXY. */
function maybeProxyClient(messagesUrl: string): DenoHttpClient | undefined {
  const proxy = outboundProxyUrl();
  if (!proxy) return undefined;
  let hostname = "";
  try {
    hostname = new URL(messagesUrl).hostname;
  } catch {
    return undefined;
  }
  if (hostInNoProxy(hostname)) return undefined;
  if (typeof Deno.createHttpClient !== "function") return undefined;
  try {
    return Deno.createHttpClient({ proxy: { url: proxy } });
  } catch (e) {
    console.warn(
      `[llm] createHttpClient skipped (${String((e as Error)?.message || e)}); default fetch still uses env HTTP(S)_PROXY`,
    );
    return undefined;
  }
}

/**
 * POST to Magentic/Anthropic with VDI-realistic timeout + retries.
 * Does not log or return the API key.
 */
export async function fetchAnthropicMessages(
  messagesUrl: string,
  init: RequestInit,
): Promise<Response> {
  const timeoutMs = anthropicFetchTimeoutMs();
  const proxy = outboundProxyUrl();
  let hostname = "";
  try {
    hostname = new URL(messagesUrl).hostname;
  } catch {
    /* ignore */
  }
  const bypass = hostname ? hostInNoProxy(hostname) : false;
  const tlsStore = (Deno.env.get("DENO_TLS_CA_STORE") || "").trim() || "(unset)";

  console.log(
    `[llm] fetch ${messagesUrl} timeout_ms=${timeoutMs} attempts=${ANTHROPIC_FETCH_MAX_ATTEMPTS} ` +
      `proxy=${proxy || "(none)"} no_proxy=${noProxyList() || "(none)"} ` +
      `proxy_bypass=${bypass} tls_ca_store=${tlsStore}`,
  );

  const client = maybeProxyClient(messagesUrl);
  try {
    let lastErr: Error | null = null;
    for (let attempt = 1; attempt <= ANTHROPIC_FETCH_MAX_ATTEMPTS; attempt++) {
      try {
        const req: RequestInit & { client?: DenoHttpClient } = {
          ...init,
          signal: AbortSignal.timeout(timeoutMs),
        };
        if (client) req.client = client;
        return await fetch(messagesUrl, req);
      } catch (e) {
        lastErr = wrapFetchError(messagesUrl, e);
        if (!isRetryableFetchError(e) || attempt >= ANTHROPIC_FETCH_MAX_ATTEMPTS) {
          throw lastErr;
        }
        const backoff = ANTHROPIC_FETCH_BACKOFF_MS * attempt;
        console.warn(
          `[llm] ${lastErr.message} — retry ${attempt}/${ANTHROPIC_FETCH_MAX_ATTEMPTS - 1} in ${backoff}ms`,
        );
        await sleep(backoff);
      }
    }
    throw lastErr || new Error(`Anthropic fetch failed (${messagesUrl})`);
  } finally {
    try {
      client?.close?.();
    } catch {
      /* ignore */
    }
  }
}

export async function callAgent(opts: {
  agentKey: string;
  messages: Msg[];
  json?: boolean;
  /** Output cap. Repair uses a smaller budget so Magentic can finish inside the fetch timeout. */
  maxTokens?: number;
}): Promise<string> {
  // Prefer service role; fall back to anon (same rules as getSupabase).
  // Do not pass empty/placeholder keys into createClient — it throws "supabaseKey is required".
  let cfg: { model?: string; temperature?: number; system_instruction?: string } | null = null;
  try {
    const supabase = getSupabase();
    const { data } = await supabase
      .from("agent_model_config")
      .select("model, temperature, system_instruction")
      .eq("agent_key", opts.agentKey)
      .maybeSingle();
    cfg = data as any;
  } catch (e) {
    console.warn(
      `callAgent: agent_model_config lookup skipped (${String((e as Error)?.message || e)}) — using defaults`,
    );
  }

  const apiKey = (Deno.env.get("ANTHROPIC_API_KEY") || "").trim();
  if (!apiKey) throw new Error("Missing ANTHROPIC_API_KEY");

  const messagesUrl = anthropicMessagesUrl();
  const model = resolveClaudeModel((cfg as any)?.model);
  const temperature = (cfg as any)?.temperature ?? 0.2;
  const sysOverride = (cfg as any)?.system_instruction as string | undefined;

  console.log(
    `[llm] callAgent agent=${opts.agentKey} model=${model} url=${messagesUrl} has_key=true`,
  );

  // Anthropic requires `system` at top-level and only user/assistant in messages.
  const systemParts: string[] = [];
  if (sysOverride) systemParts.push(sysOverride);
  const chat: { role: "user" | "assistant"; content: string }[] = [];
  for (const m of opts.messages) {
    if (m.role === "system") systemParts.push(m.content);
    else chat.push({ role: m.role, content: m.content });
  }

  let system = systemParts.filter(Boolean).join("\n\n");
  if (opts.json) {
    system = `${system}\n\nRespond with a single valid JSON object only. Do not include any prose or markdown fences.`.trim();
  }

  // Scripts agent emits long Playwright code. Repair stays leaner so the
  // Magentic gateway can finish inside ANTHROPIC_FETCH_TIMEOUT_MS.
  const maxTokens = opts.maxTokens ?? (opts.agentKey === "scripts" ? 16000 : 8192);
  const body: any = {
    model,
    max_tokens: maxTokens,
    temperature,
    messages: chat,
  };
  if (system) body.system = system;

  console.log(
    `[llm] callAgent body_bytes=${JSON.stringify(body).length} max_tokens=${maxTokens} timeout_ms=${anthropicFetchTimeoutMs()}`,
  );

  const resp = await fetchAnthropicMessages(messagesUrl, {
    method: "POST",
    headers: {
      "x-api-key": apiKey,
      "anthropic-version": ANTHROPIC_VERSION,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });

  if (!resp.ok) {
    const t = await resp.text();
    throw new Error(`Anthropic ${resp.status} (${messagesUrl}): ${t}`);
  }
  const data = await resp.json();
  return (data.content || []).map((c: any) => c?.text || "").join("") || "";
}

export function getSupabase() {
  const url = (Deno.env.get("SUPABASE_URL") || "").trim();
  const serviceRole = (Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "").trim();
  const anon = (Deno.env.get("SUPABASE_ANON_KEY") || "").trim();
  // JWTs are long; ignore placeholders like "" / "x" so we fall back to anon.
  const key = (serviceRole.length > 40 ? serviceRole : "") || (anon.length > 40 ? anon : "") || serviceRole || anon;
  if (!url || !key) {
    throw new Error("SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY (or SUPABASE_ANON_KEY) are required");
  }
  if (key.length <= 40) {
    console.warn("getSupabase: Supabase key looks too short — check SUPABASE_SERVICE_ROLE_KEY / SUPABASE_ANON_KEY in .env");
  }
  return createClient(url, key);
}

export function tryParseJson(s: string): any {
  try { return JSON.parse(s); } catch { /* */ }
  const m = s.match(/```json\s*([\s\S]*?)```/) || s.match(/```\s*([\s\S]*?)```/);
  if (m) { try { return JSON.parse(m[1]); } catch { /* */ } }
  const start = s.indexOf("{");
  const arr = s.indexOf("[");
  const i = start === -1 ? arr : (arr === -1 ? start : Math.min(start, arr));
  if (i >= 0) {
    try { return JSON.parse(s.slice(i)); } catch { /* */ }
  }
  return null;
}
