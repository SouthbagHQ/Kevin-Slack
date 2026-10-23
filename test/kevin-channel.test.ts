import { afterEach, describe, expect, it, vi } from "vitest";
import { parseCron } from "../src/cron.js";
import { channelEvent, KevinChannel, type ChannelEvent } from "../src/kevin-channel.js";

describe("cron", () => {
  const at = (iso: string) => new Date(iso);

  it("matches minutes, ranges, steps, and lists in a time zone", () => {
    const cron = parseCron("17 9-21/4 * * 1-5", "UTC");
    expect(cron.matches(at("2026-10-23T09:17:00Z"))).toBe(true); // Friday
    expect(cron.matches(at("2026-10-23T13:17:00Z"))).toBe(true);
    expect(cron.matches(at("2026-10-23T10:17:00Z"))).toBe(false);
    expect(cron.matches(at("2026-10-24T09:17:00Z"))).toBe(false); // Saturday
    expect(parseCron("0 9 * * *", "Australia/Sydney").matches(at("2026-10-22T22:00:00Z"))).toBe(true);
  });

  it("ORs restricted day-of-month and day-of-week, and treats 7 as Sunday", () => {
    const cron = parseCron("0 0 1 * 7", "UTC");
    expect(cron.matches(at("2026-10-01T00:00:00Z"))).toBe(true); // a Thursday, the 1st
    expect(cron.matches(at("2026-10-25T00:00:00Z"))).toBe(true); // a Sunday
    expect(cron.matches(at("2026-10-26T00:00:00Z"))).toBe(false);
    expect(parseCron("@hourly", "UTC").matches(at("2026-10-26T05:00:00Z"))).toBe(true);
  });

  it("rejects malformed expressions and zones", () => {
    expect(() => parseCron("* * * *")).toThrow(/five fields/);
    expect(() => parseCron("60 * * * *")).toThrow(/out of range/);
    expect(() => parseCron("a * * * *")).toThrow(/Invalid/);
    expect(() => parseCron("* * * * *", "Not/AZone")).toThrow();
  });
});

describe("channelEvent", () => {
  const read = (event: Record<string, unknown>) => channelEvent(event, "CKEVIN", "UKEVIN", 1);

  it("turns joins, departures, pins, huddles, and reactions in the channel into events", () => {
    expect(read({ type: "message", subtype: "channel_join", channel: "CKEVIN", user: "U1", ts: "1.0", text: "<@U1> has joined the channel" }))
      .toEqual({ kind: "channel_join", user: "U1", ts: "1.0", text: "<@U1> has joined the channel", at: 1 });
    expect(read({ type: "message", subtype: "channel_leave", channel: "CKEVIN", user: "U1", ts: "2.0" })).toMatchObject({ kind: "channel_leave" });
    expect(read({ type: "message", subtype: "huddle_thread", channel: "CKEVIN", user: "U1", ts: "3.0" })).toMatchObject({ kind: "huddle_thread" });
    expect(read({ type: "reaction_added", user: "U2", reaction: "eyes", item: { type: "message", channel: "CKEVIN", ts: "1.0" } }))
      .toEqual({ kind: "reaction_added", user: "U2", ts: "1.0", emoji: "eyes", at: 1 });
    expect(read({ type: "sh_room_join", user: "U3", room: { id: "R1", channels: ["CKEVIN"] } })).toMatchObject({ kind: "huddle_joined", user: "U3" });
  });

  it("ignores conversation, edits, other channels, and Kevin's own doing", () => {
    expect(read({ type: "message", channel: "CKEVIN", user: "U1", ts: "1.0", text: "hi" })).toBeUndefined();
    expect(read({ type: "message", subtype: "channel_topic", channel: "CKEVIN", user: "U1", ts: "1.0" })).toBeUndefined();
    expect(read({ type: "message", subtype: "message_changed", channel: "CKEVIN", hidden: true })).toBeUndefined();
    expect(read({ type: "message", subtype: "channel_join", channel: "COTHER", user: "U1", ts: "1.0" })).toBeUndefined();
    expect(read({ type: "message", subtype: "channel_join", channel: "CKEVIN", user: "UKEVIN", ts: "1.0" })).toBeUndefined();
    expect(read({ type: "reaction_added", user: "UKEVIN", reaction: "eyes", item: { channel: "CKEVIN", ts: "1.0" } })).toBeUndefined();
    expect(read({ type: "sh_room_join", user: "U3", room: { id: "R1", channels: ["COTHER"] } })).toBeUndefined();
  });
});

describe("KevinChannel", () => {
  afterEach(() => vi.useRealTimers());

  const make = (overrides: Partial<ConstructorParameters<typeof KevinChannel>[0]> = {}) => {
    const observed: { events: ChannelEvent[]; omitted: number }[] = [];
    const muse = vi.fn(async () => undefined);
    const channel = new KevinChannel({
      channel: "CKEVIN",
      kevinId: "UKEVIN",
      schedule: parseCron("* * * * *", "UTC"),
      chance: 0.5,
      jitterMs: 1_000,
      debounceMs: 100,
      maxWaitMs: 1_000,
      maxBatch: 2,
      muse,
      observe: async (events, omitted) => {
        observed.push({ events, omitted });
      },
      ...overrides,
    });
    return { channel, observed, muse };
  };

  it("posts on a scheduled minute only when the roll comes up, after a jitter", async () => {
    vi.useFakeTimers();
    const rolls = [0.9, 0.1, 0.5];
    const { channel, muse } = make({ random: () => rolls.shift()! });
    channel.tick();
    await vi.advanceTimersByTimeAsync(2_000);
    expect(muse).not.toHaveBeenCalled();
    channel.tick();
    await vi.advanceTimersByTimeAsync(499);
    expect(muse).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(muse).toHaveBeenCalledTimes(1);
  });

  it("batches events after a quiet spell and keeps only the newest", async () => {
    vi.useFakeTimers();
    const { channel, observed } = make();
    for (const ts of ["1", "2", "3"]) channel.handleEvent({ type: "reaction_added", user: "U1", reaction: "eyes", item: { channel: "CKEVIN", ts } });
    await vi.advanceTimersByTimeAsync(100);
    expect(observed).toHaveLength(1);
    expect(observed[0]!.events.map(({ ts }) => ts)).toEqual(["2", "3"]);
    expect(observed[0]!.omitted).toBe(1);
  });

  it("treats a departure reported as a message and as a membership event as one, keeping the message ts", async () => {
    vi.useFakeTimers();
    const { channel, observed } = make();
    channel.handleEvent({ type: "member_left_channel", channel: "CKEVIN", user: "U1" });
    channel.handleEvent({ type: "message", subtype: "channel_leave", channel: "CKEVIN", user: "U1", ts: "4.0" });
    await vi.advanceTimersByTimeAsync(100);
    expect(observed[0]!.events).toHaveLength(1);
    expect(observed[0]!.events[0]).toMatchObject({ kind: "channel_leave", user: "U1", ts: "4.0" });
  });

  it("counts leaving and coming back as separate events, and runs the join hook once per join", async () => {
    vi.useFakeTimers();
    const onJoin = vi.fn(async () => undefined);
    const { channel, observed } = make({ onJoin, maxBatch: 10 });
    channel.handleEvent({ type: "member_joined_channel", channel: "CKEVIN", user: "U1", inviter: "U2" });
    channel.handleEvent({ type: "message", subtype: "channel_join", channel: "CKEVIN", user: "U1", ts: "1.0" });
    channel.handleEvent({ type: "member_left_channel", channel: "CKEVIN", user: "U1" });
    channel.handleEvent({ type: "member_joined_channel", channel: "CKEVIN", user: "U1" });
    await vi.advanceTimersByTimeAsync(100);
    expect(onJoin).toHaveBeenCalledTimes(2);
    expect(observed.flatMap(({ events }) => events).map(({ kind }) => kind).sort()).toEqual(["channel_join", "channel_join", "channel_leave"]);
    expect(observed.flatMap(({ events }) => events).find(({ actor }) => actor)).toMatchObject({ actor: "U2", ts: "1.0" });
  });

  it("runs the join hook and shows Kevin its outcome with the join", async () => {
    vi.useFakeTimers();
    const onJoin = vi.fn(async () => ({ userGroup: "S1", ok: true, added: true }));
    const { channel, observed } = make({ onJoin });
    channel.handleEvent({ type: "message", subtype: "channel_join", channel: "CKEVIN", user: "U1", ts: "1.0" });
    await vi.advanceTimersByTimeAsync(100);
    expect(onJoin).toHaveBeenCalledWith("U1");
    expect(observed[0]!.events[0]).toMatchObject({ kind: "channel_join", user: "U1", outcome: { userGroup: "S1", added: true } });
  });
});
