const normalize = (value: unknown) => String(value ?? "").replace(/\s+/g, " ").trim().toLowerCase();
export function filterValuesEqual(actual: unknown, requested: unknown): boolean {
  const a = normalize(actual), b = normalize(requested);
  if (!a || !b) return false;
  if (a === b) return true;
  const coded = /^([a-z]*\d+[a-z0-9]*)\s*[-–—:]\s*\S.+$/i;
  const left = a.match(coded), right = b.match(coded);
  return !!left && !!right && left[1] === right[1];
}
export function verifyFilterEvidence(requested: Record<string, any>, observed: any) {
  const evidence = Object.entries(requested || {}).filter(([key]) => !key.startsWith("__")).map(([key, value]) => {
    const entry = observed?.[key];
    // Legacy scripts record the displayed filter text as `selected`; never
    // substitute the requested `option` or a boolean selection flag.
    const actual = entry && typeof entry === "object" ? entry.observed ?? entry.verified ?? entry.actual ?? (typeof entry.selected === "string" ? entry.selected : undefined) : entry;
    const selection = entry && typeof entry === "object" && entry.ok === false ? "failed" : actual == null ? "unobserved" : "observed";
    const verified = selection !== "failed" && filterValuesEqual(actual, value);
    return { key, requested: value, observed: actual ?? null, selection_outcome: selection, verification_outcome: verified ? "verified" : "failed", error: verified ? null : String(entry?.error || "FILTER_NOT_VERIFIED") };
  });
  return { ok: evidence.every(item => item.verification_outcome === "verified"), evidence };
}