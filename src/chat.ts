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
  choices: { finish_reason: string | null; message: { role: "assistant"; content: string | null; tool_calls?: ToolCall[] } }[];
};

export const HACKCLUB_AI_BASE = "https://ai.hackclub.com/proxy/v1";
export const OPENROUTER_BASE = "https://openrouter.ai/api/v1";

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
    let failure: Error | undefined;
    for (let attempt = 0; attempt < 3; attempt++) {
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
        if (attempt === 2) break;
        await new Promise((resolve) => setTimeout(resolve, 300 * 2 ** attempt + Math.random() * 200));
        continue;
      }
      if (response.ok) return response;
      failure = new Error(`${this.options.label} ${response.status}: ${await response.text()}`);
      const retryable = response.status === 408 || response.status === 429 || response.status >= 500;
      if (!retryable || attempt === 2) break;
      await new Promise((resolve) => setTimeout(resolve, 300 * 2 ** attempt + Math.random() * 200));
    }
    throw failure ?? new Error(`${this.options.label} request failed`);
  }

  async chat(body: Record<string, unknown>) {
    const response = await this.request("chat/completions", body);
    return (await response.json()) as ChatCompletion;
  }
}

export class FallbackChatClient {
  constructor(private primary: ChatClient, private fallback?: ChatClient) {}

  async chat(body: Record<string, unknown>) {
    try {
      return await this.primary.chat(body);
    } catch (error) {
      if (!this.fallback) throw error;
      const detail = error instanceof Error ? error.message : String(error);
      console.warn(`${this.primary.label} failed (${detail}); falling back to ${this.fallback.label}`);
      return await this.fallback.chat(body);
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
