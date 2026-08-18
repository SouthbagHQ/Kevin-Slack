export type ToolCall = {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
};

export type Message =
  | { role: "system" | "user"; content: string }
  | { role: "assistant"; content: string | null; tool_calls?: ToolCall[] }
  | { role: "tool"; content: string; tool_call_id: string };

export class OpenRouter {
  constructor(private key: string) {}

  async chat(body: Record<string, unknown>) {
    const response = await fetch("https://openrouter.ai/api/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.key}`,
        "Content-Type": "application/json",
        "X-OpenRouter-Title": "Kevin Slack",
      },
      body: JSON.stringify(body),
    });
    if (!response.ok) throw new Error(`OpenRouter ${response.status}: ${await response.text()}`);
    return (await response.json()) as {
      choices: { finish_reason: string | null; message: { role: "assistant"; content: string | null; tool_calls?: ToolCall[] } }[];
    };
  }
}
