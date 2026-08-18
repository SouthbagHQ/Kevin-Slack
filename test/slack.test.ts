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

    expect(JSON.parse(send.mock.calls[0]![0]!)).toMatchObject({ type: "typing", channel: "C123", thread_ts: "123.456" });
  });
});
