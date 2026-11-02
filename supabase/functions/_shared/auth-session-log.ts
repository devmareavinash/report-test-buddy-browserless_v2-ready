// Append-only auth-session events → terminal + logs/auth-session.jsonl
// (same idea as agent-orchestrate.jsonl). Never logs cookie values.

const DEFAULT_LOG_PATH = "./logs/auth-session.jsonl";
let logWrite = Promise.resolve();

function resolveLogPath(): string {
  const fromEnv = (Deno.env.get("AUTH_SESSION_LOG_PATH") || "").trim();
  if (fromEnv) return fromEnv;
  try {
    const u = new URL("../../../logs/auth-session.jsonl", import.meta.url);
    if (u.protocol === "file:") {
      let p = decodeURIComponent(u.pathname);
      if (/^\/[A-Za-z]:\//.test(p)) p = p.slice(1);
      return p;
    }
  } catch { /* fall through */ }
  return DEFAULT_LOG_PATH;
}

export function authSessionLog(evt: string, details: Record<string, unknown> = {}) {
  const line = JSON.stringify({
    component: "auth-session",
    evt,
    timestamp: new Date().toISOString(),
    ...details,
  });
  console.log(line);
  const path = resolveLogPath();
  logWrite = logWrite.then(async () => {
    const split = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
    if (split > 0) await Deno.mkdir(path.slice(0, split), { recursive: true });
    await Deno.writeTextFile(path, `${line}\n`, { append: true, create: true });
  }).catch((error) => {
    console.error(JSON.stringify({
      component: "auth-session",
      evt: "log_write_failed",
      timestamp: new Date().toISOString(),
      error: String(error),
    }));
  });
}
