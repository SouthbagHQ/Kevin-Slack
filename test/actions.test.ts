import { describe, expect, it, vi } from "vitest";
import {
  addReaction,
  leaveChannel,
  MAX_REACTIONS_PER_TURN,
  MAX_SENDS_PER_TURN,
  normalizeEmoji,
  parseRespond,
  parseSilence,
  replyThread,
  sendDm,
  sendMessage,
  setPin,
  setStatus,
  TurnBudget,
} from "../src/actions.js";

describe("normalizeEmoji", () => {
  it("accepts bare, colon-wrapped, and skin-toned names", () => {
    expect(normalizeEmoji("eyes")).toBe("eyes");
    expect(normalizeEmoji(":MoneyBag:")).toBe("moneybag");
    expect(normalizeEmoji(":wave::skin-tone-3:")).toBe("wave::skin-tone-3");
    expect(normalizeEmoji("+1")).toBe("+1");
  });

  it("rejects anything that is not an emoji name", () => {
    expect(normalizeEmoji("two words")).toBeUndefined();
    expect(normalizeEmoji("👀")).toBeUndefined();
    expect(normalizeEmoji(3)).toBeUndefined();
  });
});

describe("parseRespond", () => {
  it("builds a reply, reaction, or combined outcome", () => {
    expect(parseRespond({ text: " Denied. " })).toEqual({ ok: true, outcome: { action: "respond", text: "Denied.", reactions: [], broadcast: false } });
    expect(parseRespond({ reactions: [":eyes:", "eyes", "moneybag"] })).toEqual({ ok: true, outcome: { action: "respond", reactions: ["eyes", "moneybag"], broadcast: false } });
    expect(parseRespond({ text: "Noted.", reactions: ["eyes"], in_thread: true, broadcast: true })).toEqual({
      ok: true,
      outcome: { action: "respond", text: "Noted.", reactions: ["eyes"], inThread: true, broadcast: true },
    });
  });

  it("rejects empty or malformed final actions", () => {
    expect(parseRespond({})).toMatchObject({ ok: false });
    expect(parseRespond({ text: "  " })).toMatchObject({ ok: false });
    expect(parseRespond({ reactions: ["not an emoji"] })).toMatchObject({ ok: false });
    expect(parseRespond({ reactions: ["a", "b", "c", "d"] })).toMatchObject({ ok: false });
    expect(parseRespond({ reactions: "eyes" })).toMatchObject({ ok: false });
    expect(parseRespond({ text: "x", in_thread: "yes" })).toMatchObject({ ok: false });
    expect(parseRespond({ text: "x", in_thread: false, broadcast: true })).toMatchObject({ ok: false });
    expect(parseRespond({ reactions: ["eyes"], broadcast: true })).toMatchObject({ ok: false });
  });

  it("records a reason for silence", () => {
    expect(parseSilence({ reason: " unrelated " })).toEqual({ ok: true, outcome: { action: "silent", reason: "unrelated" } });
    expect(parseSilence({})).toEqual({ ok: true, outcome: { action: "silent", reason: "unspecified" } });
  });
});

describe("replyThread", () => {
  it("replies where the conversation is unless told otherwise", () => {
    expect(replyThread({ ts: "1.1" })).toBeUndefined();
    expect(replyThread({ ts: "1.2", thread_ts: "1.1" })).toBe("1.1");
    expect(replyThread({ ts: "1.1" }, true)).toBe("1.1");
    expect(replyThread({ ts: "1.2", thread_ts: "1.1" }, true)).toBe("1.1");
    expect(replyThread({ ts: "1.2", thread_ts: "1.1" }, false)).toBeUndefined();
  });
});

describe("addReaction", () => {
  it("validates arguments and stops at the per-turn cap", async () => {
    const react = vi.fn(async () => undefined);
    const budget = new TurnBudget();
    expect(await addReaction(react, budget, "bad", "1.1", "eyes")).toMatchObject({ ok: false });
    expect(await addReaction(react, budget, "C1", "nope", "eyes")).toMatchObject({ ok: false });
    for (let i = 0; i < MAX_REACTIONS_PER_TURN; i++) expect(await addReaction(react, budget, "C1", "1.1", ":eyes:")).toMatchObject({ ok: true, emoji: "eyes" });
    expect(await addReaction(react, budget, "C1", "1.1", "eyes")).toMatchObject({ ok: false });
    expect(react).toHaveBeenCalledTimes(MAX_REACTIONS_PER_TURN);
    expect(react).toHaveBeenCalledWith("C1", "1.1", "eyes");
  });
});

describe("sendMessage and sendDm", () => {
  it("posts anywhere Kevin names and shares one send budget per turn", async () => {
    const post = vi.fn(async () => ({ ts: "9.9" }));
    const openDm = vi.fn(async () => "D1");
    const budget = new TurnBudget();

    expect(await sendMessage(post, budget, "#general", "hi", undefined, undefined)).toMatchObject({ ok: false });
    expect(await sendMessage(post, budget, "C1", "  ", undefined, undefined)).toMatchObject({ ok: false });
    expect(await sendMessage(post, budget, "C1", "hi", undefined, true)).toMatchObject({ ok: false });
    expect(await sendMessage(post, budget, "C1", "hi", "1.1", true)).toEqual({ ok: true, channel: "C1", ts: "9.9", thread_ts: "1.1" });
    expect(post).toHaveBeenLastCalledWith("C1", "hi", "1.1", true);

    expect(await sendDm(openDm, post, budget, "UKEVIN", "UKEVIN", "hi")).toMatchObject({ ok: false });
    expect(await sendDm(openDm, post, budget, "UKEVIN", "bob", "hi")).toMatchObject({ ok: false });
    expect(await sendDm(openDm, post, budget, "UKEVIN", "UBOB", "Your fee.")).toEqual({ ok: true, user: "UBOB", channel: "D1", ts: "9.9" });
    expect(post).toHaveBeenLastCalledWith("D1", "Your fee.");

    for (let sent = 2; sent < MAX_SENDS_PER_TURN; sent++) await sendMessage(post, budget, "C1", "hi", undefined, undefined);
    expect(await sendDm(openDm, post, budget, "UKEVIN", "UBOB", "again")).toMatchObject({ ok: false });
    expect(post).toHaveBeenCalledTimes(MAX_SENDS_PER_TURN);
  });
});

describe("setPin", () => {
  it("pins and unpins valid messages only", async () => {
    const pin = vi.fn(async () => undefined);
    expect(await setPin(pin, true, "C1", "bad")).toMatchObject({ ok: false });
    expect(await setPin(pin, true, "C1", "1.1")).toEqual({ ok: true, channel: "C1", ts: "1.1", pinned: true });
    expect(await setPin(pin, false, "C1", "1.1")).toEqual({ ok: true, channel: "C1", ts: "1.1", pinned: false });
    expect(pin).toHaveBeenCalledTimes(2);
  });
});

describe("leaveChannel", () => {
  it("leaves other channels now and the current one after the final action", async () => {
    const leave = vi.fn(async () => undefined);
    const budget = new TurnBudget();
    expect(await leaveChannel(leave, budget, "C1", "D1")).toMatchObject({ ok: false });
    expect(await leaveChannel(leave, budget, "C1", "C2")).toEqual({ ok: true, channel: "C2", left: true });
    expect(leave).toHaveBeenCalledWith("C2");
    expect(await leaveChannel(leave, budget, "C1", "C1")).toMatchObject({ ok: true, channel: "C1" });
    expect(leave).toHaveBeenCalledTimes(1);
    expect([...budget.leaveAfter]).toEqual(["C1"]);
  });
});

describe("setStatus", () => {
  it("sets, expires, and clears Kevin's status", async () => {
    const apply = vi.fn(async () => undefined);
    const now = Date.UTC(2026, 0, 1);
    expect(await setStatus(apply, "In a meeting.", "calendar", 30, now)).toEqual({
      ok: true,
      text: "In a meeting.",
      emoji: ":calendar:",
      expires: "2026-01-01T00:30:00.000Z",
    });
    expect(apply).toHaveBeenLastCalledWith("In a meeting.", ":calendar:", now / 1000 + 1800);
    expect(await setStatus(apply, "", "", undefined, now)).toEqual({ ok: true, text: "", emoji: "" });
    expect(apply).toHaveBeenLastCalledWith("", "", 0);
  });

  it("rejects bad input without touching the status", async () => {
    const apply = vi.fn(async () => undefined);
    expect(await setStatus(apply, "x".repeat(101), undefined, undefined)).toMatchObject({ ok: false });
    expect(await setStatus(apply, "ok", "not emoji", undefined)).toMatchObject({ ok: false });
    expect(await setStatus(apply, "ok", undefined, 0)).toMatchObject({ ok: false });
    expect(await setStatus(apply, "ok", undefined, 1.5)).toMatchObject({ ok: false });
    expect(apply).not.toHaveBeenCalled();
  });
});
