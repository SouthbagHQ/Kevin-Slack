import { afterEach, describe, expect, it, vi } from "vitest";
import { ChatClient, FallbackChatClient, HACKCLUB_AI_BASE, OPENROUTER_BASE, createKevinChat } from "../src/chat.js";

const completion = { choices: [{ finish_reason: "stop", message: { role: "assistant", content: "ok" } }] };

const jsonResponse = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

describe("ChatClient", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("posts chat completions to the configured OpenAI-compatible endpoint", async () => {
    const fetch = vi.fn(async (_url: string, _init?: RequestInit) => jsonResponse(completion));
    vi.stubGlobal("fetch", fetch);

    const client = new ChatClient("hc-key", { baseUrl: HACKCLUB_AI_BASE, label: "Hack Club AI" });
    await expect(client.chat({ model: "z-ai/glm-5.3-flash", messages: [] })).resolves.toEqual(completion);

    expect(fetch).toHaveBeenCalledTimes(1);
    const [url, init] = fetch.mock.calls[0]!;
    expect(url).toBe(`${HACKCLUB_AI_BASE}/chat/completions`);
    expect(init).toMatchObject({
      method: "POST",
      headers: { Authorization: "Bearer hc-key", "Content-Type": "application/json" },
    });
    expect(JSON.parse(String(init?.body))).toEqual({ model: "z-ai/glm-5.3-flash", messages: [] });
  });

  it("fails immediately on non-retryable HTTP errors", async () => {
    const fetch = vi.fn(async () => jsonResponse({ error: "no" }, 400));
    vi.stubGlobal("fetch", fetch);

    const client = new ChatClient("hc-key", { baseUrl: HACKCLUB_AI_BASE, label: "Hack Club AI" });
    await expect(client.chat({ model: "z-ai/glm-5.3-flash" })).rejects.toThrow("Hack Club AI 400");
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});

describe("FallbackChatClient", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("uses Hack Club AI when it succeeds", async () => {
    const fetch = vi.fn(async (url: string) => {
      if (String(url).includes("hackclub")) return jsonResponse(completion);
      throw new Error("OpenRouter should not be called");
    });
    vi.stubGlobal("fetch", fetch);

    const result = await createKevinChat("hc-key", "or-key").chat({ model: "z-ai/glm-5.3-flash", messages: [] });
    expect(result).toEqual(completion);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(fetch.mock.calls[0]![0]).toBe(`${HACKCLUB_AI_BASE}/chat/completions`);
  });

  it("falls back to OpenRouter when Hack Club AI fails", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const fetch = vi.fn(async (url: string, _init?: RequestInit) => {
      if (String(url).includes("hackclub")) return jsonResponse({ error: "down" }, 400);
      return jsonResponse(completion);
    });
    vi.stubGlobal("fetch", fetch);

    const result = await createKevinChat("hc-key", "or-key").chat({ model: "z-ai/glm-5.3-flash", messages: [{ role: "user", content: "hi" }] });
    expect(result).toEqual(completion);

    expect(fetch.mock.calls.map(([url]) => url)).toEqual([
      `${HACKCLUB_AI_BASE}/chat/completions`,
      `${OPENROUTER_BASE}/chat/completions`,
    ]);

    const openRouterInit = fetch.mock.calls.at(-1)![1];
    expect(openRouterInit).toBeDefined();
    expect(openRouterInit!.headers).toMatchObject({
      Authorization: "Bearer or-key",
      "X-OpenRouter-Title": "Kevin Slack",
    });
    expect(JSON.parse(String(openRouterInit!.body))).toEqual({
      model: "z-ai/glm-5.3-flash",
      messages: [{ role: "user", content: "hi" }],
      provider: { data_collection: "deny" },
    });
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("falling back to OpenRouter"));
  });

  it("does not fall back when no fallback client is configured", async () => {
    const fetch = vi.fn(async () => jsonResponse({ error: "down" }, 400));
    vi.stubGlobal("fetch", fetch);

    const primary = new ChatClient("hc-key", { baseUrl: HACKCLUB_AI_BASE, label: "Hack Club AI" });
    await expect(new FallbackChatClient(primary).chat({ model: "z-ai/glm-5.3-flash" })).rejects.toThrow("Hack Club AI 400");
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});
