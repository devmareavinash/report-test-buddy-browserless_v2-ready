/** Append-only headed launch diagnostics (local VDI debugging). */

function logPath(): string {
  const override = (Deno.env.get("HEADED_LAUNCH_LOG") || "").trim();
  if (override) return override;
  // backend/cwd when started via scripts/dev-backend.ps1
  return `${Deno.cwd()}/logs/headed-launch.jsonl`;
}

export async function logHeadedLaunch(event: Record<string, unknown>): Promise<void> {
  const line = JSON.stringify({ ts: new Date().toISOString(), ...event }) + "\n";
  try {
    const path = logPath();
    await Deno.mkdir(path.replace(/[/\\][^/\\]+$/, ""), { recursive: true });
    await Deno.writeTextFile(path, line, { append: true });
  } catch (e) {
    console.warn("headed-launch-log failed:", String((e as any)?.message || e));
  }
  console.log(`headed-launch: ${line.trim()}`);
}
