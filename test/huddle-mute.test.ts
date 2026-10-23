import { describe, expect, it, vi } from "vitest";
import { Huddles, type HuddleSlack } from "../src/huddle/huddles.js";
import { Listener } from "../src/huddle/listener.js";
import { decodePeerMessage, muteRequest } from "../src/huddle/peer-message.js";
import type { SpeechClient } from "../src/huddle/speech.js";

describe("peer messages", () => {
  it("encodes a mute request the way Slack's descriptor lays it out", () => {
    const bytes = muteRequest("attendee-2", "attendee-kevin");
    expect(decodePeerMessage(bytes)).toEqual({ fromPeerIdString: "attendee-kevin", muteRequest: { peerId: "attendee-2" } });
    // Field 4 (fromPeerIdString) and field 10 (muteRequest), both length-delimited.
    expect([...bytes]).toContain(0x22);
    expect([...bytes]).toContain(0x52);
  });
});

describe("listener mute state", () => {
  it("follows mute changes that carry only a stream ID", () => {
    const listener = new Listener("kevin", () => undefined);
    listener.handleFrame({ type: "AUDIO_STREAM_ID_INFO", audio_stream_id_info: { streams: [{ audio_stream_id: 2, attendee_id: "a2", external_user_id: "T1-U0456DEFG" }] } });
    expect(listener.attendees()).toEqual([{ attendeeId: "a2", slackUserId: "U0456DEFG" }]);
    listener.handleFrame({ type: "AUDIO_STREAM_ID_INFO", audio_stream_id_info: { streams: [{ audio_stream_id: 2, muted: true }] } });
    expect(listener.attendees()).toEqual([{ attendeeId: "a2", slackUserId: "U0456DEFG", muted: true }]);
    listener.handleFrame({ type: "AUDIO_STREAM_ID_INFO", audio_stream_id_info: { streams: [{ audio_stream_id: 2 }] } });
    expect(listener.attendees()).toEqual([]);
  });
});

describe("Huddles.mute", () => {
  const slack: HuddleSlack = {
    clientApi: async () => ({ ok: true }),
    rawHistory: async () => [],
    ensureChannelAccess: async () => true,
    displayName: async (user) => `name-${user}`,
  };
  const setup = (attendees: { attendeeId: string; slackUserId?: string; muted?: boolean }[]) => {
    const huddles = new Huddles(slack, {} as SpeechClient, "UKEVIN", { region: "r", maxSessions: 2, acceptInvites: true });
    const session = {
      channel: "C1",
      callId: "R1",
      participants: ["U1", "U2", "UKEVIN"],
      attendees: () => attendees,
      requestMute: vi.fn((user: string) => {
        const targets = attendees.filter((attendee) => attendee.slackUserId === user);
        for (const target of targets) target.muted = true;
        return { attendees: targets.length, sent: targets.length };
      }),
    };
    (huddles as unknown as { sessions: Map<string, unknown> }).sessions.set("R1", session);
    return { huddles, session };
  };

  it("asks the participant's client to mute and confirms it", async () => {
    const { huddles, session } = setup([{ attendeeId: "a1", slackUserId: "U1", muted: false }]);
    expect(await huddles.mute("C1", "U1")).toEqual({ ok: true, muted: true });
    expect(session.requestMute).toHaveBeenCalledWith("U1");
  });

  it("refuses people who are not there, Kevin, and huddles Kevin is not in", async () => {
    const { huddles, session } = setup([{ attendeeId: "a1", slackUserId: "U1" }]);
    expect(await huddles.mute("C1", "U9")).toMatchObject({ ok: false, error: "not_present" });
    expect(await huddles.mute("C1", "UKEVIN")).toMatchObject({ ok: false, error: "self" });
    expect(await huddles.mute("C2", "U1")).toMatchObject({ ok: false, error: "not_in_huddle" });
    expect(session.requestMute).not.toHaveBeenCalled();
  });

  it("does nothing for someone already muted, and shows mute state in context", async () => {
    const { huddles, session } = setup([{ attendeeId: "a2", slackUserId: "U2", muted: true }]);
    expect(await huddles.mute("C1", "U2")).toEqual({ ok: true, alreadyMuted: true });
    expect(session.requestMute).not.toHaveBeenCalled();
    expect((await huddles.status("C1")).participants).toEqual([{ id: "U1", name: "name-U1" }, { id: "U2", name: "name-U2", muted: true }]);
  });
});
