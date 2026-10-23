import { describe, expect, it, vi } from "vitest";
import { FallbackChatClient, type ChatCompletion } from "../src/chat.js";

const completion: ChatCompletion = { choices: [{ finish_reason: "stop", message: { role: "assistant", content: "ok" } }] };

describe("FallbackChatClient", () => {
  it("falls back, then skips a primary that keeps failing until it cools off", async () => {
    vi.useFakeTimers();
    try {
      const primary = { label: "primary", chat: vi.fn(async () => { throw new Error("down"); }) };
      const fallback = { label: "fallback", chat: vi.fn(async () => completion) };
      const client = new FallbackChatClient(primary as never, fallback as never);
      for (let turn = 0; turn < 4; turn++) expect(await client.chat({})).toBe(completion);
      // Two failures trip the breaker; the next two turns go straight to the fallback.
      expect(primary.chat).toHaveBeenCalledTimes(2);
      expect(fallback.chat).toHaveBeenCalledTimes(4);

      vi.advanceTimersByTime(61_000);
      primary.chat.mockResolvedValueOnce(completion as never);
      expect(await client.chat({})).toBe(completion);
      expect(primary.chat).toHaveBeenCalledTimes(3);
    } finally {
      vi.useRealTimers();
    }
  });

  it("tries the primary when the fallback fails during a cooldown", async () => {
    const primary = { label: "primary", chat: vi.fn(async () => { throw new Error("down"); }) };
    const fallback = { label: "fallback", chat: vi.fn(async () => completion) };
    const client = new FallbackChatClient(primary as never, fallback as never);
    await client.chat({});
    await client.chat({});
    fallback.chat.mockRejectedValueOnce(new Error("also down"));
    primary.chat.mockResolvedValueOnce(completion as never);
    expect(await client.chat({})).toBe(completion);
  });
});
