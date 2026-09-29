import { corsHeaders } from "../_shared/cors.ts";
import { getSupabaseForRequest, requireAuth } from "../_shared/auth.ts";
import {
  callSnowflakeSso,
  interpretSnowflakeError,
  resolveAuthMode,
  snowflakeSidecarConnector,
} from "../_shared/snowflake-auth.ts";
import { extractFirstTableAlias, qualifyColumn, applyFilterPredicate } from "../_shared/sql-filter.ts";

function normalizeHost(v?: string | null): string {
  return (v || "")
    .trim()
    .replace(/^https?:\/\//i, "")
    .replace(/\/+$/, "")
    .replace(/\.snowflakecomputing\.com$/i, "");
}

async function executeViaSidecar(
  connector: Record<string, unknown>,
  sql: string,
  limit: number,
): Promise<Record<string, unknown>> {
  return callSnowflakeSso("/v1/query", {
    connector_id: String(connector.id || "inline"),
    connector: snowflakeSidecarConnector(connector),
    sql,
    limit,
  });
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });
  const unauthorized = await requireAuth(req);
  if (unauthorized) return unauthorized;
  try {
    const { sql, sql_template_id, scenario_id, filters, where_clause, filter_pairs, limit } = await req.json();
    const topN = Math.max(1, Math.min(Number(limit) || 5, 100));
    const sb = getSupabaseForRequest(req);

    let sqlText: string = sql || "";
    let templateName: string | null = null;
    if (!sqlText && sql_template_id) {
      const { data } = await sb.from("sql_templates").select("name,sql_text").eq("id", sql_template_id).maybeSingle();
      sqlText = data?.sql_text || "";
      templateName = data?.name || null;
    }
    if (!sqlText) throw new Error("No SQL provided");

    // Parameter substitution: replace :name with filters[name]
    let resolvedSql = sqlText;
    if (filters && typeof filters === "object") {
      for (const [k, v] of Object.entries(filters)) {
        resolvedSql = resolvedSql.replaceAll(`:${k}`, JSON.stringify(v));
      }
    }

    // Prefer first FROM table alias so join-shared columns are not ambiguous.
    const firstAlias = extractFirstTableAlias(resolvedSql);

    const pairs: { be: string; value: string }[] = Array.isArray(filter_pairs) ? filter_pairs : [];
    const toAppend: string[] = [];
    for (const p of pairs) {
      if (!p?.be) continue;
      const applied = applyFilterPredicate(resolvedSql, p.be, String(p.value ?? ""), firstAlias);
      resolvedSql = applied.sql;
      if (applied.append) toAppend.push(applied.append);
    }

    const legacyWc = (!pairs.length && where_clause && typeof where_clause === "string" && where_clause.trim())
      ? where_clause.trim()
      : "";
    if (toAppend.length || legacyWc) {
      let extra = [toAppend.join(" AND "), legacyWc].filter(Boolean).join(" AND ");
      // Qualify bare "COL" = '…' predicates in legacy where_clause too.
      if (firstAlias && legacyWc) {
        extra = extra.replace(
          /(?<![.\w"])("?)([A-Za-z_][\w$]*)\1(\s*(?:=|<>|!=)\s*'[^']*')/g,
          (_m, _q, col, rest) => `${qualifyColumn(col, firstAlias)}${rest}`,
        );
      }
      let body = resolvedSql.trim().replace(/;\s*$/, "");
      // Find the first top-level (paren depth 0) tail keyword so we don't
      // inject filters into a subquery's WHERE clause.
      const tailKeywords = ["group by", "order by", "having", "qualify", "limit"];
      const lower = body.toLowerCase();
      let depth = 0;
      let splitIdx = -1;
      for (let i = 0; i < body.length; i++) {
        const ch = body[i];
        if (ch === "(") depth++;
        else if (ch === ")") depth = Math.max(0, depth - 1);
        else if (depth === 0) {
          // Only test at word boundaries
          const prev = i === 0 ? " " : body[i - 1];
          if (/\W/.test(prev)) {
            for (const kw of tailKeywords) {
              if (lower.startsWith(kw, i)) {
                const after = body[i + kw.length];
                if (after === undefined || /\W/.test(after)) {
                  splitIdx = i;
                  break;
                }
              }
            }
            if (splitIdx >= 0) break;
          }
        }
      }
      const head = splitIdx >= 0 ? body.slice(0, splitIdx) : body;
      const tail = splitIdx >= 0 ? body.slice(splitIdx) : "";
      // Detect a top-level WHERE in head (ignore WHEREs inside parens)
      let hasWhere = false;
      {
        let d = 0;
        const lh = head.toLowerCase();
        for (let i = 0; i < head.length; i++) {
          const ch = head[i];
          if (ch === "(") d++;
          else if (ch === ")") d = Math.max(0, d - 1);
          else if (d === 0 && lh.startsWith("where", i)) {
            const prev = i === 0 ? " " : head[i - 1];
            const after = head[i + 5];
            if (/\W/.test(prev) && (after === undefined || /\W/.test(after))) {
              hasWhere = true;
              break;
            }
          }
        }
      }
      const newHead = hasWhere
        ? head.replace(/\s*$/, "") + ` AND (${extra}) `
        : head.replace(/\s*$/, "") + ` WHERE ${extra} `;
      resolvedSql = newHead + tail;
    }

    let connector: Record<string, unknown> | null = null;
    if (scenario_id) {
      const { data: sc } = await sb
        .from("scenarios")
        .select("reports(warehouse_connector_id)")
        .eq("id", scenario_id)
        .maybeSingle();
      const connId = (sc as { reports?: { warehouse_connector_id?: string } })?.reports?.warehouse_connector_id;
      if (connId) {
        const { data: c } = await sb.from("warehouse_connectors").select("*").eq("id", connId).maybeSingle();
        connector = c as Record<string, unknown> | null;
      }
    }

    if (!connector) {
      const { data: list } = await sb
        .from("warehouse_connectors")
        .select("*")
        .order("created_at", { ascending: false })
        .limit(1);
      if (list && list.length) connector = list[0] as Record<string, unknown>;
    }

    if (!connector) {
      return new Response(
        JSON.stringify({
          ok: false,
          resolved_sql: resolvedSql,
          error: "No warehouse connector configured. Add a Snowflake connector in Settings → Warehouses.",
        }),
        { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    const authMode = resolveAuthMode(connector as any);

    try {
      if (authMode === "sso" || authMode === "keypair") {
        const data = await executeViaSidecar(connector, resolvedSql, topN);
        return new Response(
          JSON.stringify({
            ok: true,
            source: "snowflake",
            auth_mode: authMode,
            connector: connector.name,
            template_name: templateName,
            resolved_sql: resolvedSql,
            filter_table_alias: firstAlias,
            columns: data.columns || [],
            row_count: data.row_count ?? (data.rows as unknown[])?.length ?? 0,
            rows: data.rows || [],
            scalar: data.scalar ?? null,
          }),
          { headers: { ...corsHeaders, "Content-Type": "application/json" } },
        );
      }

      const account = normalizeHost(connector.account as string) || normalizeHost(connector.host as string);
      if (!account) throw new Error("Snowflake connector is missing 'account'");

      const tokenName = connector.token_secret_ref as string | undefined;
      const token = tokenName ? Deno.env.get(tokenName) : undefined;

      let authHeader: string;
      let tokenType: string;

      if (token) {
        authHeader = `Bearer ${token}`;
        tokenType = "OAUTH";
      } else {
        const username = connector.username as string | undefined;
        const passRef = connector.password_secret_ref as string | undefined;
        const password = passRef ? (Deno.env.get(passRef) ?? passRef) : undefined;
        if (!username) throw new Error("Connector has no token and no 'username' for password login");
        if (!password) throw new Error("Missing Snowflake password. Set the password in Settings → Warehouses.");

        const loginUrl = `https://${account}.snowflakecomputing.com/session/v1/login-request?` +
          new URLSearchParams({
            ...(connector.warehouse ? { warehouse: String(connector.warehouse) } : {}),
            ...(connector.database ? { databaseName: String(connector.database) } : {}),
            ...(connector.schema ? { schemaName: String(connector.schema) } : {}),
            ...(connector.role ? { roleName: String(connector.role) } : {}),
          }).toString();
        const loginRes = await fetch(loginUrl, {
          method: "POST",
          headers: { "Content-Type": "application/json", Accept: "application/json" },
          body: JSON.stringify({
            data: {
              LOGIN_NAME: username,
              PASSWORD: password,
              ACCOUNT_NAME: account,
              CLIENT_APP_ID: "ReportTestBuddySqlRunner",
              CLIENT_APP_VERSION: "1.0",
            },
          }),
        });
        const loginText = await loginRes.text();
        let loginJson: Record<string, unknown> = {};
        try {
          loginJson = loginText ? JSON.parse(loginText) : {};
        } catch { /* */ }
        const loginData = loginJson.data as Record<string, unknown> | undefined;
        if (!loginRes.ok || loginJson?.success === false || !loginData?.token) {
          const msg = String(
            loginJson?.message || loginData?.errorCode || loginText || `Login HTTP ${loginRes.status}`,
          );
          throw new Error(`Snowflake login failed: ${msg}`);
        }
        authHeader = `Snowflake Token="${loginData.token}"`;
        tokenType = "SESSION";
      }

      let cols: string[] = [];
      let dataRows: unknown[][] = [];

      if (tokenType === "OAUTH") {
        const url = `https://${account}.snowflakecomputing.com/api/v2/statements`;
        const body: Record<string, unknown> = {
          statement: resolvedSql,
          timeout: 60,
          ...(connector.database ? { database: connector.database } : {}),
          ...(connector.schema ? { schema: connector.schema } : {}),
          ...(connector.warehouse ? { warehouse: connector.warehouse } : {}),
          ...(connector.role ? { role: connector.role } : {}),
        };
        const sfRes = await fetch(url, {
          method: "POST",
          headers: {
            Authorization: authHeader,
            "X-Snowflake-Authorization-Token-Type": "OAUTH",
            "Content-Type": "application/json",
            Accept: "application/json",
          },
          body: JSON.stringify(body),
        });
        const sfText = await sfRes.text();
        let sfJson: Record<string, unknown> = {};
        try {
          sfJson = sfText ? JSON.parse(sfText) : {};
        } catch { /* */ }
        if (!sfRes.ok) {
          const msg = String(sfJson?.message || sfJson?.code || sfText || `Snowflake HTTP ${sfRes.status}`);
          throw new Error(msg);
        }
        const meta = sfJson.resultSetMetaData as { rowType?: { name: string }[] } | undefined;
        cols = (meta?.rowType || []).map((c) => c.name);
        dataRows = (sfJson.data as unknown[][]) || [];
      } else {
        const reqId = crypto.randomUUID();
        const qUrl = `https://${account}.snowflakecomputing.com/queries/v1/query-request?requestId=${reqId}`;
        const qRes = await fetch(qUrl, {
          method: "POST",
          headers: {
            Authorization: authHeader,
            "Content-Type": "application/json",
            Accept: "application/snowflake",
            "User-Agent": "ReportTestBuddySqlRunner/1.0",
          },
          body: JSON.stringify({
            sqlText: resolvedSql,
            asyncExec: false,
            sequenceId: 1,
            querySubmissionTime: Date.now(),
          }),
        });
        const qText = await qRes.text();
        let qJson: Record<string, unknown> = {};
        try {
          qJson = qText ? JSON.parse(qText) : {};
        } catch { /* */ }
        if (!qRes.ok || qJson?.success === false) {
          const qData = qJson.data as Record<string, unknown> | undefined;
          const msg = String(qJson?.message || qData?.errorCode || qText || `Snowflake HTTP ${qRes.status}`);
          throw new Error(msg);
        }
        let payload = qJson;
        let pingPath = (payload?.data as Record<string, unknown> | undefined)?.getResultUrl as string | undefined;
        for (let i = 0; i < 30 && pingPath; i++) {
          await new Promise((r) => setTimeout(r, 1000));
          const pRes = await fetch(`https://${account}.snowflakecomputing.com${pingPath}`, {
            headers: { Authorization: authHeader, Accept: "application/snowflake" },
          });
          payload = await pRes.json();
          if (payload?.code !== "333334" && payload?.code !== "333333") break;
          pingPath = (payload?.data as Record<string, unknown> | undefined)?.getResultUrl as string | undefined;
        }
        const rowtype = (payload?.data as Record<string, unknown> | undefined)?.rowtype as { name: string }[] | undefined;
        cols = (rowtype || []).map((c) => c.name);
        dataRows = ((payload?.data as Record<string, unknown> | undefined)?.rowset as unknown[][]) || [];
      }

      const rows = dataRows.slice(0, topN).map((arr) => {
        const o: Record<string, unknown> = {};
        cols.forEach((name, i) => {
          o[name] = arr[i];
        });
        return o;
      });
      let scalar: unknown = null;
      if (rows.length === 1 && cols.length === 1) scalar = rows[0][cols[0]];

      return new Response(
        JSON.stringify({
          ok: true,
          source: "snowflake",
          auth_mode: authMode,
          connector: connector.name,
          template_name: templateName,
          resolved_sql: resolvedSql,
          filter_table_alias: firstAlias,
          columns: cols,
          row_count: dataRows.length,
          rows,
          scalar,
        }),
        { headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    } catch (sfErr: unknown) {
      const raw = String((sfErr as Error)?.message || sfErr);
      return new Response(
        JSON.stringify({
          ok: false,
          source: "snowflake",
          auth_mode: authMode,
          connector: connector?.name,
          resolved_sql: resolvedSql,
          filter_table_alias: firstAlias,
          error: interpretSnowflakeError(raw, authMode),
        }),
        { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }
  } catch (e) {
    return new Response(JSON.stringify({ ok: false, error: String((e as Error)?.message || e) }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
