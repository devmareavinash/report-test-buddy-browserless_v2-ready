/** Reconstruct Weekly / Monthly / Quarterly trend panels from stored or live scrape maps. */

export type TrendGrain = {
  name: string;
  periods: string[];
  missing: string[];
  consecutive: boolean | null;
  trend_error: string | null;
  score: number | null;
};

export type TrendView = {
  grains: TrendGrain[];
  consecutive: boolean | null;
  score: number | null;
  trend_error: string | null;
};

const GRAIN_NAMES = ["Weekly", "Monthly", "Quarterly"] as const;

function periodsFromTableData(td: any): string[] {
  if (!td || typeof td !== "object") return [];
  const headers = Array.isArray(td.headers) ? td.headers : [];
  const rows = td.rows || td.data;
  if (!Array.isArray(rows) || !rows.length) return [];
  let col = headers.findIndex((h: any) => /date|month|week|quarter|period|time|bucket/i.test(String(h || "")));
  if (col < 0) col = 0;
  const key = headers[col] || (rows[0] && typeof rows[0] === "object" && !Array.isArray(rows[0])
    ? Object.keys(rows[0])[0]
    : null);
  const out: string[] = [];
  for (const row of rows) {
    let cell: any;
    if (Array.isArray(row)) cell = row[col];
    else if (row && typeof row === "object") cell = key ? row[key] : Object.values(row)[0];
    else cell = row;
    const t = String(cell ?? "").replace(/\s+/g, " ").trim();
    if (t && !/^(total|grand total|sum)$/i.test(t)) out.push(t);
  }
  return out;
}

function grainFromMap(map: any, name: string): TrendGrain | null {
  if (!map || typeof map !== "object") return null;
  const td = map.tableData || map.tabledata;
  const periods = Array.isArray(map.periods) && map.periods.length
    ? map.periods.map((p: any) => String(p))
    : periodsFromTableData(td);
  const missing = Array.isArray(map.missing) ? map.missing.map((p: any) => String(p)) : [];
  const consecutive = typeof map.consecutive === "boolean" ? map.consecutive : null;
  const scoreKey = `Trend check ${name}`;
  const rawScore = map[scoreKey] ?? (name === "Weekly" || !map["Trend check Weekly"] ? map["Trend check"] : undefined);
  const score = rawScore == null ? null : Number(rawScore);
  const trend_error = map.trend_error ? String(map.trend_error) : null;
  if (!periods.length && consecutive == null && score == null && !trend_error && !missing.length) return null;
  return { name, periods, missing, consecutive, trend_error, score };
}

function collectMaps(src: any, depth = 0, out: any[] = [], seen = new Set<any>()): any[] {
  if (!src || typeof src !== "object" || depth > 7 || seen.has(src)) return out;
  seen.add(src);
  out.push(src);
  for (const nest of [src.values, src.extracted, src.result, src.results, src.diff]) {
    collectMaps(nest, depth + 1, out, seen);
  }
  if (src["Trend check"] && typeof src["Trend check"] === "object") {
    collectMaps(src["Trend check"], depth + 1, out, seen);
  }
  for (const [k, v] of Object.entries(src)) {
    if (!v || typeof v !== "object" || Array.isArray(v)) continue;
    if (k === "grains" || v.grains || Array.isArray(v.periods) || v.consecutive != null || /^combo[_ ]?\d+$/i.test(k)) {
      collectMaps(v, depth + 1, out, seen);
    }
  }
  return out;
}

function grainsFromObject(grainMap: any, parent?: any): TrendGrain[] {
  if (!grainMap || typeof grainMap !== "object" || Array.isArray(grainMap)) return [];
  return GRAIN_NAMES.map((name) => {
    const one = grainMap[name];
    if (!one || typeof one !== "object") {
      const score = parent?.[`Trend check ${name}`];
      if (score == null) return null;
      return {
        name,
        periods: [],
        missing: [],
        consecutive: Number(score) === 1 ? true : Number(score) === 0 ? false : null,
        trend_error: null,
        score: Number(score),
      } as TrendGrain;
    }
    return grainFromMap({ ...one, [`Trend check ${name}`]: one.consecutive === true ? 1 : one.consecutive === false ? 0 : parent?.[`Trend check ${name}`] }, name);
  }).filter(Boolean) as TrendGrain[];
}

function synthesizeFromScores(map: any): TrendGrain[] {
  if (!map || typeof map !== "object") return [];
  return GRAIN_NAMES.map((name) => {
    const score = map[`Trend check ${name}`];
    if (score == null && !(name === "Weekly" && map["Trend check"] != null && map["Trend check Weekly"] == null && map["Trend check Monthly"] == null)) {
      return null;
    }
    const n = score == null ? Number(map["Trend check"]) : Number(score);
    const fromRoot = name === "Weekly" || GRAIN_NAMES.every((g) => map[`Trend check ${g}`] == null)
      ? grainFromMap(map, name)
      : null;
    if (fromRoot && fromRoot.periods.length) return { ...fromRoot, name };
    return {
      name,
      periods: Array.isArray(map.periods) && GRAIN_NAMES.filter((g) => map[`Trend check ${g}`] != null).length <= 1
        ? map.periods.map((p: any) => String(p))
        : [],
      missing: [],
      consecutive: n === 1 ? true : n === 0 ? false : null,
      trend_error: null,
      score: Number.isFinite(n) ? n : null,
    } as TrendGrain;
  }).filter(Boolean) as TrendGrain[];
}

/** Walk stored test_results.actual / live scrape / orchestrate diff for grain panels. */
export function pickTrendView(...sources: any[]): TrendView | null {
  let best: TrendView | null = null;
  const rank = (v: TrendView | null) => {
    if (!v) return -1;
    const withPeriods = v.grains.filter((g) => g.periods.length).length;
    return withPeriods * 10 + v.grains.length;
  };
  for (const src of sources) {
    for (const map of collectMaps(src)) {
      const fromObj = grainsFromObject(map.grains, map);
      const fromScores = fromObj.length ? [] : synthesizeFromScores(map);
      const grains = fromObj.length ? fromObj : fromScores;
      if (!grains.length) {
        const single = grainFromMap(map, map.time_grain || "Period");
        if (single) {
          const cand: TrendView = {
            grains: [{ ...single, name: single.name || "Period" }],
            consecutive: single.consecutive,
            score: single.score,
            trend_error: single.trend_error,
          };
          if (rank(cand) > rank(best)) best = cand;
        }
        continue;
      }
      const consecutive = grains.every((g) => g.consecutive === true)
        ? true
        : grains.some((g) => g.consecutive === false)
        ? false
        : typeof map.consecutive === "boolean"
        ? map.consecutive
        : null;
      const cand: TrendView = {
        grains,
        consecutive,
        score: consecutive === true ? 1 : consecutive === false ? 0 : map["Trend check"] != null ? Number(map["Trend check"]) : null,
        trend_error: map.trend_error ? String(map.trend_error) : null,
      };
      if (rank(cand) > rank(best)) best = cand;
    }
  }
  return best;
}

const TREND_KEEP = ["grains", "periods", "missing", "unparsed_periods", "consecutive", "trend_error", "time_grain"] as const;

/** Copy trend fields that extractKpisFromBlock treats as noise so test_results keep them. */
export function attachTrendFields(values: Record<string, any>, ...sources: any[]): Record<string, any> {
  const out = { ...values };
  for (const map of sources.flatMap((s) => collectMaps(s))) {
    for (const k of TREND_KEEP) {
      if (out[k] == null && map[k] != null) out[k] = map[k];
    }
    for (const [k, v] of Object.entries(map)) {
      if (/^Trend check/i.test(k) && out[k] == null) out[k] = v;
    }
  }
  return out;
}

export function trendStatusFromValues(actual: Record<string, any> | null | undefined): "pass" | "fail" | "pending" | null {
  const view = pickTrendView(actual);
  if (!view) return null;
  if (view.consecutive === true || view.score === 1) return "pass";
  if (view.consecutive === false || view.score === 0 || view.grains.some((g) => g.consecutive === false || g.score === 0)) {
    return "fail";
  }
  if (view.grains.some((g) => g.periods.length || g.score != null || g.consecutive != null)) return "pending";
  return null;
}
