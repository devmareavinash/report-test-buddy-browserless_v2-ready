// Gateway wrapper around playwright-runtime: load/save MicroStrategy sessions
// keyed by credential profile. playwright-runtime itself is left unchanged.

import { getSupabaseForRequest } from "./auth.ts";
import { fetchCanonicalScript } from "./canonical-script.ts";
import { authSessionLog } from "./auth-session-log.ts";
import {
  clearAuthSession,
  extractionLooksUnusable,
  loadAuthSession,
  saveAuthSession,
  shouldClearAuthSession,
  shouldSaveAuthSession,
} from "./auth-session-store.ts";
import {
  extractCapturedStorageState,
  stripCapturedStorageState,
  wrapCodeWithAuthSession,
} from "./auth-session-wrap.ts";

type Handler = (req: Request) => Response | Promise<Response>;

function asReportRow(reports: unknown): Record<string, any> {
  if (!reports) return {};
  if (Array.isArray(reports)) return (reports[0] && typeof reports[0] === "object") ? reports[0] : {};
  return typeof reports === "object" ? reports as Record<string, any> : {};
}

async function resolveCredentialProfileId(
  req: Request,
  scenarioId: string | undefined,
  target: "main" | "reference",
): Promise<string | null> {
  if (!scenarioId) return null;
  try {
    const sb = getSupabaseForRequest(req);
    const { data: script } = await fetchCanonicalScript(
      sb,
      scenarioId,
      "credential_profile_id, reference_credential_profile_id",
    );
    const { data: scenario } = await sb.from("scenarios")
      .select("reports(credential_profile_id, reference_credential_profile_id)")
      .eq("id", scenarioId)
      .maybeSingle();
    const report = asReportRow(scenario?.reports);
    if (target === "reference") {
      return script?.reference_credential_profile_id
        || report.reference_credential_profile_id
        || script?.credential_profile_id
        || report.credential_profile_id
        || null;
    }
    return script?.credential_profile_id || report.credential_profile_id || null;
  } catch (e) {
    authSessionLog("auth_session_profile_resolve_failed", { error: String(e) });
    return null;
  }
}

async function invokePlaywright(
  handler: Handler,
  req: Request,
  body: Record<string, unknown>,
  code: string,
): Promise<{ raw?: Response; status: number; headers: Headers; payload: any }> {
  const nextBody = { ...body, code };
  const headers = new Headers(req.headers);
  headers.set("content-type", "application/json");
  const nextReq = new Request(req.url, {
    method: req.method,
    headers,
    body: JSON.stringify(nextBody),
  });
  const resp = await handler(nextReq);
  const contentType = resp.headers.get("content-type") || "";
  if (!contentType.includes("application/json")) {
    return { raw: resp, status: resp.status, headers: resp.headers, payload: null };
  }
  try {
    return { status: resp.status, headers: resp.headers, payload: await resp.json() };
  } catch {
    return { raw: resp, status: resp.status, headers: resp.headers, payload: null };
  }
}

export function withPlaywrightAuthSession(handler: Handler): Handler {
  return async (req: Request) => {
    if (req.method === "OPTIONS") return await handler(req);

    let body: Record<string, unknown>;
    try {
      body = await req.json();
    } catch {
      return await handler(req);
    }

    const scenarioId = typeof body.scenario_id === "string" ? body.scenario_id : undefined;
    const target: "main" | "reference" = body.target === "reference" ? "reference" : "main";
    const code = typeof body.code === "string" ? body.code : "";
    const profileId = await resolveCredentialProfileId(req, scenarioId, target);

    let storageState = null;
    if (profileId) {
      storageState = await loadAuthSession(profileId);
      if (storageState) {
        authSessionLog("auth_session_reuse", {
          target,
          profile: profileId,
          cookies: storageState.cookies?.length || 0,
        });
      }
    } else {
      authSessionLog("auth_session_skip", {
        reason: "no_credential_profile",
        target,
        scenario_id: scenarioId || null,
      });
    }

    const wrappedCode = code ? wrapCodeWithAuthSession(code, storageState) : code;
    if (code && wrappedCode !== code) {
      authSessionLog("auth_session_wrap", {
        target,
        profile: profileId,
        reused: Boolean(storageState),
        code_bytes: wrappedCode.length,
      });
    }

    let reused = Boolean(storageState);
    let attempt = await invokePlaywright(handler, req, body, wrappedCode);

    // Reused MicroStrategy cookies can outlive the server session. Scripts then
    // scrape an empty/login shell without always returning LOGIN_FAILED. Clear
    // and retry once with a fresh login so brand runs recover mid-suite.
    if (profileId && reused && attempt.payload && extractionLooksUnusable(attempt.payload)) {
      authSessionLog("auth_session_reuse_miss_retry_fresh", {
        target,
        profile: profileId,
        scenario_id: scenarioId || null,
      });
      await clearAuthSession(profileId);
      const freshWrapped = code ? wrapCodeWithAuthSession(code, null) : code;
      attempt = await invokePlaywright(handler, req, body, freshWrapped);
      reused = false;
    }

    if (!attempt.payload) {
      return attempt.raw || new Response(JSON.stringify({ error: "playwright_runtime_non_json" }), {
        status: attempt.status || 502,
        headers: { "content-type": "application/json" },
      });
    }

    const payload = attempt.payload;
    const extracted = payload?.extracted ?? payload;
    const captured = extractCapturedStorageState(payload);
    const cookieCount = (captured && typeof captured === "object" && Array.isArray((captured as any).cookies))
      ? (captured as any).cookies.length
      : 0;

    if (profileId) {
      if (shouldClearAuthSession(extracted) || shouldClearAuthSession(payload)) {
        await clearAuthSession(profileId);
      } else if (shouldSaveAuthSession(payload, captured)) {
        await saveAuthSession(profileId, captured);
      } else {
        authSessionLog("auth_session_not_saved", {
          profile: profileId,
          target,
          cookie_count: cookieCount,
          extracted_ok: extracted && typeof extracted === "object" ? (extracted as any).ok : null,
          unusable: extractionLooksUnusable(payload),
        });
      }
    }

    const cleaned = stripCapturedStorageState(payload);
    if (reused) cleaned.auth_session_reused = true;

    return new Response(JSON.stringify(cleaned), {
      status: attempt.status,
      headers: {
        "content-type": "application/json",
        ...Object.fromEntries(
          [...attempt.headers.entries()].filter(([k]) => {
            const key = k.toLowerCase();
            return key !== "content-type" && key !== "content-length";
          }),
        ),
      },
    });
  };
}
