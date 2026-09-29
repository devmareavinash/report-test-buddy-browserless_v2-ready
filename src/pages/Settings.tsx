import { useQuery, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { AppLayout } from "@/components/AppLayout";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useState, useEffect } from "react";
import { useSearchParams } from "react-router-dom";
import { toast } from "sonner";
import { Copy, Pencil, Trash2 } from "lucide-react";
import { invokeFunction } from "@/lib/functions";
import {
  resolveSfAuthMethod,
  snowflakePayload,
  testWarehouseConnectivity,
  type SfAuthMethod,
} from "@/lib/snowflakeAuth";


const LLM_KINDS = ["ai_gateway", "openai", "anthropic", "google", "azure_openai", "bedrock", "custom_wrapper"];
const WH_KINDS = ["snowflake", "redshift", "databricks", "bigquery", "postgres", "rest", "mock"];
const AGENTS = ["scrape", "scenarios", "scripts", "warehouse", "orchestrate", "analyze", "heal"];

export default function Settings() {
  const [params, setParams] = useSearchParams();
  const tab = params.get("tab") || "llm";
  return (
    <AppLayout>
      <div className="p-8 space-y-4">
        <h1 className="text-2xl font-semibold">Settings</h1>
        <Tabs value={tab} onValueChange={(v) => { const next = new URLSearchParams(params); next.set("tab", v); setParams(next, { replace: true }); }}>
          <TabsList>
            <TabsTrigger value="llm">LLM Providers</TabsTrigger>
            <TabsTrigger value="agents">Agent Models</TabsTrigger>
            <TabsTrigger value="warehouse">Warehouses</TabsTrigger>
            <TabsTrigger value="creds">Screen Credentials</TabsTrigger>
            <TabsTrigger value="browser">Browser Runtime</TabsTrigger>
            
            <TabsTrigger value="schedule">Schedules</TabsTrigger>
            <TabsTrigger value="api">External Triggers</TabsTrigger>
            <TabsTrigger value="org">Reports</TabsTrigger>
          </TabsList>
          <TabsContent value="llm"><LlmTab /></TabsContent>
          <TabsContent value="agents"><AgentsTab /></TabsContent>
          <TabsContent value="warehouse"><WarehouseTab /></TabsContent>
          <TabsContent value="creds"><CredsTab /></TabsContent>
          <TabsContent value="browser"><BrowserTab /></TabsContent>
          
          <TabsContent value="schedule"><SchedulesTab /></TabsContent>
          <TabsContent value="api"><ApiTab /></TabsContent>
          <TabsContent value="org"><OrgTab /></TabsContent>
        </Tabs>
      </div>
    </AppLayout>
  );
}

function LlmTab() {
  const qc = useQueryClient();
  const { data } = useQuery({ queryKey: ["llm"], queryFn: async () => (await supabase.from("llm_providers").select("*")).data ?? [] });
  const [name, setName] = useState("");
  const [kind, setKind] = useState("openai");
  const [base, setBase] = useState("");
  const [model, setModel] = useState("");
  const [key, setKey] = useState("");
  const [headers, setHeaders] = useState("{}");
  const [tpl, setTpl] = useState("");

  const add = async () => {
    if (!name) return toast.error("Name required");
    let extra: any = {};
    try { extra = { headers: JSON.parse(headers || "{}") }; } catch { return toast.error("Headers must be JSON"); }
    const { error } = await supabase.from("llm_providers").insert({
      name, kind, base_url: base || null, model_default: model || null,
      api_key_secret_ref: key || null, wrapper_payload_template: tpl || null, extra,
    });
    if (error) return toast.error(error.message);
    setName(""); setBase(""); setModel(""); setKey(""); setHeaders("{}"); setTpl("");
    toast.success("Saved. Add the API key as a secret named above to use it.");
    qc.invalidateQueries({ queryKey: ["llm"] });
  };
  return (
    <div className="space-y-4 mt-4">
      <Card>
        <CardHeader><CardTitle>Add provider</CardTitle></CardHeader>
        <CardContent className="grid grid-cols-2 gap-2">
          <Input placeholder="Name (e.g. My OpenAI)" value={name} onChange={(e) => setName(e.target.value)} />
          <Select value={kind} onValueChange={setKind}>
            <SelectTrigger><SelectValue /></SelectTrigger>
            <SelectContent>{LLM_KINDS.map((k) => <SelectItem key={k} value={k}>{k}</SelectItem>)}</SelectContent>
          </Select>
          <Input placeholder="Base URL (required for custom_wrapper / azure / ai_gateway override)" value={base} onChange={(e) => setBase(e.target.value)} />
          <Input placeholder="Default model (e.g. gpt-5, claude-sonnet-4)" value={model} onChange={(e) => setModel(e.target.value)} />
          <Input placeholder="API key secret name (e.g. OPENAI_API_KEY)" value={key} onChange={(e) => setKey(e.target.value)} />
          <Input placeholder='Extra headers JSON (e.g. {"x-tenant":"acme"})' value={headers} onChange={(e) => setHeaders(e.target.value)} className="mono text-xs" />
          {kind === "custom_wrapper" && (
            <Textarea
              placeholder='Wrapper payload template — use {{model}}, {{messages}}. e.g. {"model":"{{model}}","input":{{messages}}}'
              value={tpl} onChange={(e) => setTpl(e.target.value)} className="mono text-xs col-span-2 min-h-[80px]"
            />
          )}
          <Button onClick={add}>Add provider</Button>
        </CardContent>
      </Card>
      <div className="space-y-2">
        {(data || []).map((p) => (
          <div key={p.id} className="border border-border rounded p-3 text-sm flex justify-between">
            <div><span className="font-medium">{p.name}</span> <span className="text-muted-foreground mono text-xs ml-2">{p.kind} · {p.model_default}</span></div>
            <span className="text-xs text-muted-foreground mono">{p.api_key_secret_ref || "—"}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

function AgentsTab() {
  const qc = useQueryClient();
  const { data: configs } = useQuery({ queryKey: ["agent-cfg"], queryFn: async () => (await supabase.from("agent_model_config").select("*")).data ?? [] });
  const { data: providers } = useQuery({ queryKey: ["llm"], queryFn: async () => (await supabase.from("llm_providers").select("*")).data ?? [] });
  const upsert = async (agent_key: string, patch: any) => {
    const existing = configs?.find((c) => c.agent_key === agent_key);
    if (existing) await supabase.from("agent_model_config").update(patch).eq("id", existing.id);
    else await supabase.from("agent_model_config").insert({ agent_key, ...patch });
    qc.invalidateQueries({ queryKey: ["agent-cfg"] });
  };
  return (
    <div className="space-y-2 mt-4">
      {AGENTS.map((a) => {
        const cfg = configs?.find((c) => c.agent_key === a);
        return (
          <Card key={a}>
            <CardContent className="pt-4 space-y-2">
              <div className="grid grid-cols-3 gap-2 items-center">
                <div className="font-medium mono text-sm">{a}</div>
                <Select defaultValue={cfg?.llm_provider_id || ""} onValueChange={(v) => upsert(a, { llm_provider_id: v, model: cfg?.model || "" })}>
                  <SelectTrigger><SelectValue placeholder="Provider" /></SelectTrigger>
                  <SelectContent>{(providers || []).map((p) => <SelectItem key={p.id} value={p.id}>{p.name}</SelectItem>)}</SelectContent>
                </Select>
                <Input placeholder="Model id" defaultValue={cfg?.model || ""} onBlur={(e) => upsert(a, { model: e.target.value })} />
              </div>
              <Textarea
                className="mono text-xs min-h-[60px]"
                placeholder="System instruction for this agent (overrides default prompt)…"
                defaultValue={(cfg as any)?.system_instruction || ""}
                onBlur={(e) => upsert(a, { system_instruction: e.target.value || null })}
              />
            </CardContent>
          </Card>
        );
      })}
    </div>
  );
}

function WarehouseTab() {
  const qc = useQueryClient();
  const { data } = useQuery({ queryKey: ["wh"], queryFn: async () => (await supabase.from("warehouse_connectors").select("*")).data ?? [] });
  const [editingId, setEditingId] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [kind, setKind] = useState("snowflake");
  const [account, setAccount] = useState("");
  const [host, setHost] = useState("");
  const [db, setDb] = useState("");
  const [schema, setSchema] = useState("");
  const [warehouse, setWarehouse] = useState("");
  const [role, setRole] = useState("");
  const [user, setUser] = useState("");
  const [pass, setPass] = useState("");
  const [token, setToken] = useState("");
  const [sfAuthMethod, setSfAuthMethod] = useState<SfAuthMethod>("password");
  const [idpUrl, setIdpUrl] = useState("");
  const [privateKeyPath, setPrivateKeyPath] = useState("");
  const [privateKeyPem, setPrivateKeyPem] = useState("");
  const [privateKeyPassphrase, setPrivateKeyPassphrase] = useState("");
  const [testing, setTesting] = useState(false);
  const [saving, setSaving] = useState(false);

  const formFields = () => ({
    name, kind, account, host, database: db, schema, warehouse, role,
    username: user, password_secret_ref: pass, token_secret_ref: token,
    private_key_path: privateKeyPath, private_key_pem: privateKeyPem,
    private_key_passphrase: privateKeyPassphrase,
  });

  const resetForm = () => {
    setEditingId(null);
    setName(""); setAccount(""); setHost(""); setDb(""); setSchema(""); setWarehouse("");
    setRole(""); setUser(""); setPass(""); setToken(""); setIdpUrl("");
    setPrivateKeyPath(""); setPrivateKeyPem(""); setPrivateKeyPassphrase(""); setSfAuthMethod("password");
  };

  const validateForm = () => {
    if (!name.trim()) {
      toast.error("Name required");
      return false;
    }
    if ((sfAuthMethod === "sso" || sfAuthMethod === "keypair") && !user.trim()) {
      toast.error("Username is required for SSO and key-pair auth");
      return false;
    }
    if (sfAuthMethod === "keypair" && !privateKeyPath.trim() && !privateKeyPem.trim()) {
      toast.error("Paste the private key PEM or a key path for key-pair auth");
      return false;
    }
    return true;
  };

  const startEdit = (w: any) => {
    const extra = (w.extra || {}) as Record<string, unknown>;
    const method = resolveSfAuthMethod(
      typeof extra.authenticator === "string" ? extra.authenticator : null,
      w.auth_method,
    );
    setEditingId(w.id);
    setName(w.name || "");
    setKind(w.kind || "snowflake");
    setAccount(w.account || "");
    setHost(w.host || "");
    setDb(w.database || "");
    setSchema(w.schema || "");
    setWarehouse(w.warehouse || "");
    setRole(w.role || "");
    setUser(w.username || "");
    setPass(w.password_secret_ref || "");
    setToken(w.token_secret_ref || "");
    setSfAuthMethod(method);
    const authenticator = typeof extra.authenticator === "string" ? extra.authenticator : "";
    setIdpUrl(authenticator.toLowerCase().startsWith("http") ? authenticator : "");
    setPrivateKeyPath(typeof extra.private_key_path === "string" ? extra.private_key_path : "");
    setPrivateKeyPem(typeof extra.private_key_pem === "string" ? extra.private_key_pem : "");
    setPrivateKeyPassphrase(typeof extra.private_key_passphrase === "string" ? extra.private_key_passphrase : "");
    window.scrollTo({ top: 0, behavior: "smooth" });
  };

  const save = async () => {
    if (!validateForm()) return;
    setSaving(true);
    try {
      const payload = snowflakePayload(formFields(), sfAuthMethod, idpUrl);
      if (editingId) {
        const { error } = await supabase.from("warehouse_connectors").update(payload).eq("id", editingId);
        if (error) return toast.error(error.message);
        toast.success("Warehouse updated");
      } else {
        const { error } = await supabase.from("warehouse_connectors").insert(payload);
        if (error) return toast.error(error.message);
        toast.success("Warehouse saved");
      }
      resetForm();
      qc.invalidateQueries({ queryKey: ["wh"] });
    } finally {
      setSaving(false);
    }
  };

  const testConnection = async () => {
    if (!account && !host) return toast.error("Account is required");
    if (!warehouse || !role) return toast.error("Warehouse and role are required");
    if (sfAuthMethod === "password" && (!user || !pass)) return toast.error("Username and password required for password auth");
    if (sfAuthMethod === "sso" && !user.trim()) return toast.error("Username is required for SSO (Snowflake error 251005)");
    if (sfAuthMethod === "token" && !token) return toast.error("OAuth token secret name required");
    if (sfAuthMethod === "keypair") {
      if (!user.trim()) return toast.error("Username is required for key-pair auth");
      if (!privateKeyPath.trim() && !privateKeyPem.trim()) {
        return toast.error("Paste the private key PEM or a key path for key-pair auth");
      }
    }
    setTesting(true);
    try {
      const payload = snowflakePayload(formFields(), sfAuthMethod, idpUrl);
      const { data: result, error } = await testWarehouseConnectivity(payload);
      if (error) return toast.error(error.message);
      if (result?.ok) {
        toast.success(result.message || `Connected (${result.auth_mode})${result.version ? ` · ${result.version}` : ""}`);
      } else {
        toast.error(result?.error || "Connection failed", {
          description: Array.isArray(result?.hints) ? result.hints.join(" ") : undefined,
          duration: 12000,
        });
      }
    } finally {
      setTesting(false);
    }
  };

  const testSaved = async (w: any) => {
    setTesting(true);
    try {
      const { data: result, error } = await invokeFunction("test-warehouse-connectivity", { connector_id: w.id });
      if (error) return toast.error(error.message);
      if (result?.ok) {
        toast.success(result.message || `Connected (${result.auth_mode})${result.version ? ` · ${result.version}` : ""}`);
      } else {
        toast.error(result?.error || "Connection failed", {
          description: Array.isArray(result?.hints) ? result.hints.join(" ") : undefined,
          duration: 12000,
        });
      }
    } finally {
      setTesting(false);
    }
  };

  const authLabel = (w: any) => {
    const extra = (w.extra || {}) as Record<string, unknown>;
    const method = resolveSfAuthMethod(
      typeof extra.authenticator === "string" ? extra.authenticator : null,
      w.auth_method,
    );
    if (method === "sso") return "SSO";
    if (method === "token") return "OAuth token";
    if (method === "keypair") return "Key pair";
    return "Password";
  };

  return (
    <div className="space-y-4 mt-4">
      <Card>
        <CardHeader>
          <CardTitle>{editingId ? "Edit warehouse" : "Add warehouse"}</CardTitle>
        </CardHeader>
        <CardContent className="grid grid-cols-2 gap-2">
          <Input placeholder="Name (e.g. Snowflake ZS)" value={name} onChange={(e) => setName(e.target.value)} />
          <Select value={kind} onValueChange={setKind}>
            <SelectTrigger><SelectValue /></SelectTrigger>
            <SelectContent>{WH_KINDS.map((k) => <SelectItem key={k} value={k}>{k}</SelectItem>)}</SelectContent>
          </Select>
          <Input placeholder="Account (e.g. dt13979.ap-south-1.aws)" value={account} onChange={(e) => setAccount(e.target.value)} />
          <Input placeholder="Host (optional, full *.snowflakecomputing.com)" value={host} onChange={(e) => setHost(e.target.value)} />
          <Input placeholder="Database (e.g. DB_ZS_DATA)" value={db} onChange={(e) => setDb(e.target.value)} />
          <Input placeholder="Schema (e.g. PUBLIC)" value={schema} onChange={(e) => setSchema(e.target.value)} />
          <Input placeholder="Warehouse (e.g. COMPUTE_WH)" value={warehouse} onChange={(e) => setWarehouse(e.target.value)} />
          <Input placeholder="Role (e.g. ACCOUNTADMIN)" value={role} onChange={(e) => setRole(e.target.value)} />
          <Select value={sfAuthMethod} onValueChange={(v: SfAuthMethod) => setSfAuthMethod(v)}>
            <SelectTrigger><SelectValue placeholder="Login method" /></SelectTrigger>
            <SelectContent>
              <SelectItem value="password">Password</SelectItem>
              <SelectItem value="sso">SSO (external browser)</SelectItem>
              <SelectItem value="keypair">Key pair (JWT)</SelectItem>
              <SelectItem value="token">OAuth token</SelectItem>
            </SelectContent>
          </Select>
          <Input
            placeholder={sfAuthMethod === "token" ? "Username (optional for token)" : "Username (required)"}
            value={user}
            onChange={(e) => setUser(e.target.value)}
          />
          {sfAuthMethod === "password" && (
            <Input placeholder="Password (or secret name)" type="password" value={pass} onChange={(e) => setPass(e.target.value)} />
          )}
          {sfAuthMethod === "sso" && (
            <Input placeholder="IdP URL (optional — leave blank for default SSO)" value={idpUrl} onChange={(e) => setIdpUrl(e.target.value)} className="col-span-2" />
          )}
          {sfAuthMethod === "keypair" && (
            <div className="col-span-2 space-y-2 rounded-md border border-border p-3">
              <div className="text-xs font-medium">Key pair credentials</div>
              <div className="space-y-1">
                <Label className="text-xs text-muted-foreground">Private key path (this VDI only)</Label>
                <Input
                  placeholder="C:\Users\EASXP\.snowflake\rsa_key.p8"
                  value={privateKeyPath}
                  onChange={(e) => setPrivateKeyPath(e.target.value)}
                />
              </div>
              <div className="space-y-1">
                <Label className="text-xs text-muted-foreground">Or paste PEM (local and AWS)</Label>
                <Textarea
                  className="mono text-xs min-h-[140px]"
                  placeholder={"-----BEGIN ENCRYPTED PRIVATE KEY-----\n…\n-----END ENCRYPTED PRIVATE KEY-----"}
                  value={privateKeyPem}
                  onChange={(e) => setPrivateKeyPem(e.target.value)}
                />
              </div>
              <div className="space-y-1">
                <Label className="text-xs text-muted-foreground">Private key passphrase</Label>
                <Input
                  placeholder="Required if the .p8 is encrypted"
                  type="password"
                  value={privateKeyPassphrase}
                  onChange={(e) => setPrivateKeyPassphrase(e.target.value)}
                />
              </div>
            </div>
          )}
          {sfAuthMethod === "token" && (
            <Input placeholder="OAuth token secret name (e.g. SNOWFLAKE_OAUTH_TOKEN)" value={token} onChange={(e) => setToken(e.target.value)} className="col-span-2" />
          )}
          {sfAuthMethod === "sso" && (
            <p className="col-span-2 text-xs text-muted-foreground">
              SSO (external browser) only works on your VDI, where a desktop can complete Bayer login.
              It cannot run on AWS Fargate (that produces &quot;EOF when reading a line&quot;).
              On AWS use Key pair (paste PEM) or Password with a Snowflake Programmatic Access Token.
            </p>
          )}
          {sfAuthMethod === "keypair" && (
            <p className="col-span-2 text-xs text-muted-foreground">
              Uses <span className="mono">SNOWFLAKE_JWT</span>. Test locally first: start <span className="mono">scripts/dev-sso.ps1</span> so the sidecar is on <span className="mono">http://127.0.0.1:8002</span>, then use Test connection.
              A Windows file path works on this VDI; paste the PEM if you will later run the same connector on AWS (Fargate cannot see a VDI path).
              Register the public key on the Snowflake user with <span className="mono">ALTER USER … SET RSA_PUBLIC_KEY=…</span>.
            </p>
          )}
          <div className="col-span-2 flex gap-2">
            <Button variant="outline" onClick={testConnection} disabled={testing || saving}>
              {testing ? "Testing…" : "Test connection"}
            </Button>
            <Button onClick={save} disabled={saving}>
              {saving ? "Saving…" : editingId ? "Save changes" : "Add warehouse"}
            </Button>
            {editingId && (
              <Button variant="ghost" onClick={resetForm} disabled={saving}>
                Cancel
              </Button>
            )}
          </div>
        </CardContent>
      </Card>
      <div className="space-y-2">
        {(data || []).map((w) => (
          <div
            key={w.id}
            className={`border rounded p-3 text-sm flex justify-between items-center gap-2 ${
              editingId === w.id ? "border-primary bg-muted/40" : "border-border"
            }`}
          >
            <div>
              <span className="font-medium">{w.name}</span>
              <span className="mono text-xs text-muted-foreground ml-2">
                {w.kind} · {authLabel(w)} · {w.account || w.host} · {w.database}/{w.schema}
              </span>
            </div>
            <div className="flex gap-2 shrink-0">
              <Button size="sm" variant="outline" onClick={() => startEdit(w)} disabled={testing || saving}>
                Edit
              </Button>
              <Button size="sm" variant="outline" onClick={() => testSaved(w)} disabled={testing || saving}>
                Test
              </Button>
              <Button
                size="sm"
                variant="destructive"
                disabled={testing || saving}
                onClick={async () => {
                  if (!confirm(`Delete warehouse "${w.name}"? This cannot be undone.`)) return;
                  const { error } = await supabase.from("warehouse_connectors").delete().eq("id", w.id);
                  if (error) return toast.error(error.message);
                  if (editingId === w.id) resetForm();
                  toast.success("Warehouse deleted");
                  qc.invalidateQueries({ queryKey: ["wh"] });
                }}
              >
                Delete
              </Button>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

function CredsTab() {
  const qc = useQueryClient();
  const { data } = useQuery({ queryKey: ["creds"], queryFn: async () => (await supabase.from("credential_profiles").select("*")).data ?? [] });
  const [params] = useSearchParams();
  const initialUrl = params.get("loginUrl") || "";
  const [editingId, setEditingId] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [url, setUrl] = useState(initialUrl);
  const [user, setUser] = useState("");
  const [pw, setPw] = useState("");
  useEffect(() => { if (initialUrl && !editingId) setUrl(initialUrl); }, [initialUrl, editingId]);

  const resetForm = () => {
    setEditingId(null);
    setName("");
    setUrl(initialUrl);
    setUser("");
    setPw("");
  };

  const startEdit = (c: { id: string; name: string; login_url: string | null; username: string | null; password_secret_ref: string | null }) => {
    setEditingId(c.id);
    setName(c.name || "");
    setUrl(c.login_url || "");
    setUser(c.username || "");
    setPw(c.password_secret_ref || "");
    window.scrollTo({ top: 0, behavior: "smooth" });
  };

  const save = async () => {
    if (!name.trim()) return toast.error("Profile name required");
    const payload = { name: name.trim(), login_url: url, username: user, password_secret_ref: pw || null };
    if (editingId) {
      const { error } = await supabase.from("credential_profiles").update(payload).eq("id", editingId);
      if (error) return toast.error(error.message);
      toast.success("Credential updated");
    } else {
      const { error } = await supabase.from("credential_profiles").insert(payload);
      if (error) return toast.error(error.message);
      toast.success("Saved");
    }
    resetForm();
    qc.invalidateQueries({ queryKey: ["creds"] });
  };

  const remove = async (c: { id: string; name: string }) => {
    if (!confirm(`Delete credential "${c.name}"? This cannot be undone.`)) return;
    const { error } = await supabase.from("credential_profiles").delete().eq("id", c.id);
    if (error) return toast.error(error.message);
    if (editingId === c.id) resetForm();
    toast.success("Credential deleted");
    qc.invalidateQueries({ queryKey: ["creds"] });
  };

  return (
    <div className="space-y-4 mt-4">
      <Card>
        <CardHeader>
          <CardTitle>{editingId ? "Edit credential" : "Add credential"}</CardTitle>
        </CardHeader>
        <CardContent className="grid grid-cols-2 gap-2">
          <Input placeholder="Profile name" value={name} onChange={(e) => setName(e.target.value)} />
          <Input placeholder="Login URL" value={url} onChange={(e) => setUrl(e.target.value)} />
          <Input placeholder="Username" value={user} onChange={(e) => setUser(e.target.value)} />
          <Input placeholder="Password secret name" value={pw} onChange={(e) => setPw(e.target.value)} />
          <div className="col-span-2 flex gap-2">
            <Button onClick={save}>{editingId ? "Save changes" : "Add"}</Button>
            {editingId && (
              <Button variant="ghost" onClick={resetForm}>Cancel</Button>
            )}
          </div>
        </CardContent>
      </Card>
      {(data || []).map((c) => (
        <div
          key={c.id}
          className={`border rounded p-3 text-sm flex justify-between items-center gap-2 ${
            editingId === c.id ? "border-primary bg-muted/40" : "border-border"
          }`}
        >
          <div className="min-w-0">
            {c.name}{" "}
            <span className="mono text-xs text-muted-foreground">· {c.login_url}</span>
          </div>
          <div className="flex shrink-0">
            <Button size="sm" variant="ghost" onClick={() => startEdit(c)} title="Edit">
              <Pencil className="h-3 w-3" />
            </Button>
            <Button
              size="sm"
              variant="ghost"
              onClick={() => remove(c)}
              className="text-destructive hover:text-destructive"
              title="Delete"
            >
              <Trash2 className="h-3 w-3" />
            </Button>
          </div>
        </div>
      ))}
    </div>
  );
}

function BrowserTab() {
  const qc = useQueryClient();
  const { data } = useQuery({ queryKey: ["br"], queryFn: async () => (await supabase.from("browser_runtime").select("*")).data ?? [] });
  const [name, setName] = useState(""); const [provider, setProvider] = useState("browserless"); const [secret, setSecret] = useState("BROWSER_WS_ENDPOINT");
  const add = async () => {
    await supabase.from("browser_runtime").insert({ name, provider, ws_endpoint_secret_ref: secret });
    qc.invalidateQueries({ queryKey: ["br"] }); toast.success("Saved. Add a secret with that name to point at your CDP endpoint.");
  };
  return (
    <div className="space-y-4 mt-4">
      <Card><CardContent className="pt-4 space-y-2">
        <div className="text-sm text-muted-foreground">Configure a hosted Playwright/CDP endpoint (Browserless, Browserbase, AWS Fargate, self-hosted) for live scraping and the headed script-debug stream.</div>
        <div className="text-sm text-muted-foreground">Parallelism is set on Screens (<span className="mono">N parallel screens</span> for Run report) and on a screen (<span className="mono">N parallel scenarios</span> for Run suite), or <span className="mono">ORCHESTRATE_CONCURRENCY</span> in <span className="mono">.env</span> (default 3). Browserless <span className="mono">CONCURRENT</span> should be at least as high so extra sessions queue instead of failing.</div>
        <Input placeholder="Name" value={name} onChange={(e) => setName(e.target.value)} />
        <Input placeholder="Provider (browserless|browserbase|fargate|custom)" value={provider} onChange={(e) => setProvider(e.target.value)} />
        <Input placeholder="WS endpoint secret name" value={secret} onChange={(e) => setSecret(e.target.value)} />
        <Button onClick={add}>Add</Button>
      </CardContent></Card>
      {(data || []).map((b) => <div key={b.id} className="border border-border rounded p-3 text-sm">{b.name} <span className="mono text-xs text-muted-foreground">· {b.provider} · secret:{b.ws_endpoint_secret_ref}</span></div>)}
    </div>
  );
}

function SchedulesTab() {
  const qc = useQueryClient();
  const { data } = useQuery({ queryKey: ["sched"], queryFn: async () => (await supabase.from("schedules").select("*")).data ?? [] });
  const { data: workstreams } = useQuery({ queryKey: ["sched-ws"], queryFn: async () => (await supabase.from("workstreams").select("id,name")).data ?? [] });
  const { data: reports } = useQuery({ queryKey: ["sched-reports"], queryFn: async () => (await supabase.from("reports").select("id,name")).data ?? [] });
  const [scope, setScope] = useState<"workstream" | "report">("report");
  const [scopeId, setScopeId] = useState("");
  const [cron, setCron] = useState("0 7 * * 1-5");
  const targets = scope === "workstream" ? workstreams : reports;
  const add = async () => {
    if (!scopeId) return toast.error("Pick a target");
    await supabase.from("schedules").insert({ scope_type: scope, scope_id: scopeId, cron, enabled: true });
    qc.invalidateQueries({ queryKey: ["sched"] }); toast.success("Schedule saved");
  };
  return (
    <div className="space-y-4 mt-4">
      <Card><CardContent className="pt-4 grid grid-cols-2 gap-2">
        <Select value={scope} onValueChange={(v: any) => { setScope(v); setScopeId(""); }}>
          <SelectTrigger><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem value="report">Screen</SelectItem>
            <SelectItem value="workstream">Report</SelectItem>
          </SelectContent>
        </Select>
        <Select value={scopeId} onValueChange={setScopeId}>
          <SelectTrigger><SelectValue placeholder={`Select ${scope}`} /></SelectTrigger>
          <SelectContent>{(targets || []).map((r: any) => <SelectItem key={r.id} value={r.id}>{r.name}</SelectItem>)}</SelectContent>
        </Select>
        <Input placeholder="Cron (e.g. 0 7 * * 1-5)" value={cron} onChange={(e) => setCron(e.target.value)} className="mono" />
        <Button onClick={add}>Add schedule</Button>
      </CardContent></Card>
      {(data || []).map((s) => <div key={s.id} className="border border-border rounded p-3 text-sm flex justify-between">
        <span>{s.scope_type} <span className="mono text-xs text-muted-foreground">{s.scope_id?.slice(0, 8)}</span></span>
        <span className="mono text-xs">{s.cron}</span>
      </div>)}
    </div>
  );
}

function ApiTab() {
  const qc = useQueryClient();
  const { data } = useQuery({ queryKey: ["api-tokens"], queryFn: async () => (await supabase.from("api_tokens").select("*")).data ?? [] });
  const { data: workstreams } = useQuery({ queryKey: ["api-ws"], queryFn: async () => (await supabase.from("workstreams").select("id,name")).data ?? [] });
  const { data: reports } = useQuery({ queryKey: ["api-reports"], queryFn: async () => (await supabase.from("reports").select("id,name")).data ?? [] });
  const [name, setName] = useState("");
  const [scope, setScope] = useState<"workstream" | "report">("report");
  const [scopeId, setScopeId] = useState("");
  const [latest, setLatest] = useState<string | null>(null);
  const targets = scope === "workstream" ? workstreams : reports;

  const add = async () => {
    const token = crypto.randomUUID().replace(/-/g, "") + crypto.randomUUID().replace(/-/g, "");
    const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token));
    const hash = Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, "0")).join("");
    await supabase.from("api_tokens").insert({ name, token_hash: hash, scopes: { scope_type: scope, scope_id: scopeId || null } });
    setLatest(token); setName(""); qc.invalidateQueries({ queryKey: ["api-tokens"] });
  };
  const url = `${typeof window !== "undefined" ? window.location.origin : ""}/functions/v1/trigger-run`;
  const curlBody = JSON.stringify({ scope_type: scope, scope_id: scopeId || "<id>" });
  return (
    <div className="space-y-4 mt-4">
      <Card><CardContent className="pt-4 space-y-2">
        <div className="text-sm">Webhook URL</div>
        <div className="flex gap-2">
          <Input readOnly value={url} className="mono text-xs" />
          <Button variant="outline" size="icon" onClick={() => { navigator.clipboard.writeText(url); toast.success("Copied"); }}><Copy className="h-4 w-4" /></Button>
        </div>
        <pre className="text-[11px] mono bg-secondary/50 p-3 rounded whitespace-pre-wrap">{`curl -X POST ${url} \\
  -H "Authorization: Bearer YOUR_TOKEN" \\
  -H "Content-Type: application/json" \\
  -d '${curlBody}'`}</pre>
      </CardContent></Card>
      <Card><CardContent className="pt-4 grid grid-cols-4 gap-2">
        <Input placeholder="Token name" value={name} onChange={(e) => setName(e.target.value)} />
        <Select value={scope} onValueChange={(v: any) => { setScope(v); setScopeId(""); }}>
          <SelectTrigger><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem value="report">Screen</SelectItem>
            <SelectItem value="workstream">Report</SelectItem>
          </SelectContent>
        </Select>
        <Select value={scopeId} onValueChange={setScopeId}>
          <SelectTrigger><SelectValue placeholder={`Bind to ${scope}`} /></SelectTrigger>
          <SelectContent>{(targets || []).map((r: any) => <SelectItem key={r.id} value={r.id}>{r.name}</SelectItem>)}</SelectContent>
        </Select>
        <Button onClick={add}>Generate token</Button>
      </CardContent></Card>
      {latest && (
        <div className="border border-accent/40 bg-accent/10 p-3 rounded text-sm">
          <div className="text-accent mono">Save this token now — it will not be shown again:</div>
          <div className="mono text-xs break-all mt-1">{latest}</div>
        </div>
      )}
      {(data || []).map((t: any) => <div key={t.id} className="border border-border rounded p-3 text-sm flex justify-between"><span>{t.name} <span className="mono text-xs text-muted-foreground ml-2">{t.scopes?.scope_type} · {(t.scopes?.scope_id || "").toString().slice(0,8)}</span></span><span className="mono text-xs text-muted-foreground">last used: {t.last_used_at || "never"}</span></div>)}
    </div>
  );
}

function OrgTab() {
  const qc = useQueryClient();
  const { data: ws } = useQuery({ queryKey: ["ws"], queryFn: async () => (await supabase.from("workstreams").select("*")).data ?? [] });
  const [w, setW] = useState("");
  const addW = async () => { if (!w) return; await supabase.from("workstreams").insert({ name: w }); setW(""); qc.invalidateQueries({ queryKey: ["ws"] }); };
  return (
    <div className="mt-4">
      <Card><CardHeader><CardTitle>Reports</CardTitle></CardHeader><CardContent className="space-y-2">
        <div className="flex gap-2"><Input value={w} onChange={(e) => setW(e.target.value)} placeholder="Name" /><Button onClick={addW}>Add</Button></div>
        {(ws || []).map((x) => <div key={x.id} className="text-sm border border-border rounded px-2 py-1.5">{x.name}</div>)}
      </CardContent></Card>
    </div>
  );
}
