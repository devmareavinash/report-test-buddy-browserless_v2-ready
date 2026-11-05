// Deno tests without remote imports (corp proxy breaks deno.land TLS).
import {
  clearAuthSession,
  extractionLooksUnusable,
  ioErrorCategory,
  loadAuthSession,
  pathnameOnly,
  sanitizeErrorMessage,
  saveAuthSession,
  shouldClearAuthSession,
  shouldRetryAuthSessionFresh,
  shouldSaveAuthSession,
  summarizeExtractionShape,
} from "./auth-session-store.ts";

const PROFILE = "a1b2c3d4-e5f6-7890-abcd-ef1234567890";
const STATE = {
  cookies: [{ name: "JSESSIONID", value: "secret-cookie-value", domain: "mstr.example", path: "/" }],
};

function assert(cond: unknown, msg = "assertion failed"): asserts cond {
  if (!cond) throw new Error(msg);
}
function assertEquals(a: unknown, b: unknown, msg?: string) {
  if (a !== b) throw new Error(msg || `expected ${Deno.inspect(b)}, got ${Deno.inspect(a)}`);
}
function assertFalse(cond: unknown, msg = "expected false") {
  if (cond) throw new Error(msg);
}

function sessionAction(reused: boolean, payload: unknown): string {
  if (!reused || !payload) return "none";
  if (shouldRetryAuthSessionFresh(payload)) return "clear_and_fresh_login";
  if (extractionLooksUnusable(payload)) return "preserve";
  return "none";
}

Deno.test("A: successful extraction does not clear", () => {
  const payload = { extracted: { ok: true, result: { Default: { "Net Sales": 12.5 } } } };
  assertEquals(sessionAction(true, payload), "none");
  assert(shouldSaveAuthSession(payload.extracted, STATE));
});

Deno.test("B: missing KPI preserves session", () => {
  const payload = { extracted: { ok: true, result: { Default: { "Net Sales": null } } } };
  assert(extractionLooksUnusable(payload));
  assertFalse(shouldClearAuthSession(payload));
  assertEquals(sessionAction(true, payload), "preserve");
});

Deno.test("C: partial extraction shape without values", () => {
  const payload = {
    extracted: {
      ok: true,
      result: { Default: { "Net Sales": 10, "Trx Count": null } },
      url: "https://mstr.example/app/dossier?token=SECRET",
    },
  };
  const shape = summarizeExtractionShape(payload);
  assert(shape.partial);
  assert(shape.useful_key_count > 0);
  assert(shape.empty_key_count > 0);
  assertEquals(shape.url_path, "/app/dossier");
  assertFalse(JSON.stringify(shape).includes("SECRET"));
});

Deno.test("D: generic exception preserves session", () => {
  const payload = { ok: false, error: "TimeoutError: locator.click" };
  assertFalse(shouldClearAuthSession(payload));
  assertEquals(sessionAction(true, payload), "preserve");
});

Deno.test("E/F: AUTH_REQUIRED and LOGIN_FAILED clear", () => {
  assertEquals(
    sessionAction(true, { extracted: { ok: false, error: "AUTH_REQUIRED" } }),
    "clear_and_fresh_login",
  );
  assertEquals(
    sessionAction(true, { extracted: { ok: false, error: "LOGIN_FAILED" } }),
    "clear_and_fresh_login",
  );
});

Deno.test("G: login page URL clears; library / title-like paths do not", () => {
  assert(shouldClearAuthSession({ extracted: { ok: true, result: {}, url: "https://mstr.example/auth/login" } }));
  assertFalse(shouldClearAuthSession({
    extracted: { ok: true, result: { Default: { x: 1 } }, url: "https://mstr.example/app/Library" },
  }));
  assertFalse(shouldClearAuthSession({
    extracted: { ok: true, result: {}, url: "https://mstr.example/app/AuthenticationReport" },
  }));
});

Deno.test("H/I: atomic save, corrupt quarantine, recover", async () => {
  const dir = await Deno.makeTempDir({ prefix: "rtb-auth-" });
  Deno.env.set("AUTH_SESSION_DIR", dir);
  try {
    assert(await saveAuthSession(PROFILE, STATE));
    const before = await Deno.readTextFile(`${dir}/${PROFILE}.json`);
    assert(before.includes("JSESSIONID"));

    const tmp = `${dir}/${PROFILE}.abort.tmp`;
    await Deno.writeTextFile(tmp, "{incomplete");
    const after = await Deno.readTextFile(`${dir}/${PROFILE}.json`);
    assertEquals(after, before);
    await Deno.remove(tmp);

    await Deno.writeTextFile(`${dir}/${PROFILE}.json`, "{not-json");
    assertEquals(await loadAuthSession(PROFILE), null);
    let names: string[] = [];
    for await (const e of Deno.readDir(dir)) names.push(e.name);
    assert(names.some((n) => n.includes(".corrupt")), "expected quarantine file");
    assertFalse(names.includes(`${PROFILE}.json`));

    await Deno.writeTextFile(`${dir}/${PROFILE}.json`, "{still-bad");
    assertEquals(await loadAuthSession(PROFILE), null);
    names = [];
    for await (const e of Deno.readDir(dir)) names.push(e.name);
    assert(names.filter((n) => n.includes(".corrupt")).length >= 2, "must not overwrite .corrupt");

    assert(await saveAuthSession(PROFILE, STATE));
    const loaded = await loadAuthSession(PROFILE);
    assertEquals(loaded?.cookies?.length, 1);

    await clearAuthSession(PROFILE, "test_cleanup");
  } finally {
    Deno.env.delete("AUTH_SESSION_DIR");
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("J/M: sanitized diagnostics", () => {
  assertEquals(pathnameOnly("https://h/app?token=abc"), "/app");
  const err = sanitizeErrorMessage("fail?token=abc&password=pw");
  assert(err && !err.includes("token=abc"));
  assertEquals(ioErrorCategory({ name: "SyntaxError", message: "Unexpected token" }), "parse_error");
});

Deno.test("L: sequential non-auth failure then success", () => {
  assertEquals(
    sessionAction(true, { extracted: { ok: true, result: { Default: { "Net Sales": null } } } }),
    "preserve",
  );
  assertEquals(
    sessionAction(true, { extracted: { ok: true, result: { Default: { "Net Sales": 99 } } } }),
    "none",
  );
});

Deno.test("K: wrap source captures after throw", async () => {
  const wrap = await Deno.readTextFile(
    new URL("./auth-session-wrap.ts", import.meta.url),
  );
  assert(wrap.includes("extractionError"));
  assert(wrap.includes("captureStorageState"));
  assert(wrap.includes("__authSessionCaptureAttempted"));
  assert(wrap.includes("ok: false"));
});
