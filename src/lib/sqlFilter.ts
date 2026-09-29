/** SQL filter helpers — qualify columns with the first FROM table alias to avoid ambiguous column errors on joins. */

const SQL_KEYWORDS = new Set([
  "join", "inner", "left", "right", "full", "cross", "natural", "outer",
  "where", "group", "order", "having", "qualify", "limit", "on", "using",
  "union", "intersect", "except", "fetch", "offset", "window", "pivot",
  "unpivot", "sample", "tablesample", "asof", "match_recognize", "start",
  "connect", "lateral", "apply", "values", "set", "into", "select", "with",
  "by", "and", "or", "not", "null", "true", "false", "case", "when", "then",
  "else", "end", "between", "like", "ilike", "in", "is", "as", "over",
  "partition", "rows", "range", "unbounded", "preceding", "following",
  "current", "row", "asc", "desc", "nulls", "first", "last", "distinct",
  "all", "recursive",
]);

function skipWs(sql: string, i: number): number {
  while (i < sql.length && /\s/.test(sql[i])) i++;
  return i;
}

/** Remove -- line comments and slash-star block comments (not inside strings). */
export function stripSqlComments(sql: string): string {
  let out = "";
  let i = 0;
  let inSingle = false;
  let inDouble = false;
  while (i < sql.length) {
    const ch = sql[i];
    const next = sql[i + 1];
    if (inSingle) {
      out += ch;
      if (ch === "'" && next === "'") { out += next; i += 2; continue; }
      if (ch === "'") inSingle = false;
      i++;
      continue;
    }
    if (inDouble) {
      out += ch;
      if (ch === '"' && next === '"') { out += next; i += 2; continue; }
      if (ch === '"') inDouble = false;
      i++;
      continue;
    }
    if (ch === "'") { inSingle = true; out += ch; i++; continue; }
    if (ch === '"') { inDouble = true; out += ch; i++; continue; }
    if (ch === "-" && next === "-") {
      i += 2;
      while (i < sql.length && sql[i] !== "\n") i++;
      continue;
    }
    if (ch === "/" && next === "*") {
      i += 2;
      while (i < sql.length && !(sql[i] === "*" && sql[i + 1] === "/")) i++;
      i += 2;
      out += " ";
      continue;
    }
    out += ch;
    i++;
  }
  return out;
}

function readIdent(sql: string, i: number): { raw: string; unquoted: string; next: number } | null {
  i = skipWs(sql, i);
  if (i >= sql.length) return null;
  if (sql[i] === '"') {
    let j = i + 1;
    let raw = '"';
    let unquoted = "";
    while (j < sql.length) {
      if (sql[j] === '"' && sql[j + 1] === '"') {
        raw += '""';
        unquoted += '"';
        j += 2;
        continue;
      }
      if (sql[j] === '"') {
        raw += '"';
        return { raw, unquoted, next: j + 1 };
      }
      raw += sql[j];
      unquoted += sql[j];
      j++;
    }
    return null;
  }
  if (/[A-Za-z_]/.test(sql[i])) {
    let j = i + 1;
    while (j < sql.length && /[A-Za-z0-9_$]/.test(sql[j])) j++;
    const unquoted = sql.slice(i, j);
    return { raw: unquoted, unquoted, next: j };
  }
  return null;
}

function findTopLevelKeyword(sql: string, keyword: string, fromIndex = 0): number {
  const lower = sql.toLowerCase();
  const kw = keyword.toLowerCase();
  let depth = 0;
  let inSingle = false;
  let inDouble = false;
  for (let i = fromIndex; i < sql.length; i++) {
    const ch = sql[i];
    if (inSingle) {
      if (ch === "'" && sql[i + 1] === "'") { i++; continue; }
      if (ch === "'") inSingle = false;
      continue;
    }
    if (inDouble) {
      if (ch === '"' && sql[i + 1] === '"') { i++; continue; }
      if (ch === '"') inDouble = false;
      continue;
    }
    if (ch === "'") { inSingle = true; continue; }
    if (ch === '"') { inDouble = true; continue; }
    if (ch === "(") { depth++; continue; }
    if (ch === ")") { depth = Math.max(0, depth - 1); continue; }
    if (depth !== 0) continue;
    const prev = i === 0 ? " " : sql[i - 1];
    if (!/\W/.test(prev)) continue;
    if (!lower.startsWith(kw, i)) continue;
    const after = sql[i + kw.length];
    if (after !== undefined && !/\W/.test(after)) continue;
    return i;
  }
  return -1;
}

function skipSubquery(sql: string, i: number): number {
  i = skipWs(sql, i);
  if (sql[i] !== "(") return i;
  let depth = 0;
  let inSingle = false;
  let inDouble = false;
  for (; i < sql.length; i++) {
    const ch = sql[i];
    if (inSingle) {
      if (ch === "'" && sql[i + 1] === "'") { i++; continue; }
      if (ch === "'") inSingle = false;
      continue;
    }
    if (inDouble) {
      if (ch === '"' && sql[i + 1] === '"') { i++; continue; }
      if (ch === '"') inDouble = false;
      continue;
    }
    if (ch === "'") { inSingle = true; continue; }
    if (ch === '"') { inDouble = true; continue; }
    if (ch === "(") depth++;
    else if (ch === ")") {
      depth--;
      if (depth === 0) return i + 1;
    }
  }
  return sql.length;
}

function parseRelationAlias(sql: string, start: number): { alias: string | null; next: number } {
  let i = skipWs(sql, start);
  let tableName: string | null = null;

  if (sql[i] === "(") {
    i = skipSubquery(sql, i);
  } else {
    const first = readIdent(sql, i);
    if (!first) return { alias: null, next: i };
    i = first.next;
    tableName = first.unquoted;
    while (true) {
      const j = skipWs(sql, i);
      if (sql[j] !== ".") break;
      const next = readIdent(sql, j + 1);
      if (!next) break;
      i = next.next;
      tableName = next.unquoted;
    }
  }

  i = skipWs(sql, i);
  const asTok = readIdent(sql, i);
  if (asTok && asTok.unquoted.toLowerCase() === "as") {
    const alias = readIdent(sql, asTok.next);
    if (alias) return { alias: alias.unquoted, next: alias.next };
    return { alias: tableName, next: asTok.next };
  }
  if (asTok && !SQL_KEYWORDS.has(asTok.unquoted.toLowerCase())) {
    return { alias: asTok.unquoted, next: asTok.next };
  }
  return { alias: tableName, next: i };
}

/**
 * Return the alias (or bare table name) of the first relation in the top-level FROM clause.
 */
export function extractFirstTableAlias(sql: string): string | null {
  const cleaned = stripSqlComments(sql);
  let fromPos = -1;
  const withPos = findTopLevelKeyword(cleaned, "with");
  const startsWithWith = withPos >= 0 && skipWs(cleaned, 0) === withPos;
  if (startsWithWith) {
    let sel = -1;
    let idx = 0;
    while (true) {
      const p = findTopLevelKeyword(cleaned, "select", idx);
      if (p < 0) break;
      sel = p;
      idx = p + 6;
    }
    if (sel >= 0) fromPos = findTopLevelKeyword(cleaned, "from", sel + 6);
  } else {
    fromPos = findTopLevelKeyword(cleaned, "from");
  }
  if (fromPos < 0) fromPos = findTopLevelKeyword(cleaned, "from");
  if (fromPos < 0) return null;

  const { alias } = parseRelationAlias(cleaned, fromPos + 4);
  return alias;
}

/** True when the top-level FROM clearly references more than one relation. */
export function hasMultipleTables(sql: string): boolean {
  const cleaned = stripSqlComments(sql);
  const fromPos = findTopLevelKeyword(cleaned, "from");
  if (fromPos < 0) return false;
  const slice = cleaned.slice(fromPos);
  let end = slice.length;
  for (const kw of ["where", "group", "order", "having", "qualify", "limit", "union", "intersect", "except"]) {
    const p = findTopLevelKeyword(slice, kw, 4);
    if (p >= 0 && p < end) end = p;
  }
  const fromClause = slice.slice(0, end);
  const lower = fromClause.toLowerCase();
  if (/\bjoin\b/.test(lower)) return true;

  let depth = 0;
  let inSingle = false;
  let inDouble = false;
  for (let i = 4; i < fromClause.length; i++) {
    const ch = fromClause[i];
    if (inSingle) {
      if (ch === "'" && fromClause[i + 1] === "'") { i++; continue; }
      if (ch === "'") inSingle = false;
      continue;
    }
    if (inDouble) {
      if (ch === '"' && fromClause[i + 1] === '"') { i++; continue; }
      if (ch === '"') inDouble = false;
      continue;
    }
    if (ch === "'") { inSingle = true; continue; }
    if (ch === '"') { inDouble = true; continue; }
    if (ch === "(") depth++;
    else if (ch === ")") depth = Math.max(0, depth - 1);
    else if (depth === 0 && ch === ",") return true;
  }
  return false;
}

export function isAlreadyQualified(be: string): boolean {
  const s = be.trim();
  if (!s.includes(".")) return false;
  return /^(?:"[^"]+"|[A-Za-z_][\w$]*)\s*\.\s*(?:"[^"]+"|[A-Za-z_][\w$]*)$/.test(s);
}

export function qualifyColumn(be: string, alias: string | null): string {
  const col = (be || "").trim();
  if (!col) return col;
  if (isAlreadyQualified(col)) return col;
  const c = col.replace(/^"|"$/g, "").replace(/""/g, '"');
  const q = (id: string) => `"${id.replace(/"/g, '""')}"`;
  if (!alias) return q(c);
  const a = alias.replace(/^"|"$/g, "").replace(/""/g, '"');
  return `${q(a)}.${q(c)}`;
}

function escRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function endsWithAsKeyword(prefix: string): boolean {
  return /(^|[\s(,])as\s*$/i.test(prefix);
}

/**
 * Qualify every top-level bare reference to `column` with `alias`.
 * Skips string literals and already-qualified refs (preceded by `.`).
 * Skips identifiers right after AS (select-list aliases).
 */
export function qualifyBareColumnRefs(sql: string, column: string, alias: string): string {
  const col = column.replace(/^"|"$/g, "").replace(/""/g, '"');
  if (!col || !alias) return sql;
  const replacement = qualifyColumn(col, alias);

  let out = "";
  let i = 0;
  let depth = 0;
  let inSingle = false;

  while (i < sql.length) {
    const ch = sql[i];
    const next = sql[i + 1];

    if (inSingle) {
      out += ch;
      if (ch === "'" && next === "'") { out += next; i += 2; continue; }
      if (ch === "'") inSingle = false;
      i++;
      continue;
    }

    if (ch === "'") { inSingle = true; out += ch; i++; continue; }
    if (ch === "(") { depth++; out += ch; i++; continue; }
    if (ch === ")") { depth = Math.max(0, depth - 1); out += ch; i++; continue; }

    // Double-quoted identifier
    if (ch === '"' && depth === 0) {
      let j = i + 1;
      let unquoted = "";
      while (j < sql.length) {
        if (sql[j] === '"' && sql[j + 1] === '"') { unquoted += '"'; j += 2; continue; }
        if (sql[j] === '"') break;
        unquoted += sql[j];
        j++;
      }
      if (j < sql.length && unquoted.toLowerCase() === col.toLowerCase()) {
        const prev = out.length ? out[out.length - 1] : " ";
        if (prev !== "." && !endsWithAsKeyword(out)) {
          out += replacement;
          i = j + 1;
          continue;
        }
      }
      // copy the quoted ident as-is
      out += sql.slice(i, j + 1);
      i = j + 1;
      continue;
    }
    if (ch === '"') {
      // inside parens — copy through quoted ident
      out += ch;
      i++;
      while (i < sql.length) {
        out += sql[i];
        if (sql[i] === '"' && sql[i + 1] === '"') { out += sql[i + 1]; i += 2; continue; }
        if (sql[i] === '"') { i++; break; }
        i++;
      }
      continue;
    }

    if (depth === 0 && /[A-Za-z_]/.test(ch)) {
      let j = i + 1;
      while (j < sql.length && /[A-Za-z0-9_$]/.test(sql[j])) j++;
      const word = sql.slice(i, j);
      if (word.toLowerCase() === col.toLowerCase()) {
        const prev = out.length ? out[out.length - 1] : " ";
        if (prev !== "." && !/[A-Za-z0-9_$]/.test(prev) && !endsWithAsKeyword(out)) {
          out += replacement;
          i = j;
          continue;
        }
      }
      out += word;
      i = j;
      continue;
    }

    out += ch;
    i++;
  }

  return out;
}

/**
 * Apply filter value: update existing equality predicates for the column (qualifying them),
 * and return a qualified predicate to append if none existed.
 */
export function applyFilterPredicate(
  sql: string,
  be: string,
  value: string,
  alias: string | null,
): { sql: string; append: string | null } {
  const escSql = (s: string) => String(s).replace(/'/g, "''");
  const bareCol = String(be).includes(".")
    ? String(be).replace(/^.*\./, "").replace(/^"|"$/g, "")
    : String(be).replace(/^"|"$/g, "");
  const qualified = qualifyColumn(be, alias);

  // Only match UNQUALIFIED col = '…' (not preceded by .)
  const re = new RegExp(
    `(?<![.\\w])(?:"${escRe(bareCol)}"|\\b${escRe(bareCol)}\\b)(\\s*(?:=|<>|!=)\\s*)'([^']*)'`,
    "gi",
  );
  let replaced = false;
  let nextSql = sql.replace(re, (_m, op) => {
    replaced = true;
    return `${qualified}${op}'${escSql(value)}'`;
  });

  // When joins exist, also qualify other bare refs to this column (SELECT/GROUP BY/etc.)
  if (alias && (hasMultipleTables(nextSql) || hasMultipleTables(sql))) {
    nextSql = qualifyBareColumnRefs(nextSql, bareCol, alias);
  }

  return {
    sql: nextSql,
    append: replaced ? null : `${qualified} = '${escSql(value)}'`,
  };
}
