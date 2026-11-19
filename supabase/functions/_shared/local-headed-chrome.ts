/**
 * Solo "Run headed": launch a real Chrome/Edge window on the machine running
 * the Deno backend so you can watch the Playwright script. No ChromeDriver —
 * Playwright uses CDP. Browserless OSS cannot show a desktop window (Chromium
 * is inside Docker + Xvfb).
 */

import { logHeadedLaunch } from "./headed-launch-log.ts";
import {
  headedFallbackHeadless as headedFallbackHeadlessPolicy,
  headedUseLocalChrome as headedUseLocalChromePolicy,
  localHeadedChannel as localHeadedChannelPolicy,
  type EnvLike,
} from "./local-headed-chrome-policy.ts";

export type { EnvLike };
export function headedUseLocalChrome(env: EnvLike = Deno.env): boolean {
  return headedUseLocalChromePolicy(env);
}
export function localHeadedChannel(env: EnvLike = Deno.env): string {
  return localHeadedChannelPolicy(env);
}
export function headedFallbackHeadless(env: EnvLike = Deno.env): boolean {
  return headedFallbackHeadlessPolicy(env);
}

async function runWrappedOnPage(page: any, wrapped: string): Promise<any> {
  const parseable = String(wrapped || "").replace(
    /^[ \t]*export\s+default\s+/m,
    "const __browserlessEntrypoint = ",
  );
  const getEntry = new Function(`${parseable}\n; return __browserlessEntrypoint;`);
  const entry = getEntry();
  if (typeof entry !== "function") {
    throw new Error("local-headed: wrapped script has no default entrypoint");
  }
  return await entry({ page });
}

type PlaywrightModule = {
  chromium: {
    launch: (options: Record<string, unknown>) => Promise<any>;
  };
};

let playwrightLoad: Promise<PlaywrightModule> | null = null;

async function loadPlaywright(): Promise<PlaywrightModule> {
  if (!playwrightLoad) {
    playwrightLoad = import("playwright-core")
      .catch(() => import("npm:playwright-core@1.47.0"))
      .then((m: any) => m as PlaywrightModule)
      .catch((err) => {
        playwrightLoad = null;
        throw err;
      });
  }
  return playwrightLoad;
}

/** Adapt Browserless-style screenshot({ encoding: 'base64' }) for Playwright Node. */
function adaptPage(page: any): any {
  const originalScreenshot = page.screenshot.bind(page);
  page.screenshot = async (opts: Record<string, unknown> = {}) => {
    const encoding = opts.encoding;
    const rest = { ...opts };
    delete rest.encoding;
    const buf = await originalScreenshot(rest);
    if (encoding === "base64") {
      if (typeof buf === "string") return buf;
      const bytes = buf instanceof Uint8Array ? buf : new Uint8Array(await buf);
      let binary = "";
      for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
      return btoa(binary);
    }
    return buf;
  };
  return page;
}

async function resolveBrowserExecutable(channel: string): Promise<string | null> {
  const local = Deno.env.get("LOCALAPPDATA") || "";
  const pf = Deno.env.get("PROGRAMFILES") || "C:\\Program Files";
  const pf86 = Deno.env.get("PROGRAMFILES(X86)") || "C:\\Program Files (x86)";
  const candidates =
    channel === "msedge"
      ? [
        `${pf}\\Microsoft\\Edge\\Application\\msedge.exe`,
        `${pf86}\\Microsoft\\Edge\\Application\\msedge.exe`,
      ]
      : [
        `${pf}\\Google\\Chrome\\Application\\chrome.exe`,
        `${pf86}\\Google\\Chrome\\Application\\chrome.exe`,
        `${local}\\Google\\Chrome\\Application\\chrome.exe`,
      ];
  for (const path of candidates) {
    try {
      await Deno.stat(path);
      return path;
    } catch { /* try next */ }
  }
  return null;
}

function withVisibleArgs(args: string[]): string[] {
  const extra = ["--start-maximized", "--disable-backgrounding-occluded-windows"];
  const out = [...args];
  for (const flag of extra) {
    if (!out.some((a) => a.toLowerCase() === flag.toLowerCase())) out.push(flag);
  }
  return out;
}

export async function runOneShotLocalHeadedChrome(
  opts: {
    wrappedCode: string;
    launchArgs: string[];
    viewport: { width: number; height: number; deviceScaleFactor?: number };
    channel?: string;
  },
): Promise<{
  extracted: any;
  screenshot_b64: string | null;
  live_url: string | null;
  provider: string;
  mode: "headed";
}> {
  const channel = opts.channel || localHeadedChannel();
  const pw = await loadPlaywright();
  const launchArgs = withVisibleArgs(opts.launchArgs);
  const exe = await resolveBrowserExecutable(channel === "msedge" ? "msedge" : "chrome");

  await logHeadedLaunch({
    event: "launch_start",
    channel,
    executablePath: exe,
    args: launchArgs,
    cwd: Deno.cwd(),
  });

  let browser: any = null;
  let page: any = null;
  let lastErr: unknown = null;
  try {
    // Playwright adds --no-startup-window by default, which starts Chrome with
    // no visible UI on this VDI (MainWindowHandle=0). Drop that flag.
    const visibleLaunch = {
      headless: false,
      args: launchArgs,
      ignoreDefaultArgs: ["--no-startup-window"],
    };
    const attempts: Array<Record<string, unknown>> = [];
    if (exe) {
      attempts.push({ ...visibleLaunch, executablePath: exe });
    }
    if (channel !== "chromium") {
      attempts.push({ ...visibleLaunch, channel });
    }
    if (channel !== "msedge") {
      attempts.push({ ...visibleLaunch, channel: "msedge" });
    }

    for (const launchOpts of attempts) {
      try {
        browser = await pw.chromium.launch(launchOpts);
        await logHeadedLaunch({
          event: "launch_ok",
          via: launchOpts.executablePath ? "executablePath" : "channel",
          detail: String(launchOpts.executablePath || launchOpts.channel || ""),
        });
        break;
      } catch (e) {
        lastErr = e;
        await logHeadedLaunch({
          event: "launch_attempt_failed",
          detail: String(launchOpts.executablePath || launchOpts.channel || ""),
          error: String((e as any)?.message || e).slice(0, 400),
        });
      }
    }
    if (!browser) {
      throw lastErr || new Error("local-headed: no Chrome/Edge could launch");
    }

    const context = await browser.newContext({
      viewport: { width: opts.viewport.width, height: opts.viewport.height },
      ignoreHTTPSErrors: true,
    });
    page = await context.newPage();
    try {
      await page.bringToFront();
    } catch { /* ignore */ }
    // Prove a visible window before the long MSTR script starts.
    await page.goto("about:blank");
    await page.setContent(
      "<html><body style='font-family:sans-serif;padding:24px;background:#111;color:#fff'>" +
        "<h1>RTB Run headed</h1><p>If you see this window, headed Chrome is working.</p></body></html>",
    );
    await logHeadedLaunch({ event: "splash_shown" });
    await new Promise((r) => setTimeout(r, 3000));
    try {
      // Best-effort: focus the Chrome window on the interactive Windows desktop.
      const activate = new Deno.Command("powershell.exe", {
        args: [
          "-NoProfile",
          "-Command",
          "(New-Object -ComObject WScript.Shell).AppActivate('RTB Run headed') | Out-Null",
        ],
        stdout: "null",
        stderr: "null",
      });
      await activate.output();
    } catch { /* ignore */ }

    const data = await runWrappedOnPage(adaptPage(page), opts.wrappedCode);
    const screenshot_b64 = data?.screenshot || null;
    if (data && typeof data === "object") delete (data as any).screenshot;
    await logHeadedLaunch({ event: "script_done", ok: data?.ok !== false });
    return {
      extracted: data,
      screenshot_b64,
      live_url: null,
      provider: "local-chrome",
      mode: "headed",
    };
  } catch (e) {
    await logHeadedLaunch({
      event: "launch_or_run_failed",
      error: String((e as any)?.message || e).slice(0, 500),
    });
    throw e;
  } finally {
    if (page) {
      try { await page.close(); } catch { /* ignore */ }
    }
    if (browser) {
      try { await browser.close(); } catch { /* ignore */ }
    }
  }
}
