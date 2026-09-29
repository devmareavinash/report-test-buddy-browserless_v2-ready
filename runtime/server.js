// In-app Playwright runtime.
//
// Contract (matches what supabase/functions/playwright-runtime/index.ts expects):
//
//   POST /run
//     body: { mode: "headed" | "headless", code: string, scenario_id?: string }
//     200:  { live_url?: string, extracted?: object, screenshot_url?: string, job_id: string }
//
//   GET  /live/:jobId       -> simple HTML page that polls /frame/:jobId
//   GET  /frame/:jobId.png  -> latest screenshot of the running session
//   GET  /screenshot/:jobId.png -> final screenshot (headless mode)
//   GET  /healthz
//
// User code is executed as an async function with a `page` (and `browser`,
// `context`) in scope. The script is expected to either:
//   - assign extracted KPIs to `globalThis.__extracted = { ... }`, OR
//   - `return { ...kpis }` from the top-level (we wrap it in async function).
//
// Headed mode launches the same headless Chromium but starts a screencast
// loop so the UI can iframe /live/:jobId and watch frames update in near
// real time — fully self-contained, no VNC/X server required.

const express = require("express");
const path = require("path");
const fs = require("fs");
const crypto = require("crypto");
const { chromium } = require("playwright");

const app = express();
app.use(express.json({ limit: "2mb" }));

const PORT = Number(process.env.PORT || 8001);
const PUBLIC_BASE = process.env.RUNTIME_PUBLIC_BASE || ""; // e.g. https://runtime.example.com

// jobId -> { page, browser, frame: Buffer, finalShot: Buffer, status }
const jobs = new Map();

function newJobId() { return crypto.randomBytes(8).toString("hex"); }
function urlFor(p) { return PUBLIC_BASE ? `${PUBLIC_BASE}${p}` : p; }

async function runScript({ mode, code, jobId }) {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1366, height: 800 } });
  const page = await context.newPage();
  const job = { browser, context, page, status: "running", mode, startedAt: Date.now() };
  jobs.set(jobId, job);

  // Screencast loop for headed mode
  let screencast;
  if (mode === "headed") {
    screencast = setInterval(async () => {
      try { job.frame = await page.screenshot({ type: "png", fullPage: false }); } catch {}
    }, 750);
  }

  let extracted = {};
  try {
    // eslint-disable-next-line no-new-func
    const fn = new Function(
      "page", "browser", "context", "console",
      `return (async () => { ${code}\n; return globalThis.__extracted || {}; })();`
    );
    extracted = (await fn(page, browser, context, console)) || {};
  } catch (e) {
    job.status = "error";
    job.error = String(e);
    if (screencast) clearInterval(screencast);
    try { job.finalShot = await page.screenshot({ type: "png" }); } catch {}
    await browser.close().catch(() => {});
    throw e;
  }

  if (screencast) clearInterval(screencast);
  try { job.finalShot = await page.screenshot({ type: "png" }); } catch {}
  job.status = "done";
  await browser.close().catch(() => {});
  return { extracted };
}

app.get("/healthz", (_req, res) => res.type("text/plain").send("ok"));

app.post("/run", async (req, res) => {
  const { mode = "headless", code = "", scenario_id } = req.body || {};
  if (!code) return res.status(400).json({ error: "code required" });
  const jobId = newJobId();

  if (mode === "headed") {
    // Fire and forget; return the live viewer URL immediately.
    runScript({ mode, code, jobId }).catch((e) => console.error("[headed] error", e));
    return res.json({
      job_id: jobId,
      live_url: urlFor(`/live/${jobId}`),
      mode,
      scenario_id,
    });
  }

  try {
    const { extracted } = await runScript({ mode, code, jobId });
    res.json({
      job_id: jobId,
      mode,
      extracted,
      screenshot_url: urlFor(`/screenshot/${jobId}.png`),
      scenario_id,
    });
  } catch (e) {
    res.status(500).json({ error: String(e), job_id: jobId });
  }
});

app.get("/live/:jobId", (req, res) => {
  const html = fs.readFileSync(path.join(__dirname, "live.html"), "utf8")
    .replace(/__JOB_ID__/g, req.params.jobId);
  res.type("html").send(html);
});

app.get("/frame/:jobId.png", (req, res) => {
  const job = jobs.get(req.params.jobId);
  if (!job?.frame) return res.status(204).end();
  res.type("png").send(job.frame);
});

app.get("/screenshot/:jobId.png", (req, res) => {
  const job = jobs.get(req.params.jobId);
  const buf = job?.finalShot || job?.frame;
  if (!buf) return res.status(404).end();
  res.type("png").send(buf);
});

app.listen(PORT, () => console.log(`[runtime] listening on :${PORT}`));
