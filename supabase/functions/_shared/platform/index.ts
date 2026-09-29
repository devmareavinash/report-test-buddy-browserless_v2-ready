// Cloud-agnostic platform adapters (server-side facade).
//
// The existing edge functions still call Supabase directly via getSupabase()
// for brevity; the interfaces below describe the contract so the same logic
// can be ported to AWS Lambda + RDS + S3 + SQS + Secrets Manager without
// changing business code. AWS impls are sketched in /infra/README.md.

export interface ServerDb {
  query(table: string): unknown;
}
export interface ServerStorage {
  putObject(bucket: string, key: string, bytes: Uint8Array, contentType: string): Promise<string>;
}
export interface ServerSecrets {
  get(name: string): Promise<string | undefined>;
}
export interface ServerQueue {
  enqueue(name: string, payload: unknown): Promise<void>;
}
export interface BrowserRuntime {
  runHeaded(opts: { code: string; scenarioId?: string }): Promise<{ live_url: string }>;
  runHeadless(opts: { code: string; scenarioId?: string }): Promise<{ extracted: Record<string, unknown>; screenshot_url?: string; dom_snapshot_url?: string }>;
}

// EnvSecrets works for both Supabase (env injected) and AWS Lambda
// (Secrets Manager secrets surfaced via the `secrets` extension layer).
export const envSecrets: ServerSecrets = {
  async get(name: string) { return Deno.env.get(name); },
};
