type MapValue = Record<string, any>;
const normal = (value: unknown) => String(value ?? "").trim().replace(/\s+/g, " ").toLowerCase();
/** Filter evidence may be `{ ok, via, selected }`; use its observed text, never the object itself. */
function filterText(value: unknown): string | null {
  if (value == null || typeof value !== "object") return normal(value);
  const v = value as MapValue;
  for (const key of ["observed", "verified", "actual", "selected", "value"]) {
    if (typeof v[key] === "string" && v[key].trim()) return normal(v[key]);
  }
  return null;
}
export function filterSignature(filters: unknown): string | null {
  if (!filters || typeof filters !== "object" || Array.isArray(filters)) return null;
  const entries: Array<[string, string]> = [];
  for (const [key, value] of Object.entries(filters)) {
    const text = filterText(value);
    // Evidence without observed text is unknown, not a contradiction.
    if (text === null) return null;
    entries.push([normal(key), text]);
  }
  return JSON.stringify(entries.sort(([a], [b]) => a.localeCompare(b)));
}
export function combinationId(row: MapValue): string | null {
  const id = row?.combo_id ?? row?.combination_id ?? row?.actual?.combo_id ?? row?.expected?.combo_id;
  return id == null ? null : String(id);
}
export function rowFilters(row: MapValue): unknown {
  return row?.actual?.requested_filters ?? row?.actual?.filters_applied ?? row?.expected?.requested_filters ?? row?.filters;
}
/** Labels are permitted only for unique legacy rows without contradictory filter evidence. */
export function matchCombination(combos: MapValue[], combo: MapValue, rows: MapValue[]): MapValue | null {
  const signature = filterSignature(combo.filters);
  const compatible = (row: MapValue) => {
    const executed = filterSignature(rowFilters(row));
    return signature === null || executed === null || signature === executed;
  };
  const ordered = [...rows].sort((a, b) => String(b.created_at ?? "").localeCompare(String(a.created_at ?? "")) || String(a.id ?? "").localeCompare(String(b.id ?? "")));
  const idRows = ordered.filter(row => combinationId(row) === String(combo.id) && combo.id != null);
  // A newer incompatible execution cannot be replaced with older evidence.
  if (idRows.length) return compatible(idRows[0]) ? idRows[0] : null;
  const legacy = ordered.filter(row => combinationId(row) === null);
  const labelsFor = (c: MapValue) => [normal(c.label), normal(Object.values(c.filters || {}).join(" / "))].filter(Boolean);
  const labelOf = (row: MapValue) => normal(row.actual?.filter ?? row.expected?.filter ?? row.actual?.combo);
  const isUnidentified = (row: MapValue) => {
    if (combinationId(row) !== null || filterSignature(rowFilters(row)) !== null) return false;
    const label = labelOf(row);
    return !label || combos.filter(c => labelsFor(c).includes(label)).length !== 1;
  };
  const accept = (row: MapValue | undefined) => row && !ordered.some(other => isUnidentified(other) && String(other.created_at || "") > String(row.created_at || "")) ? row : null;
  if (signature !== null && signature !== "[]") {
    if (combos.filter(c => filterSignature(c.filters) === signature).length !== 1) return null;
    const matches = legacy.filter(row => filterSignature(rowFilters(row)) === signature);
    if (matches.length) {
      // A newer compatible legacy execution with the same unique full label
      // must supersede an older snapshot, even when its extraction failed.
      const labels = labelsFor(combo).filter(label => combos.filter(c => labelsFor(c).includes(label)).length === 1);
      const latest = legacy.find(row => matches.includes(row) || labels.includes(labelOf(row)));
      return latest && compatible(latest) ? accept(latest) : null;
    }
  }
  const label = normal(combo.label);
  if (!label || combos.filter(c => normal(c.label) === label).length !== 1) return null;
  const matches = legacy.filter(row => normal(row.actual?.filter ?? row.expected?.filter ?? row.actual?.combo) === label);
  return matches.length && compatible(matches[0]) ? accept(matches[0]) : null;
}