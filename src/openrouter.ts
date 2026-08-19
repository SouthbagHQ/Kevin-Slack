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

export class OpenRouter {
  constructor(private key: string, private timeoutMs = 45_000) {}

  private headers() {
    return { Authorization: `Bearer ${this.key}`, "Content-Type": "application/json", "X-OpenRouter-Title": "Kevin Slack" };
  }

  private async request(path: string, body: Record<string, unknown>, label = "OpenRouter") {
    let failure: Error | undefined;
    for (let attempt = 0; attempt < 3; attempt++) {
      let response: Response;
      try {
        response = await fetch(`https://openrouter.ai/api/v1/${path}`, {
          method: "POST",
          headers: this.headers(),
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(this.timeoutMs),
        });
      } catch (error) {
        failure = error instanceof Error ? error : new Error(String(error));
        if (attempt === 2) break;
        await new Promise((resolve) => setTimeout(resolve, 300 * 2 ** attempt + Math.random() * 200));
        continue;
      }
      if (response.ok) return response;
      failure = new Error(`${label} ${response.status}: ${await response.text()}`);
      const retryable = response.status === 408 || response.status === 429 || response.status >= 500;
      if (!retryable || attempt === 2) break;
      await new Promise((resolve) => setTimeout(resolve, 300 * 2 ** attempt + Math.random() * 200));
    }
    throw failure ?? new Error(`${label} request failed`);
  }

  async chat(body: Record<string, unknown>) {
    const response = await this.request("chat/completions", body);
    return (await response.json()) as {
      choices: { finish_reason: string | null; message: { role: "assistant"; content: string | null; tool_calls?: ToolCall[] } }[];
    };
  }
}
