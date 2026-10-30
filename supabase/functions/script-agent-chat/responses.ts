import { createAnthropic } from "npm:@ai-sdk/anthropic@3.0.131";
import { streamText, type ModelMessage, type ToolSet, stepCountIs } from "npm:ai@6.0.315";

/** Normalize Magentic/Anthropic base to a `/v1` root (AI SDK appends `/messages`). */
function anthropicV1BaseUrl(baseURL: string): string {
  const base = baseURL.trim().replace(/\/+$/, "");
  if (/\/v1\/messages$/i.test(base)) return base.replace(/\/messages$/i, "");
  if (/\/v1$/i.test(base)) return base;
  return `${base}/v1`;
}

export function createResponsesCall(
  request: Request,
  config: { baseURL: string; apiKey: string; model: string },
  messages: ModelMessage[],
  instructions?: string,
  tools?: ToolSet,
  onGatewayResponse?: (response: Response) => Promise<void>,
) {
  const provider = createAnthropic({
    apiKey: config.apiKey,
    baseURL: anthropicV1BaseUrl(config.baseURL),
    fetch: async (input, init) => {
      const response = await fetch(input, init);
      await onGatewayResponse?.(response);
      return response;
    },
  });

  // Magentic (chat.int.bayer.com) 502s when AI SDK defaults max_tokens to 128000
  // for unknown claude-* model ids. Cap output like heal-script / repair.
  const result = streamText({
    model: provider(config.model),
    ...(instructions ? { system: instructions } : {}),
    messages,
    tools,
    maxOutputTokens: 8_192,
    stopWhen: stepCountIs(12),
    maxRetries: 1,
    abortSignal: request.signal,
  });

  return {
    result,
    // Kept for call-site compatibility with the former Lovable run-id wrapper.
    runIdFetch: {
      fetch: globalThis.fetch.bind(globalThis),
      getRunId: () => undefined as string | undefined,
      waitForRunId: async () => undefined as string | undefined,
    },
    response: () => result.toUIMessageStreamResponse({ sendReasoning: true }),
  };
}
