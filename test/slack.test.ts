import WebSocket from "ws";
import { describe, expect, it, vi } from "vitest";
import { Slack } from "../src/slack.js";

describe("Slack", () => {
  it("sends typing indicators in the current thread", () => {
    const slack = new Slack("token", "cookie");
    const send = vi.fn();
    Object.assign(slack, { socket: { readyState: WebSocket.OPEN, send } });

    const stop = slack.startTyping("C123", "123.456");
    stop();

    expect(JSON.parse(send.mock.calls[0]![0]!)).toEqual({ id: 1, type: "user_typing", channel: "C123", thread_ts: "123.456" });
  });

  it("replaces Slack image files with IDs and loads them only on demand", async () => {
    const slack = new Slack("token", "cookie");
    const message = {
      channel: "C123",
      ts: "123.456",
      text: "look",
      files: [{ id: "F123", name: "receipt.png", mimetype: "image/png", url_private: "https://files.slack.com/receipt.png" }],
    };

    expect(slack.modelMessage(message)).toEqual({
      channel: "C123",
      ts: "123.456",
      text: "look",
      images: [{ id: "image_F123", name: "receipt.png" }],
    });

    const fetch = vi.fn(async () => new Response(Uint8Array.from([1, 2, 3]), { headers: { "content-type": "image/png" } }));
    vi.stubGlobal("fetch", fetch);
    try {
      expect(await slack.viewImage("image_F123")).toEqual({ id: "image_F123", name: "receipt.png", url: "data:image/png;base64,AQID" });
      expect(fetch).toHaveBeenCalledWith("https://files.slack.com/receipt.png", { headers: { Authorization: "Bearer token", Cookie: "d=cookie" } });
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
