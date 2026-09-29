import { useState } from "react";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";

const KEY = "rtb.orchestrateConcurrency";
const OPTIONS = [1, 2, 3, 5, 8];

export function readOrchestrateConcurrency(): number {
  if (typeof localStorage === "undefined") return 3;
  const n = Number(localStorage.getItem(KEY) || 3);
  return Number.isFinite(n) && n >= 1 ? Math.min(10, Math.floor(n)) : 3;
}

export function useOrchestrateConcurrency() {
  const [concurrency, setConcurrency] = useState(readOrchestrateConcurrency);
  return {
    concurrency,
    setConcurrency: (n: number) => {
      const next = Number.isFinite(n) && n >= 1 ? Math.min(10, Math.floor(n)) : 3;
      localStorage.setItem(KEY, String(next));
      setConcurrency(next);
    },
  };
}

export type ConcurrencyUnit = "screens" | "scenarios";

function unitNoun(unit: ConcurrencyUnit, n: number): string {
  if (unit === "scenarios") return n === 1 ? "scenario" : "scenarios";
  return n === 1 ? "screen" : "screens";
}

function unitTitle(unit: ConcurrencyUnit): string {
  if (unit === "scenarios") return "How many scenarios run at once on this screen";
  return "When you Run report: how many screens at once. When you run one screen: how many scenarios at once.";
}

export function ConcurrencySelect({
  value,
  onChange,
  disabled,
  unit,
}: {
  value: number;
  onChange: (n: number) => void;
  disabled?: boolean;
  /** Noun for the items this control actually parallelizes on this page. */
  unit: ConcurrencyUnit;
}) {
  return (
    <Select value={String(value)} onValueChange={(v) => onChange(Number(v))} disabled={disabled}>
      <SelectTrigger className={unit === "scenarios" ? "w-[11rem] h-9" : "w-[8.5rem] h-9"} title={unitTitle(unit)}>
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {OPTIONS.map((n) => (
          <SelectItem key={n} value={String(n)}>
            {n} parallel {unitNoun(unit, n)}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}
