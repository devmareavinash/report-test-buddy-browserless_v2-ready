import { useEffect, useMemo, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useChat } from "@ai-sdk/react";
import { DefaultChatTransport, isFileUIPart, isToolUIPart, type UIMessage } from "ai";
import { supabase } from "@/integrations/supabase/client";
import { functionEndpoint, functionAuthHeaders } from "@/lib/functions";
import { Sheet, SheetContent, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { Button } from "@/components/ui/button";
import { Conversation, ConversationContent, ConversationScrollButton } from "@/components/ai-elements/conversation";
import { Message, MessageContent, MessageResponse } from "@/components/ai-elements/message";
import {
  PromptInput,
  PromptInputTextarea,
  PromptInputFooter,
  PromptInputSubmit,
  PromptInputTools,
  PromptInputButton,
  usePromptInputAttachments,
  type PromptInputMessage,
} from "@/components/ai-elements/prompt-input";
import { Tool, ToolHeader, ToolContent, ToolInput, ToolOutput } from "@/components/ai-elements/tool";
import { Reasoning, ReasoningTrigger, ReasoningContent } from "@/components/ai-elements/reasoning";
import { Shimmer } from "@/components/ai-elements/shimmer";
import {
  canApplyScriptProposal,
  parseConversationStore,
  writeConversationStore,
  type ScriptChatTarget,
  type ScriptProposal,
} from "@/lib/script-agent-proposal";
import logo from "@/assets/logo.png";
import { FileCode2, Check, ImagePlus, X, Trash2 } from "lucide-react";
import { toast } from "sonner";

const MAX_CHAT_IMAGES = 4;
const MAX_CHAT_IMAGE_BYTES = 4 * 1024 * 1024;

type Props = {
  open: boolean; onOpenChange: (open: boolean) => void;
  scriptId: string; title: string; code: string; runtimeError: string | null;
  target?: ScriptChatTarget;
  onApply: (code: string) => void;
};

export function ScriptAgentChat(props: Props) {
  const target = props.target || "main";
  const queryClient = useQueryClient();
  const [clearing, setClearing] = useState(false);
  const history = useQuery({
    queryKey: ["script-agent-chat", props.scriptId, target], enabled: props.open, staleTime: 0,
    queryFn: async () => {
      const { data: auth } = await supabase.auth.getUser();
      if (!auth.user) throw new Error("Please sign in again.");
      const { data, error } = await supabase.from("script_agent_conversations").select("messages")
        .eq("script_id", props.scriptId).eq("user_id", auth.user.id).maybeSingle();
      if (error) throw new Error(error.message);
      return parseConversationStore(data?.messages)[target] as UIMessage[];
    },
  });
  const clearChat = async () => {
    if (clearing) return;
    setClearing(true);
    try {
      const { data: auth } = await supabase.auth.getUser();
      if (!auth.user) throw new Error("Please sign in again.");
      const { data: existing, error: readError } = await supabase.from("script_agent_conversations")
        .select("messages").eq("script_id", props.scriptId).eq("user_id", auth.user.id).maybeSingle();
      if (readError) throw new Error(readError.message);
      const { error } = await supabase.from("script_agent_conversations").upsert({
        script_id: props.scriptId,
        user_id: auth.user.id,
        messages: writeConversationStore(existing?.messages, target, []),
        access_denial: null,
        updated_at: new Date().toISOString(),
      }, { onConflict: "script_id,user_id" });
      if (error) throw new Error(error.message);
      await queryClient.invalidateQueries({ queryKey: ["script-agent-chat", props.scriptId, target] });
      toast.success("Chat cleared");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not clear chat");
    } finally {
      setClearing(false);
    }
  };
  const targetLabel = target === "reference" ? "Reference script" : "Main script";
  return <Sheet open={props.open} onOpenChange={props.onOpenChange}>
    <SheetContent side="right" aria-describedby={undefined} className="flex w-[min(100vw,480px)] max-w-none flex-col gap-0 p-0 sm:max-w-[480px]">
      <SheetHeader className="border-b border-border p-4 pr-12 text-left">
        <div className="flex items-start justify-between gap-2">
          <div className="min-w-0">
            <SheetTitle className="flex items-center gap-2 text-base"><img src={logo} className="h-7 w-7 object-contain" alt="" />Agent chat</SheetTitle>
            <div className="truncate text-xs text-muted-foreground">{props.title} · {targetLabel}</div>
          </div>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="shrink-0"
            disabled={clearing || history.isPending}
            onClick={() => void clearChat()}
            title="Clear chat history (fixes context window errors)"
          >
            <Trash2 className="h-4 w-4" />
            Clear
          </Button>
        </div>
      </SheetHeader>
      {history.isPending || history.isFetching ? <div className="p-4"><Shimmer>Loading conversation…</Shimmer></div>
        : history.error ? <div role="alert" className="p-4 text-sm text-destructive">{history.error.message}<Button variant="outline" size="sm" onClick={() => history.refetch()} className="mt-3">Retry loading</Button></div>
        : <ChatSession key={`${props.scriptId}-${target}-${(history.data || []).length}-${history.dataUpdatedAt}`} {...props} target={target} initialMessages={history.data || []} />}
    </SheetContent>
  </Sheet>;
}

function proposalFromOutput(output: unknown): ScriptProposal | null {
  if (!output || typeof output !== "object") return null;
  const value = output as Record<string, unknown>;
  return typeof value.code === "string" && typeof value.baseCode === "string" && typeof value.explanation === "string"
    ? value as ScriptProposal : null;
}

function ChatSession({ initialMessages, ...props }: Props & { target: ScriptChatTarget; initialMessages: UIMessage[] }) {
  const current = useRef(props);
  current.current = props;
  const textarea = useRef<HTMLTextAreaElement>(null);
  const [input, setInput] = useState("");
  const [applied, setApplied] = useState<string | null>(null);
  const transport = useMemo(() => new DefaultChatTransport({
    api: functionEndpoint("script-agent-chat"), headers: functionAuthHeaders,
    body: () => ({
      scriptId: current.current.scriptId,
      target: current.current.target || "main",
      code: current.current.code,
      runtimeError: current.current.runtimeError,
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
    id: `${props.scriptId}:${props.target}`, messages: initialMessages, transport,
    onError: (err) => toast.error(err.message),
  });
  const busy = status === "submitted" || status === "streaming";
  useEffect(() => {
    if (!busy) textarea.current?.focus();
  }, [busy, props.scriptId, props.target]);
  return <div className="flex min-h-0 flex-1 flex-col">
    <Conversation className="min-h-0" aria-label="Script agent conversation">
      <ConversationContent className="gap-5">
        {!messages.length && (
          <div className="space-y-2 py-5 text-sm text-muted-foreground">
            <div className="flex items-center gap-2 font-medium text-foreground"><FileCode2 className="h-5 w-5" />{props.title}</div>
            <p>
              Describe what failed, or attach a run screenshot. The agent proposes exact edits for this script — Use in editor → Save → Run headless.
            </p>
          </div>
        )}
        {messages.map((message) => <Message key={message.id} from={message.role} className="max-w-full">
          <MessageContent className={message.role === "user" ? "group-[.is-user]:bg-primary group-[.is-user]:text-primary-foreground rounded-md" : "w-full"}>
            {message.parts.map((part, index) => {
              if (part.type === "text") return <MessageResponse key={index}>{part.text}</MessageResponse>;
              if (isFileUIPart(part) && part.mediaType.startsWith("image/")) {
                return <img key={index} src={part.url} alt={part.filename || "Attached photo"} className="mt-1 max-h-48 max-w-full rounded-md border border-border object-contain" />;
              }
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
      <PromptInput
        accept="image/*"
        multiple
        maxFiles={MAX_CHAT_IMAGES}
        maxFileSize={MAX_CHAT_IMAGE_BYTES}
        onError={(err) => toast.error(err.message)}
        onSubmit={async ({ text, files }: PromptInputMessage) => {
          const trimmed = text.trim();
          if (busy || (!trimmed && files.length === 0)) return;
          // Clear immediately — controlled value fights PromptInput's form.reset().
          setInput("");
          try {
            await sendMessage({
              text: trimmed || "Please review the attached screenshot(s).",
              files,
            });
          } finally {
            textarea.current?.focus();
          }
        }}
      >
        <ChatAttachmentPreviews />
        <PromptInputTextarea
          ref={textarea}
          value={input}
          onChange={(event) => setInput(event.target.value)}
          placeholder="Describe the failure, or attach a run screenshot…"
          aria-label="Message script agent"
          className="min-h-24 max-h-48"
        />
        <PromptInputFooter className="justify-between gap-2">
          <PromptInputTools>
            <ChatAttachPhotosButton disabled={busy} />
          </PromptInputTools>
          <ChatSubmitButton status={status} busy={busy} input={input} onStop={() => { stop(); textarea.current?.focus(); }} />
        </PromptInputFooter>
      </PromptInput>
    </div>
  </div>;
}

function ChatAttachmentPreviews() {
  const { files, remove } = usePromptInputAttachments();
  if (!files.length) return null;
  return (
    <div className="flex flex-wrap gap-2 px-3 pt-3">
      {files.map((file) => (
        <div key={file.id} className="relative">
          {file.mediaType.startsWith("image/") ? (
            <img src={file.url} alt={file.filename || "Photo"} className="h-16 w-16 rounded-md border border-border object-cover" />
          ) : (
            <div className="flex h-16 w-16 items-center justify-center rounded-md border border-border bg-secondary text-[10px]">
              File
            </div>
          )}
          <button
            type="button"
            aria-label={`Remove ${file.filename || "attachment"}`}
            className="absolute -right-1.5 -top-1.5 rounded-full border border-border bg-background p-0.5 shadow-sm"
            onClick={() => remove(file.id)}
          >
            <X className="h-3 w-3" />
          </button>
        </div>
      ))}
    </div>
  );
}

function ChatAttachPhotosButton({ disabled }: { disabled?: boolean }) {
  const attachments = usePromptInputAttachments();
  return (
    <PromptInputButton
      type="button"
      disabled={disabled}
      tooltip="Add photos"
      onClick={() => attachments.openFileDialog()}
      aria-label="Add photos"
    >
      <ImagePlus className="size-4" />
    </PromptInputButton>
  );
}

function ChatSubmitButton({
  status,
  busy,
  input,
  onStop,
}: {
  status: ReturnType<typeof useChat>["status"];
  busy: boolean;
  input: string;
  onStop: () => void;
}) {
  const { files } = usePromptInputAttachments();
  const canSend = input.trim().length > 0 || files.length > 0;
  return (
    <PromptInputSubmit
      status={status}
      disabled={!busy && !canSend}
      onStop={onStop}
    />
  );
}
