import { describe, expect, it } from "vitest";
import { activeHuddleFromMessages, normalizeHuddleEvent, normalizeJoinResponse } from "../src/huddle-types.js";

describe("Huddle protocol", () => {
  it("normalizes invitations and audio join credentials", () => {
    expect(normalizeHuddleEvent({ type: "huddle_invite", channel_id: "C1", call_id: "R1", sender_user_id: "U1" }))
      .toEqual({ type: "invited", channelId: "C1", callId: "R1", inviterUserId: "U1" });
    expect(normalizeJoinResponse({
      ok: true,
      call: { call_id: "R1", free_willy: { meeting: { MeetingId: "M1", MeetingFeatures: null }, attendee: { AttendeeId: "A1" } } },
      canvas: { thread_channel_id: "C1", root_thread_ts: "1.0" },
      huddle: { id: "H1" },
    })).toEqual({ callId: "R1", huddleId: "H1", channelId: "C1", threadTs: "1.0", meeting: { MeetingId: "M1" }, attendee: { AttendeeId: "A1" } });
  });

  it("finds only live Huddle roots", () => {
    expect(activeHuddleFromMessages([{ subtype: "huddle_thread", ts: "1.0", room: { id: "R1", has_ended: false } }], "C1"))
      .toEqual({ channelId: "C1", threadTs: "1.0", callId: "R1" });
    expect(activeHuddleFromMessages([{ subtype: "huddle_thread", ts: "1.0", room: { id: "R1", has_ended: true } }], "C1")).toBeUndefined();
  });
});
