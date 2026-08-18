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

  private headers() {
    return { Authorization: `Bearer ${this.key}`, "Content-Type": "application/json", "X-OpenRouter-Title": "Kevin Slack" };
  }

  async chat(body: Record<string, unknown>) {
    const response = await fetch("https://openrouter.ai/api/v1/chat/completions", {
      method: "POST",
      headers: this.headers(),
      body: JSON.stringify(body),
    });
    if (!response.ok) throw new Error(`OpenRouter ${response.status}: ${await response.text()}`);
    return (await response.json()) as {
      choices: { finish_reason: string | null; message: { role: "assistant"; content: string | null; tool_calls?: ToolCall[] } }[];
    };
  }

  async transcribe(audio: Buffer, model: string, format = "webm") {
    const response = await fetch("https://openrouter.ai/api/v1/audio/transcriptions", {
      method: "POST",
      headers: this.headers(),
      body: JSON.stringify({ model, input_audio: { data: audio.toString("base64"), format }, language: "en", temperature: 0 }),
    });
    if (!response.ok) throw new Error(`OpenRouter STT ${response.status}: ${await response.text()}`);
    return (await response.json() as { text?: string }).text?.trim() ?? "";
  }

  async speech(input: string, model: string, voice: string) {
    const response = await fetch("https://openrouter.ai/api/v1/audio/speech", {
      method: "POST",
      headers: this.headers(),
      body: JSON.stringify({ model, input, voice, response_format: "mp3" }),
    });
    if (!response.ok) throw new Error(`OpenRouter TTS ${response.status}: ${await response.text()}`);
    return Buffer.from(await response.arrayBuffer());
  }
}
