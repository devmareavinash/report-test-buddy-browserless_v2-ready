// Cloud-agnostic platform adapters (browser-side facade).
// All UI code accesses the backend through these interfaces so the same app
// can run on Lovable Cloud (Supabase) today or AWS-native (RDS + Cognito + S3
// + Lambda + EventBridge + SQS + Bedrock + Fargate Playwright) in production.
//
// Switch via VITE_PLATFORM_PROVIDER ("supabase" | "aws"). Today only the
// supabase implementation is wired; AWS impls live alongside this file as
// stubs and are documented in /infra/README.md.

import { supabase } from "@/integrations/supabase/client";
import { invokeFunction } from "@/lib/functions";

export interface DbAdapter {
  from(table: string): any;
  invoke(name: string, body: any): Promise<{ data: any; error: any }>;
}
export interface AuthAdapter {
  getSession(): Promise<any>;
}
export interface StorageAdapter {
  publicUrl(bucket: string, path: string): string;
}

class SupabaseDb implements DbAdapter {
  from(table: string) { return supabase.from(table as any); }
  invoke(name: string, body: any) { return invokeFunction(name, body); }
}
class SupabaseAuth implements AuthAdapter {
  async getSession() { return (await supabase.auth.getSession()).data.session; }
}
class SupabaseStorage implements StorageAdapter {
  publicUrl(bucket: string, path: string) {
    return supabase.storage.from(bucket).getPublicUrl(path).data.publicUrl;
  }
}

const provider = (import.meta.env.VITE_PLATFORM_PROVIDER as string) || "supabase";

export const db: DbAdapter = new SupabaseDb();
export const auth: AuthAdapter = new SupabaseAuth();
export const storage: StorageAdapter = new SupabaseStorage();
export const PLATFORM_PROVIDER = provider;
