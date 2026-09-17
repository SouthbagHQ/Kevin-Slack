import { createLogger, preview, timer } from "./logger.js";

export type ToolCall = {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
};

export type Message =
  | { role: "system"; content: string }
  | { role: "user"; content: string | ({ type: "text"; text: string } | { type: "image_url"; image_url: { url: string } })[] }
  | { role: "assistant"; content: string | null; tool_calls?: ToolCall[] }
  | { role: "tool"; content: string; tool_call_id: string };

export type ChatCompletion = {
  model?: string;
  usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };
  choices: { finish_reason: string | null; message: { role: "assistant"; content: string | null; tool_calls?: ToolCall[] } }[];
};

export const HACKCLUB_AI_BASE = "https://ai.hackclub.com/proxy/v1";
export const OPENROUTER_BASE = "https://openrouter.ai/api/v1";

const log = createLogger("chat");

/** Describes a request without logging prompts, tool results, or image bytes. */
const describeRequest = (body: Record<string, unknown>) => {
  const messages = Array.isArray(body.messages) ? (body.messages as Message[]) : [];
  const images = messages.filter((message) => Array.isArray(message.content) && message.content.some((part) => "image_url" in part)).length;
  return {
    model: typeof body.model === "string" ? body.model : undefined,
    messages: messages.length,
    roles: messages.reduce<Record<string, number>>((counts, { role }) => ({ ...counts, [role]: (counts[role] ?? 0) + 1 }), {}),
    images: images || undefined,
    tools: Array.isArray(body.tools) ? body.tools.length : 0,
    temperature: body.temperature,
    maxTokens: body.max_tokens,
  };
};

/** Describes a completion: what came back, not what it said. */
const describeCompletion = (completion: ChatCompletion) => {
  const choice = completion.choices[0];
  return {
    servedModel: completion.model,
    finishReason: choice?.finish_reason ?? undefined,
    toolCalls: choice?.message.tool_calls?.length ?? 0,
    toolNames: choice?.message.tool_calls?.map((call) => call.function.name),
    contentChars: choice?.message.content?.length ?? 0,
    promptTokens: completion.usage?.prompt_tokens,
    completionTokens: completion.usage?.completion_tokens,
  };
};

export type ChatClientOptions = {
  baseUrl: string;
  label: string;
  timeoutMs?: number;
  extraHeaders?: Record<string, string>;
  extraBody?: Record<string, unknown>;
};

export class ChatClient {
  constructor(private key: string, private options: ChatClientOptions) {}

  get label() {
    return this.options.label;
  }

  private headers() {
    return {
      Authorization: `Bearer ${this.key}`,
      "Content-Type": "application/json",
      ...this.options.extraHeaders,
    };
  }

  private async request(path: string, body: Record<string, unknown>) {
    const timeoutMs = this.options.timeoutMs ?? 45_000;
    const provider = this.options.label;
    let failure: Error | undefined;
    for (let attempt = 0; attempt < 3; attempt++) {
      const elapsed = timer();
      let response: Response;
      try {
        response = await fetch(`${this.options.baseUrl}/${path}`, {
          method: "POST",
          headers: this.headers(),
          body: JSON.stringify({ ...body, ...this.options.extraBody }),
          signal: AbortSignal.timeout(timeoutMs),
        });
      } catch (error) {
        failure = error instanceof Error ? error : new Error(String(error));
        const lastAttempt = attempt === 2;
        log.warn("Chat request failed to reach the provider", {
          provider,
          path,
          attempt: attempt + 1,
          ms: elapsed(),
          timeoutMs,
          giveUp: lastAttempt,
          error: failure.message,
          errorType: failure.name,
        });
        if (lastAttempt) break;
        const backoff = 300 * 2 ** attempt + Math.random() * 200;
        log.debug("Retrying chat request", { provider, path, attempt: attempt + 1, backoffMs: Math.round(backoff) });
        await new Promise((resolve) => setTimeout(resolve, backoff));
        continue;
      }
      if (response.ok) {
        log.debug("Chat request ok", { provider, path, attempt: attempt + 1, status: response.status, ms: elapsed() });
        return response;
      }
      const detail = await response.text();
      failure = new Error(`${provider} ${response.status}: ${detail}`);
      const retryable = response.status === 408 || response.status === 429 || response.status >= 500;
      const lastAttempt = attempt === 2;
      log.warn("Chat request rejected", {
        provider,
        path,
        attempt: attempt + 1,
        status: response.status,
        retryable,
        giveUp: !retryable || lastAttempt,
        ms: elapsed(),
        retryAfter: response.headers.get("retry-after") ?? undefined,
        body: preview(detail, 300),
      });
      if (!retryable || lastAttempt) break;
      const backoff = 300 * 2 ** attempt + Math.random() * 200;
      log.debug("Retrying chat request", { provider, path, attempt: attempt + 1, backoffMs: Math.round(backoff) });
      await new Promise((resolve) => setTimeout(resolve, backoff));
    }
    throw failure ?? new Error(`${provider} request failed`);
  }

  async chat(body: Record<string, unknown>) {
    const elapsed = timer();
    const request = describeRequest(body);
    log.debug("Chat completion requested", { provider: this.label, ...request });
    const response = await this.request("chat/completions", body);
    const completion = (await response.json()) as ChatCompletion;
    log.info("Chat completion received", { provider: this.label, model: request.model, ...describeCompletion(completion), ms: elapsed() });
    return completion;
  }
}

export class FallbackChatClient {
  constructor(private primary: ChatClient, private fallback?: ChatClient) {}

  async chat(body: Record<string, unknown>) {
    try {
      return await this.primary.chat(body);
    } catch (error) {
      if (!this.fallback) {
        log.failure("Chat failed and no fallback provider is configured", error, { provider: this.primary.label });
        throw error;
      }
      log.warn("Primary chat provider failed; falling back", {
        provider: this.primary.label,
        fallback: this.fallback.label,
        error: error instanceof Error ? error.message : String(error),
      });
      try {
        const completion = await this.fallback.chat(body);
        log.info("Fallback chat provider succeeded", { provider: this.fallback.label });
        return completion;
      } catch (fallbackError) {
        log.failure("Fallback chat provider also failed", fallbackError, { provider: this.fallback.label, primary: this.primary.label });
        throw fallbackError;
      }
    }
  }
}

export function createKevinChat(hackClubAiKey: string, openRouterKey: string) {
  return new FallbackChatClient(
    new ChatClient(hackClubAiKey, { baseUrl: HACKCLUB_AI_BASE, label: "Hack Club AI" }),
    new ChatClient(openRouterKey, {
      baseUrl: OPENROUTER_BASE,
      label: "OpenRouter",
      extraHeaders: { "X-OpenRouter-Title": "Kevin Slack" },
      extraBody: { provider: { data_collection: "deny" } },
    }),
  );
}
