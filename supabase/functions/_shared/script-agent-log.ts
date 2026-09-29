/**
 * Progress logs for script generation + validation agents.
 * Writes JSON + .log under logs/script-agents/ and mirrors each event to the terminal.
 */

export type ScriptAgentName = "script-gen" | "script-validate";
export type ScriptAgentLogLevel = "info" | "warn" | "error";

export type ScriptAgentLogEvent = {
  ts: string;
  agent: ScriptAgentName;
  phase: string;
  level: ScriptAgentLogLevel;
  message: string;
  data?: Record<string, unknown>;
};

export type ScriptAgentLogDocument = {
  run_id: string;
  started_at: string;
  finished_at?: string;
  status?: "running" | "ok" | "failed" | "skipped";
  scenario_id?: string;
  target?: string;
  title?: string;
  log_file?: string;
  json_log_file?: string;
  summary?: Record<string, unknown>;
  events: ScriptAgentLogEvent[];
};

function resolveLogDir(): string {
  const override = (Deno.env.get("SCRIPT_AGENT_LOG_DIR") || "").trim();
  if (override) return override.replace(/[\\/]+$/, "");
  // supabase/functions/_shared → repo root /logs/script-agents
  const url = new URL("../../../logs/script-agents", import.meta.url);
  let path = decodeURIComponent(url.pathname);
  if (Deno.build.os === "windows" && /^\/[A-Za-z]:/.test(path)) path = path.slice(1);
  return path;
}

function stamp(): string {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

function shortId(): string {
  return crypto.randomUUID().slice(0, 8);
}

function termPrefix(agent: ScriptAgentName, level: ScriptAgentLogLevel): string {
  const tag = agent === "script-gen" ? "script-gen" : "script-validate";
  if (level === "error") return `[${tag}] ERROR`;
  if (level === "warn") return `[${tag}] WARN`;
  return `[${tag}]`;
}

function formatLine(event: ScriptAgentLogEvent): string {
  const dataHint = event.data && Object.keys(event.data).length
    ? ` ${JSON.stringify(event.data)}`
    : "";
  return `${event.ts} ${termPrefix(event.agent, event.level)} ${event.phase}: ${event.message}${dataHint}`;
}

export class ScriptAgentSessionLog {
  readonly runId: string;
  readonly startedAt: string;
  /** Human-readable .log path (primary). */
  readonly filePath: string;
  /** Structured JSON twin of the same session. */
  readonly jsonFilePath: string;
  readonly latestPath: string;
  readonly latestJsonPath: string;
  private doc: ScriptAgentLogDocument;
  private writeEnabled: boolean;
  private textLines: string[] = [];

  private constructor(opts: {
    runId: string;
    filePath: string;
    jsonFilePath: string;
    latestPath: string;
    latestJsonPath: string;
    writeEnabled: boolean;
    meta: { scenario_id?: string; target?: string; title?: string };
  }) {
    this.runId = opts.runId;
    this.startedAt = new Date().toISOString();
    this.filePath = opts.filePath;
    this.jsonFilePath = opts.jsonFilePath;
    this.latestPath = opts.latestPath;
    this.latestJsonPath = opts.latestJsonPath;
    this.writeEnabled = opts.writeEnabled;
    this.doc = {
      run_id: opts.runId,
      started_at: this.startedAt,
      status: "running",
      scenario_id: opts.meta.scenario_id,
      target: opts.meta.target,
      title: opts.meta.title,
      log_file: opts.filePath,
      json_log_file: opts.jsonFilePath,
      events: [],
    };
  }

  static async create(meta: {
    scenario_id?: string;
    target?: string;
    title?: string;
  }): Promise<ScriptAgentSessionLog> {
    const enabled = Deno.env.get("SCRIPT_AGENT_LOG") !== "false";
    const runId = `${stamp()}_${shortId()}`;
    const dir = resolveLogDir();
    const filePath = `${dir}/${runId}.log`.replace(/\\/g, "/");
    const jsonFilePath = `${dir}/${runId}.json`.replace(/\\/g, "/");
    const latestPath = `${dir}/latest.log`.replace(/\\/g, "/");
    const latestJsonPath = `${dir}/latest.json`.replace(/\\/g, "/");
    const session = new ScriptAgentSessionLog({
      runId,
      filePath,
      jsonFilePath,
      latestPath,
      latestJsonPath,
      writeEnabled: enabled,
      meta,
    });

    if (enabled) {
      try {
        await Deno.mkdir(dir, { recursive: true });
        const header = [
          `# RTB script-agent session ${runId}`,
          `# started_at=${session.startedAt}`,
          `# scenario_id=${meta.scenario_id || ""}`,
          `# target=${meta.target || ""}`,
          `# title=${(meta.title || "").replace(/\r?\n/g, " ")}`,
          `# log_file=${filePath}`,
          `# json_log_file=${jsonFilePath}`,
          "",
        ].join("\n");
        session.textLines.push(header);
        await session.flush();
        console.log(`[script-gen] log file → ${filePath}`);
        console.log(`[script-gen] json log → ${jsonFilePath}`);
      } catch (e) {
        session.writeEnabled = false;
        console.warn(
          `[script-gen] WARN could not create log dir (${dir}): ${String((e as Error)?.message || e)} — terminal-only`,
        );
      }
    } else {
      console.log("[script-gen] file logging disabled (SCRIPT_AGENT_LOG=false)");
    }

    await session.log("script-gen", "start", "Script generation started", {
      scenario_id: meta.scenario_id,
      target: meta.target,
      title: meta.title,
      log_file: enabled ? filePath : null,
      json_log_file: enabled ? jsonFilePath : null,
    });
    return session;
  }

  async log(
    agent: ScriptAgentName,
    phase: string,
    message: string,
    data?: Record<string, unknown>,
    level: ScriptAgentLogLevel = "info",
  ): Promise<void> {
    const event: ScriptAgentLogEvent = {
      ts: new Date().toISOString(),
      agent,
      phase,
      level,
      message,
      ...(data && Object.keys(data).length ? { data } : {}),
    };
    this.doc.events.push(event);

    const line = formatLine(event);
    this.textLines.push(line + "\n");

    if (level === "error") console.error(line);
    else if (level === "warn") console.warn(line);
    else console.log(line);

    await this.flush();
  }

  async finish(
    status: "ok" | "failed" | "skipped",
    summary?: Record<string, unknown>,
  ): Promise<void> {
    this.doc.status = status;
    this.doc.finished_at = new Date().toISOString();
    if (summary) this.doc.summary = summary;
    await this.log(
      "script-gen",
      "finish",
      status === "ok" ? "Script generation finished" : `Script generation ${status}`,
      { status, ...(summary || {}) },
      status === "failed" ? "error" : "info",
    );
    await this.flush();
  }

  /** Primary text log (.log). */
  getLogFile(): string | null {
    return this.writeEnabled ? this.filePath : null;
  }

  getJsonLogFile(): string | null {
    return this.writeEnabled ? this.jsonFilePath : null;
  }

  private async flush(): Promise<void> {
    if (!this.writeEnabled) return;
    const jsonBody = JSON.stringify(this.doc, null, 2);
    const textBody = this.textLines.join("");
    try {
      await Deno.writeTextFile(this.filePath, textBody);
      await Deno.writeTextFile(this.latestPath, textBody);
      await Deno.writeTextFile(this.jsonFilePath, jsonBody);
      await Deno.writeTextFile(this.latestJsonPath, jsonBody);
    } catch (e) {
      console.warn(
        `[script-gen] WARN failed to write log files: ${String((e as Error)?.message || e)}`,
      );
    }
  }
}
