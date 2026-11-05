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
  shouldRetryAuthSessionFresh,
  shouldSaveAuthSession,
  summarizeExtractionShape,
} from "./auth-session-store.ts";
import {
  extractCapturedStorageState,
  extractCaptureMeta,
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
  } catch {
    authSessionLog("auth_session_profile_resolve_failed", {
      error_category: "resolve_error",
    });
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

function diagFields(
  profileId: string | null,
  target: "main" | "reference",
  scenarioId: string | undefined,
  reused: boolean,
  payload: unknown,
) {
  const shape = summarizeExtractionShape(payload);
  const meta = extractCaptureMeta(payload);
  return {
    profile: profileId,
    target,
    scenario_id: scenarioId || null,
    // Logging limitation: run_id / report_id / combo_id / retry number are not
    // present on the playwright-runtime request body without changing orchestrate
    // or playwright-runtime (out of scope).
    reused,
    extracted_ok: shape.extracted_ok,
    extracted_error: shape.error,
    url_path: shape.url_path,
    useful_key_count: shape.useful_key_count,
    empty_key_count: shape.empty_key_count,
    unusable: shape.unusable,
    partial: shape.partial,
    capture_attempted: meta.capture_attempted,
    capture_succeeded: meta.capture_succeeded,
  };
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
          scenario_id: scenarioId || null,
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
        scenario_id: scenarioId || null,
      });
    }

    let reused = Boolean(storageState);
    let attempt = await invokePlaywright(handler, req, body, wrappedCode);
    let authAttempt = 1;
    // Bound: at most one reuse→fresh retry, plus one extra fresh retry when the
    // first attempt was already fresh (TTL miss / cleared session) but still
    // landed on the login page. Never retry indefinitely.
    const AUTH_FRESH_RETRY_MAX = 2;

    // Clear + fresh-login ONLY on explicit auth failure evidence.
    // Generic empty/partial KPI extraction must preserve the reusable session so
    // later Brand scenarios are not forced into fresh login.
    if (profileId && reused && attempt.payload && shouldRetryAuthSessionFresh(attempt.payload)) {
      authSessionLog("auth_session_reuse_miss_retry_fresh", {
        ...diagFields(profileId, target, scenarioId, true, attempt.payload),
        reason: "auth_failure_evidence",
        session_action: "clear_and_fresh_login",
        attempt: authAttempt + 1,
        max_attempts: AUTH_FRESH_RETRY_MAX,
      });
      await clearAuthSession(profileId, "auth_failure_reuse_miss");
      const freshWrapped = code ? wrapCodeWithAuthSession(code, null) : code;
      attempt = await invokePlaywright(handler, req, body, freshWrapped);
      reused = false;
      authAttempt += 1;
    } else if (
      profileId &&
      reused &&
      attempt.payload &&
      extractionLooksUnusable(attempt.payload) &&
      !shouldClearAuthSession(attempt.payload)
    ) {
      authSessionLog("auth_session_extraction_failed_session_preserved", {
        ...diagFields(profileId, target, scenarioId, true, attempt.payload),
        reason: "non_auth_unusable_extraction",
        session_action: "preserve",
        session_preserved: true,
      });
    }

    // Fresh-from-start (or after reuse-miss) still on login → one bounded retry.
    if (
      profileId &&
      !reused &&
      authAttempt < AUTH_FRESH_RETRY_MAX &&
      attempt.payload &&
      shouldRetryAuthSessionFresh(attempt.payload)
    ) {
      authSessionLog("auth_session_fresh_login_retry", {
        ...diagFields(profileId, target, scenarioId, false, attempt.payload),
        reason: "auth_failure_after_fresh",
        session_action: "clear_and_fresh_login",
        attempt: authAttempt + 1,
        max_attempts: AUTH_FRESH_RETRY_MAX,
      });
      await clearAuthSession(profileId, "auth_failure_fresh_retry");
      const freshWrapped = code ? wrapCodeWithAuthSession(code, null) : code;
      attempt = await invokePlaywright(handler, req, body, freshWrapped);
      authAttempt += 1;
    }

    if (attempt.payload && typeof attempt.payload === "object") {
      (attempt.payload as any).auth_session_attempts = authAttempt;
      (attempt.payload as any).auth_session_reused = reused;
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
    const shape = summarizeExtractionShape(payload);
    const captureMeta = extractCaptureMeta(payload);

    if (profileId) {
      if (shouldClearAuthSession(extracted) || shouldClearAuthSession(payload)) {
        authSessionLog("auth_session_clear_requested", {
          ...diagFields(profileId, target, scenarioId, reused, payload),
          reason: "auth_failure_evidence",
          cookie_count: cookieCount,
        });
        await clearAuthSession(profileId, "auth_failure_evidence");
      } else if (shouldSaveAuthSession(payload, captured)) {
        await saveAuthSession(profileId, captured);
        if (shape.partial) {
          authSessionLog("auth_session_partial_extraction", {
            ...diagFields(profileId, target, scenarioId, reused, payload),
            cookie_count: cookieCount,
            session_preserved: true,
            session_saved: true,
            // configured KPI count unavailable without orchestrator changes
            configured_count: null,
          });
        }
      } else {
        // Shape fields (partial/unusable/counts) already in diagFields — avoid a second event.
        authSessionLog("auth_session_not_saved", {
          ...diagFields(profileId, target, scenarioId, reused, payload),
          cookie_count: cookieCount,
          reason: shape.unusable ? "unusable_extraction" : "invalid_or_missing_capture",
          session_preserved: true,
          capture_attempted: captureMeta.capture_attempted,
          capture_succeeded: captureMeta.capture_succeeded,
        });
      }
    }

    const cleaned = stripCapturedStorageState(payload);
    cleaned.auth_session_reused = reused;
    cleaned.auth_session_attempts = authAttempt;

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
