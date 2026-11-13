import type { HeadlessStep } from "@/lib/headlessTrace";

export function HeadlessStepLog({ steps, running }: { steps: HeadlessStep[]; running: boolean }) {
  if (!steps.length) return null;
  const latest = steps[steps.length - 1];
  return <section className="space-y-2 border border-border rounded p-3">
    <div className="text-xs font-semibold">Headless steps {running ? "· Running" : "· Finished"}</div>
    {latest && <div className="text-xs text-muted-foreground">{latest.step} · {latest.state} · {(latest.elapsed_ms / 1000).toFixed(1)}s</div>}
    <div className="max-h-64 overflow-auto font-mono text-[11px] space-y-1" aria-label="Headless step logs">
      {steps.map(step => <div key={step.sequence} className="break-words">{step.timestamp} · {step.state} · {step.step} · {(step.elapsed_ms / 1000).toFixed(1)}s</div>)}
    </div>
  </section>;
}