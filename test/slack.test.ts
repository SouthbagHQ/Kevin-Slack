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
      messageType: {
        kind: "message",
        visibility: "channel",
        fromBot: false,
        inThread: false,
      },
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

  it("labels ephemeral messages in model context", () => {
    const slack = new Slack("token", "cookie");
    expect(slack.modelMessage({
      channel: "C123",
      ts: "123.456",
      text: "only you",
      bot_id: "B1",
      is_ephemeral: true,
      hidden: true,
    })).toEqual({
      channel: "C123",
      ts: "123.456",
      text: "only you",
      bot_id: "B1",
      messageType: {
        kind: "ephemeral",
        visibility: "ephemeral",
        fromBot: true,
        inThread: false,
        note: "Only visible to Kevin in this channel; not stored in channel history for others",
      },
    });
  });

  it("marks pinned messages in history and refreshes after pinning", async () => {
    const slack = new Slack("token", "cookie");
    vi.spyOn(slack.web.conversations, "history").mockResolvedValue({
      ok: true,
      messages: [
        { ts: "3.0", user: "U1", text: "legacy pin", pinned_to: ["C123"] } as never,
        { ts: "2.0", user: "U1", text: "listed pin" },
        { ts: "1.0", user: "U1", text: "plain" },
      ],
    });
    const list = vi.spyOn(slack.web.pins, "list").mockResolvedValue({ ok: true, items: [{ type: "message", message: { ts: "2.0" } } as never] });
    vi.spyOn(slack.web.pins, "add").mockResolvedValue({ ok: true });
    vi.spyOn(slack.web.users, "info").mockResolvedValue({ ok: true, user: { name: "bob" } });

    const history = await slack.history("C123");
    expect(history.map(({ ts, pinned }) => [ts, pinned ?? false])).toEqual([["3.0", true], ["2.0", true], ["1.0", false]]);
    await slack.history("C123");
    expect(list).toHaveBeenCalledTimes(1);

    await slack.pin("C123", "1.0");
    await slack.history("C123");
    expect(list).toHaveBeenCalledTimes(2);
  });

  it("treats an unavailable pin list as no pins", async () => {
    const slack = new Slack("token", "cookie");
    vi.spyOn(slack.web.conversations, "history").mockResolvedValue({ ok: true, messages: [{ ts: "1.0", user: "U1", text: "hi" }] });
    vi.spyOn(slack.web.pins, "list").mockRejectedValue(new Error("missing_scope"));
    vi.spyOn(slack.web.users, "info").mockResolvedValue({ ok: true, user: { name: "bob" } });
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      expect(await slack.history("C123")).toMatchObject([{ ts: "1.0", text: "hi" }]);
      expect(error).not.toHaveBeenCalled();
    } finally {
      error.mockRestore();
    }
  });

  it("formats every outgoing message and supports thread broadcast", async () => {
    const slack = new Slack("token", "cookie");
    const postMessage = vi.spyOn(slack.web.chat, "postMessage").mockResolvedValue({ ok: true, ts: "5.0" });

    await slack.post("C123", "<!channel> **Fee** applied.", "1.0", true);
    expect(postMessage).toHaveBeenLastCalledWith({
      channel: "C123",
      text: "@\u2060channel *Fee* applied.",
      thread_ts: "1.0",
      reply_broadcast: true,
      unfurl_links: false,
      unfurl_media: false,
    });

    await slack.post("C123", "Top level.");
    expect(postMessage).toHaveBeenLastCalledWith({ channel: "C123", text: "Top level.", unfurl_links: false, unfurl_media: false });

    await expect(slack.post("C123", "   ")).rejects.toThrow(/empty/);
    expect(postMessage).toHaveBeenCalledTimes(2);

    const command = JSON.stringify({ v: 1, query: "__init__ **live** @here", pad: "x".repeat(3_000) });
    await slack.postVerbatim("D1", command);
    expect(postMessage).toHaveBeenLastCalledWith({ channel: "D1", text: command, unfurl_links: false, unfurl_media: false });
  });

  it("returns profiles without contact details and with labeled custom fields", async () => {
    const slack = new Slack("token", "cookie");
    vi.spyOn(slack.web.users.profile, "get").mockResolvedValue({
      ok: true,
      profile: {
        display_name: "Bob",
        real_name: "Bob Smith",
        pronouns: "they/them",
        email: "bob@example.com",
        phone: "555",
        status_text: "Lunch",
        status_emoji: ":sandwich:",
        status_expiration: 1_767_225_600,
        fields: { Xf1: { value: "Treasury", alt: "" }, Xf2: { value: "", alt: "" } },
      },
    });
    vi.spyOn(slack.web.team.profile, "get").mockResolvedValue({ ok: true, profile: { fields: [{ id: "Xf1", label: "Department" }] } });

    const profile = await slack.userProfile("U1");
    expect(profile).toEqual({
      id: "U1",
      displayName: "Bob",
      realName: "Bob Smith",
      pronouns: "they/them",
      title: undefined,
      status: { text: "Lunch", emoji: ":sandwich:", expires: "2026-01-01T00:00:00.000Z" },
      customFields: [{ label: "Department", value: "Treasury" }],
    });
    expect(JSON.stringify(profile)).not.toMatch(/example\.com|555/);
  });

  it("lists user groups without offering a mention", async () => {
    const slack = new Slack("token", "cookie");
    const list = vi.spyOn(slack.web.usergroups, "list").mockResolvedValue({
      ok: true,
      usergroups: [{ id: "S1", handle: "finance", name: "Finance", description: "", user_count: 2, users: ["U1", "U2"] }],
    });
    expect(await slack.userGroups(true)).toEqual([{ id: "S1", handle: "finance", name: "Finance", description: undefined, members: 2, users: ["U1", "U2"] }]);
    expect(list).toHaveBeenCalledWith({ include_users: true, include_count: true });
    expect(await slack.userGroups()).toEqual([{ id: "S1", handle: "finance", name: "Finance", description: undefined, members: 2 }]);
  });
});
