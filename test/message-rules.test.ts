import { describe, expect, it } from "vitest";
import { describeMessageType, isBotMessage, isEphemeralMessage, isIgnoredMessage, isMentioned, isRespondableMessage, isStopCommand, shouldClassifyRelevance, shouldConsiderMessage } from "../src/message-rules.js";

describe("message rules", () => {
  it("ignores messages beginning with ##", () => {
    expect(isIgnoredMessage("## quiet")).toBe(true);
    expect(isIgnoredMessage("  ## quiet")).toBe(true);
    expect(isIgnoredMessage("message ## visible")).toBe(false);
  });

  it("recognizes pings and both stop forms", () => {
    expect(isMentioned("hello <@U123>", "U123")).toBe(true);
    expect(isStopCommand("<@U123>!stop", "U123")).toBe(true);
    expect(isStopCommand("<@U123> !stop", "U123")).toBe(true);
    expect(isStopCommand("<@U123> hello", "U123")).toBe(false);
  });

  it("recognizes bot messages", () => {
    expect(isBotMessage({ bot_id: "B123" })).toBe(true);
    expect(isBotMessage({ subtype: "bot_message" })).toBe(true);
    expect(isBotMessage({})).toBe(false);
  });

  it("recognizes ephemeral messages", () => {
    expect(isEphemeralMessage({ is_ephemeral: true })).toBe(true);
    expect(isEphemeralMessage({})).toBe(false);
  });

  it("allows plain messages, file shares, bot messages, and channel metadata changes", () => {
    expect(isRespondableMessage({})).toBe(true);
    expect(isRespondableMessage({ subtype: "file_share" })).toBe(true);
    expect(isRespondableMessage({ subtype: "bot_message" })).toBe(true);
    expect(isRespondableMessage({ subtype: "channel_topic" })).toBe(true);
    expect(isRespondableMessage({ subtype: "channel_purpose" })).toBe(true);
    expect(isRespondableMessage({ subtype: "channel_name" })).toBe(true);
    expect(isRespondableMessage({ subtype: "message_changed" })).toBe(false);
    expect(isRespondableMessage({ subtype: "channel_join" })).toBe(false);
  });

  it("describes message types including ephemeral visibility", () => {
    expect(describeMessageType({})).toEqual({
      kind: "message",
      visibility: "channel",
      fromBot: false,
      inThread: false,
    });
    expect(describeMessageType({ is_ephemeral: true, bot_id: "B1", thread_ts: "1.2" })).toEqual({
      kind: "ephemeral",
      visibility: "ephemeral",
      fromBot: true,
      inThread: true,
      note: "Only visible to Kevin in this channel; not stored in channel history for others",
    });
    expect(describeMessageType({ subtype: "channel_topic" })).toMatchObject({
      kind: "channel_topic",
      visibility: "channel",
      subtype: "channel_topic",
    });
    expect(describeMessageType({ subtype: "file_share" }).kind).toBe("file_share");
    expect(describeMessageType({ bot_id: "B9" }).kind).toBe("bot_message");
  });

  it("never auto-responds from a subscribed thread unless relevance mode is on", () => {
    expect(shouldConsiderMessage({ pinged: false, dm: false, autoMode: false })).toBe(false);
    expect(shouldClassifyRelevance({ pinged: false, dm: false, autoMode: false })).toBe(false);
    expect(shouldConsiderMessage({ pinged: false, dm: false, autoMode: true })).toBe(true);
    expect(shouldClassifyRelevance({ pinged: false, dm: false, autoMode: true })).toBe(true);
    expect(shouldConsiderMessage({ pinged: true, dm: false, autoMode: false })).toBe(true);
    expect(shouldClassifyRelevance({ pinged: true, dm: false, autoMode: false })).toBe(false);
    expect(shouldConsiderMessage({ pinged: false, dm: true, autoMode: false })).toBe(true);
    expect(shouldClassifyRelevance({ pinged: false, dm: true, autoMode: false })).toBe(false);
  });
});
