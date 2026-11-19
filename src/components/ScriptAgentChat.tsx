import { useEffect, useMemo, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useChat } from "@ai-sdk/react";
import { DefaultChatTransport, isToolUIPart, type UIMessage } from "ai";
import { supabase } from "@/integrations/supabase/client";
import { functionEndpoint, functionAuthHeaders } from "@/lib/functions";
import { Sheet, SheetContent, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { Button } from "@/components/ui/button";
import { Conversation, ConversationContent, ConversationScrollButton } from "@/components/ai-elements/conversation";
import { Message, MessageContent, MessageResponse } from "@/components/ai-elements/message";
import { PromptInput, PromptInputTextarea, PromptInputFooter, PromptInputSubmit } from "@/components/ai-elements/prompt-input";
import { Tool, ToolHeader, ToolContent, ToolInput, ToolOutput } from "@/components/ai-elements/tool";
import { Reasoning, ReasoningTrigger, ReasoningContent } from "@/components/ai-elements/reasoning";
import { Shimmer } from "@/components/ai-elements/shimmer";
import { canApplyScriptProposal, parseConversationStore, type ScriptProposal } from "@/lib/script-agent-proposal";
import logo from "@/assets/logo.png";
import { FileCode2, Check } from "lucide-react";
import { toast } from "sonner";

type Props = {
  open: boolean; onOpenChange: (open: boolean) => void;
  scriptId: string; title: string; code: string; runtimeError: string | null;
  onApply: (code: string) => void;
  /** Which persisted thread to load (backend ConversationStore v2). */
  target?: "main" | "reference";
};

export function ScriptAgentChat(props: Props) {
  const history = useQuery({
    queryKey: ["script-agent-chat", props.scriptId], enabled: props.open, staleTime: 0,
    queryFn: async () => {
      const { data: auth } = await supabase.auth.getUser();
      if (!auth.user) throw new Error("Please sign in again.");
      const { data, error } = await supabase.from("script_agent_conversations").select("messages")
        .eq("script_id", props.scriptId).eq("user_id", auth.user.id).maybeSingle();
      if (error) throw new Error(error.message);
      const raw = data?.messages;
      const parsed = parseConversationStore(raw);
      const target = props.target ?? "main";
      const thread = parsed[target];
      return (Array.isArray(thread) ? thread : []) as UIMessage[];
    },
  });
  return <Sheet open={props.open} onOpenChange={props.onOpenChange}>
    <SheetContent side="right" aria-describedby={undefined} className="flex w-[min(100vw,480px)] max-w-none flex-col gap-0 p-0 sm:max-w-[480px]">
      <SheetHeader className="border-b border-border p-4 pr-12 text-left">
        <SheetTitle className="flex items-center gap-2 text-base"><img src={logo} className="h-7 w-7 object-contain" alt="" />Agent chat</SheetTitle>
        <div className="truncate text-xs text-muted-foreground">{props.title}</div>
      </SheetHeader>
      {history.isPending ? <div className="p-4"><Shimmer>Loading conversation…</Shimmer></div>
        : history.error && !history.data ? <div role="alert" className="p-4 text-sm text-destructive">{history.error.message}<Button variant="outline" size="sm" onClick={() => history.refetch()} className="mt-3">Retry loading</Button></div>
        : <ChatSession key={props.scriptId} {...props} initialMessages={history.data || []} />}
    </SheetContent>
  </Sheet>;
}

function proposalFromOutput(output: unknown): ScriptProposal | null {
  if (!output || typeof output !== "object") return null;
  const value = output as Record<string, unknown>;
  return typeof value.code === "string" && typeof value.baseCode === "string" && typeof value.explanation === "string"
    ? value as ScriptProposal : null;
}

function ChatSession({ initialMessages, ...props }: Props & { initialMessages: UIMessage[] }) {
  const current = useRef(props);
  current.current = props;
  const textarea = useRef<HTMLTextAreaElement>(null);
  const [input, setInput] = useState("");
  const [applied, setApplied] = useState<string | null>(null);
  const transport = useMemo(() => new DefaultChatTransport({
    api: functionEndpoint("script-agent-chat"), headers: functionAuthHeaders,
    body: () => ({
      scriptId: current.current.scriptId,
      code: current.current.code,
      runtimeError: current.current.runtimeError,
      target: current.current.target ?? "main",
    }),
    fetch: async (url, init) => {
      const response = await fetch(url, init);
      if (!response.ok) {
        const payload = await response.clone().json().catch(() => null);
        throw new Error(payload?.error || payload?.message || `Chat returned ${response.status}.`);
      }
      return response;
    },
  }), []);
  const { messages, sendMessage, status, stop, error } = useChat({
    id: props.scriptId, messages: initialMessages, transport,
    onError: (err) => toast.error(err.message),
  });
  const busy = status === "submitted" || status === "streaming";
  useEffect(() => {
    if (!busy) textarea.current?.focus();
  }, [busy, props.scriptId]);
  const safeMessages = Array.isArray(messages) ? messages : [];
  return <div className="flex min-h-0 flex-1 flex-col">
    <Conversation className="min-h-0" aria-label="Script agent conversation">
      <ConversationContent className="gap-5">
        {!safeMessages.length && <div className="flex items-center gap-2 py-5 text-sm text-muted-foreground"><FileCode2 className="h-5 w-5" />{props.title}</div>}
        {safeMessages.map((message) => <Message key={message.id} from={message.role} className="max-w-full">
          <MessageContent className={message.role === "user" ? "group-[.is-user]:bg-primary group-[.is-user]:text-primary-foreground rounded-md" : "w-full"}>
            {(Array.isArray(message.parts) ? message.parts : []).map((part, index) => {
              if (part.type === "text") return <MessageResponse key={index}>{part.text}</MessageResponse>;
              if (part.type === "reasoning") return <Reasoning key={index} defaultOpen={false} isStreaming={part.state === "streaming"}><ReasoningTrigger /><ReasoningContent>{part.text}</ReasoningContent></Reasoning>;
              if (isToolUIPart(part)) {
                const proposal = part.state === "output-available" ? proposalFromOutput(part.output) : null;
                const stale = proposal && !canApplyScriptProposal(proposal, props.code);
                return <div key={part.toolCallId} className="w-full min-w-0">
                  <Tool defaultOpen={false}>{part.type === "dynamic-tool" ? <ToolHeader type={part.type} toolName={part.toolName} state={part.state} title="Script correction" /> : <ToolHeader type={part.type} state={part.state} title="Script correction" />}<ToolContent><ToolInput input={part.input} /><ToolOutput output={part.state === "output-available" ? part.output : undefined} errorText={part.state === "output-error" ? part.errorText : undefined} /></ToolContent></Tool>
                  {proposal && <div className="space-y-2 text-sm">
                    <p>{proposal.explanation}</p>
                    <pre className="mono max-h-64 overflow-auto rounded-md border border-border bg-secondary/30 p-3 text-xs">{proposal.code}</pre>
                    <Button size="sm" variant="outline" disabled={busy || !!stale || applied === part.toolCallId} onClick={() => {
                      if (!canApplyScriptProposal(proposal, current.current.code)) return toast.error("Script changed. Ask for a new correction.");
                      props.onApply(proposal.code); setApplied(part.toolCallId); textarea.current?.focus();
                    }}><Check className="h-4 w-4" />{applied === part.toolCallId ? "Loaded into editor" : "Use in editor"}</Button>
                    {stale && applied !== part.toolCallId && <p className="text-xs text-muted-foreground">Script changed since this proposal.</p>}
                  </div>}
                </div>;
              }
              return null;
            })}
          </MessageContent>
        </Message>)}
        {status === "submitted" && <Shimmer>Thinking…</Shimmer>}
      </ConversationContent>
      <ConversationScrollButton />
    </Conversation>
    <div className="border-t border-border p-3">
      {error && <p role="alert" className="mb-2 break-words text-sm text-destructive">{error.message}</p>}
      <PromptInput onSubmit={({ text }) => {
        if (!text.trim() || busy) return;
        void sendMessage({ text }); setInput(""); textarea.current?.focus();
      }}>
        <PromptInputTextarea ref={textarea} value={input} onChange={(event) => setInput(event.target.value)} placeholder="What should change in this script?" aria-label="Message script agent" className="min-h-24 max-h-48" />
        <PromptInputFooter className="justify-end"><PromptInputSubmit status={status} disabled={!busy && !input.trim()} onStop={() => { stop(); textarea.current?.focus(); }} /></PromptInputFooter>
      </PromptInput>
    </div>
  </div>;
}