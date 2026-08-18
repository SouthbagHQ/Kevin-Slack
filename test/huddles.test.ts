import { describe, expect, it, vi } from "vitest";
import { HuddleManager } from "../src/huddles.js";

describe("HuddleManager", () => {
  it("joins an invitation and declines a competing Huddle", async () => {
    const declineHuddle = vi.fn(async () => undefined);
    const close = vi.fn(async () => undefined);
    const slack = {
      ensureChannelAccess: async () => true,
      joinHuddle: async (channelId: string) => ({ callId: "R1", huddleId: "H1", channelId, threadTs: "1.0", meeting: {}, attendee: {} }),
      declineHuddle,
      activeHuddle: async () => undefined,
    };
    const browser = { join: async () => ({ speak: async () => undefined, close }), stop: async () => undefined };
    const audio = { speech: async () => Buffer.from("audio"), transcribe: async () => "" };
    const manager = new HuddleManager(slack as never, audio as never, browser as never, "U_KEVIN", {
      mediaRegion: "ap-southeast-2", sttModel: "stt", ttsModel: "tts", ttsVoice: "voice",
    });

    await manager.handleEvent({ type: "invited", channelId: "C1", callId: "R1", inviterUserId: "U1" });
    expect((await manager.capabilities({ channel: "C1", ts: "1" })).tools[0]?.function.name).toBe("leave_huddle");
    await manager.handleEvent({ type: "invited", channelId: "C2", callId: "R2", inviterUserId: "U2" });
    expect(declineHuddle).toHaveBeenCalledWith("C2", "R2");
    expect(await manager.runTool("leave_huddle", { channel: "C1", ts: "1" })).toEqual({ ok: true });
    expect(close).toHaveBeenCalledOnce();
  });
});
