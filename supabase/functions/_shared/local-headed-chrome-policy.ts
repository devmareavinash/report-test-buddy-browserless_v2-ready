/** Policy helpers for Solo local headed Chrome (no Playwright import — vitest-safe). */

export type EnvLike = { get(key: string): string | undefined };

/**
 * Prefer a visible local Chrome/Edge window for headed Solo runs when the
 * backend is on the host (Windows VDI). Off inside Docker unless forced.
 */
export function headedUseLocalChrome(
  env: EnvLike,
  isDocker: () => boolean = () => {
    try {
      Deno.statSync("/.dockerenv");
      return true;
    } catch {
      return false;
    }
  },
): boolean {
  const explicit = (env.get("HEADED_USE_LOCAL_CHROME") || "").trim().toLowerCase();
  if (explicit === "false" || explicit === "0" || explicit === "no") return false;
  if (explicit === "true" || explicit === "1" || explicit === "yes") return true;
  return !isDocker();
}

/** Installed browser channel for playwright-core (not a Selenium ChromeDriver). */
export function localHeadedChannel(env: EnvLike): string {
  const raw = (env.get("HEADED_LOCAL_CHANNEL") || "chrome").trim().toLowerCase();
  if (raw === "msedge" || raw === "edge") return "msedge";
  if (raw === "chromium") return "chromium";
  return "chrome";
}

/** When false (default), Solo headed does not silently fall back to Browserless. */
export function headedFallbackHeadless(env: EnvLike): boolean {
  const raw = (env.get("HEADED_FALLBACK_HEADLESS") || "").trim().toLowerCase();
  return raw === "true" || raw === "1" || raw === "yes";
}
