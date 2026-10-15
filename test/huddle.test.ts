import { describe, expect, it } from "vitest";
import { activeRoomFromHistory, addressesKevin, Huddles, parseInvite, parseRoomsJoin, type HuddleSlack } from "../src/huddle/huddles.js";
import { LISTEN_RATE, Listener, normalizedVolume, slackUserFromExternal, wav, type Utterance } from "../src/huddle/listener.js";
import { parseRtp, rtpPacket } from "../src/huddle/rtp.js";
import { isNoise } from "../src/huddle/session.js";
import { decodeFrame, encodeFrame } from "../src/huddle/signaling.js";
import { pcm16ToFloat48k, speakable, type SpeechClient } from "../src/huddle/speech.js";

const freeWilly = {
  meeting: { MeetingId: "m", MediaPlacement: { SignalingUrl: "wss://signal.example", AudioHostUrl: "audio.example:3478" }, MeetingFeatures: null },
  attendee: { AttendeeId: "a1", JoinToken: "token" },
};

describe("rtp", () => {
  it("reads back what it writes", () => {
    const packet = parseRtp(rtpPacket(111, 7, 960, 42, new Uint8Array([1, 2, 3])));
    expect(packet).toMatchObject({ payloadType: 111, sequence: 7, timestamp: 960, ssrc: 42 });
    expect([...packet!.payload]).toEqual([1, 2, 3]);
  });

  it("skips header extensions and padding", () => {
    const base = rtpPacket(111, 1, 0, 1, new Uint8Array(0));
    const extension = Buffer.from([0xbe, 0xde, 0x00, 0x01, 0x10, 0xff, 0x00, 0x00]);
    const packet = Buffer.concat([base, extension, Buffer.from([9, 9, 0, 2])]);
    packet[0] = 0x80 | 0x10 | 0x20;
    expect([...parseRtp(packet)!.payload]).toEqual([9, 9]);
  });

  it("ignores RTCP", () => {
    const rtcp = Buffer.alloc(28);
    rtcp[0] = 0x80;
    rtcp[1] = 200;
    expect(parseRtp(rtcp)).toBeUndefined();
  });
});

describe("signaling", () => {
  it("round-trips a frame with its type byte", () => {
    const bytes = encodeFrame("JOIN", { join: { protocol_version: 2 } });
    expect(bytes[0]).toBe(0x05);
    expect(decodeFrame(bytes).type).toBe("JOIN");
  });
});

const tone = (ms: number, amplitude: number) => {
  const samples = new Float32Array((LISTEN_RATE * ms) / 1000);
  for (let index = 0; index < samples.length; index++) samples[index] = amplitude * Math.sin((2 * Math.PI * 220 * index) / LISTEN_RATE);
  return samples;
};

describe("listener", () => {
  it("cuts speech into utterances at pauses and credits the loudest attendee", () => {
    const heard: Utterance[] = [];
    const listener = new Listener("kevin", (utterance) => heard.push(utterance));
    listener.handleFrame({ type: "AUDIO_STREAM_ID_INFO", audio_stream_id_info: { streams: [
      { audio_stream_id: 1, attendee_id: "kevin" },
      { audio_stream_id: 2, attendee_id: "a2", external_user_id: "T0123ABCD-U0456DEFG" },
      { audio_stream_id: 3, attendee_id: "a3", external_user_id: "U0999ZZZZ" },
    ] } });
    listener.push(tone(200, 0.001));
    listener.push(tone(600, 0.3));
    listener.handleFrame({ type: "AUDIO_METADATA", audio_metadata: { attendee_states: [{ audio_stream_id: 2, volume: 14 }, { audio_stream_id: 3, volume: 40 }] } });
    listener.push(tone(1000, 0));
    expect(heard).toHaveLength(1);
    expect(heard[0]!.slackUserId).toBe("U0456DEFG");
    expect(heard[0]!.durationMs).toBeGreaterThanOrEqual(600);
    expect(listener.attendees().map(({ slackUserId }) => slackUserId)).toEqual(["U0456DEFG", "U0999ZZZZ"]);
  });

  it("drops blips too short to be speech", () => {
    const heard: Utterance[] = [];
    const listener = new Listener("kevin", (utterance) => heard.push(utterance));
    listener.push(tone(100, 0.3));
    listener.push(tone(1000, 0));
    expect(heard).toHaveLength(0);
  });

  it("ends an utterance when audio stops arriving", () => {
    const heard: Utterance[] = [];
    const listener = new Listener("kevin", (utterance) => heard.push(utterance));
    listener.push(tone(600, 0.3), 1_000);
    listener.tick(1_500);
    expect(heard).toHaveLength(0);
    listener.tick(1_900);
    expect(heard).toHaveLength(1);
  });

  it("maps Chime attenuation onto 0..1", () => {
    expect(normalizedVolume(14)).toBe(1);
    expect(normalizedVolume(42)).toBe(0);
  });

  it("finds Slack user IDs in external IDs", () => {
    expect(slackUserFromExternal("T0U12345X-U0456DEFG")).toBe("U0456DEFG");
    expect(slackUserFromExternal("nothing")).toBeUndefined();
  });

  it("writes a WAV header", () => {
    const file = wav(new Int16Array(160));
    expect(file.subarray(0, 4).toString()).toBe("RIFF");
    expect(file.readUInt32LE(24)).toBe(LISTEN_RATE);
    expect(file.length).toBe(44 + 320);
  });
});

describe("speech", () => {
  it("resamples 24 kHz PCM to 48 kHz", () => {
    const pcm = Buffer.alloc(4);
    pcm.writeInt16LE(16_384, 0);
    pcm.writeInt16LE(16_384, 2);
    const out = pcm16ToFloat48k(pcm, 24_000);
    expect(out).toHaveLength(4);
    expect(out[0]).toBeCloseTo(0.5);
  });

  it("turns mrkdwn into speech", () => {
    expect(speakable("*Noted*, <@U123>. See <https://x.y|the policy> :eyes:\n- Kevin", (id) => (id === "U123" ? "Sam" : undefined))).toBe("Noted, Sam. See the policy");
  });

  it("recognises transcription noise", () => {
    expect(isNoise("Thanks for watching!")).toBe(true);
    expect(isNoise("Kevin, what's the fee?")).toBe(false);
  });
});

describe("huddle protocol", () => {
  it("parses an invitation with its credentials", () => {
    expect(parseInvite({ type: "huddle_invite", channel_id: "C1", call_id: "R1", sender_user_id: "U1", free_willy: freeWilly })).toMatchObject({ channel: "C1", callId: "R1", inviter: "U1" });
    expect(parseInvite({ type: "message" })).toBeUndefined();
  });

  it("reads rooms.join leniently and drops a null MeetingFeatures", () => {
    const joined = parseRoomsJoin("C1", { ok: true, call: { call_id: "R1", free_willy: freeWilly }, huddle: { id: "R1", created_by: "U1", participants: ["U1", { user_id: "U2" }] } });
    expect(joined).toMatchObject({ channel: "C1", callId: "R1", createdBy: "U1", participants: ["U1", "U2"] });
    expect("MeetingFeatures" in joined.meeting).toBe(false);
    expect(() => parseRoomsJoin("C1", { ok: false, error: "not_in_channel" })).toThrow(/not_in_channel/);
  });

  it("finds a running huddle in history, but not an ended one", () => {
    const room = { id: "R1", participants: ["U1"], date_start: 1_700_000_000 };
    expect(activeRoomFromHistory([{ ts: "1.0", text: "hi" }, { ts: "2.0", subtype: "huddle_thread", room }])).toMatchObject({ callId: "R1", threadTs: "2.0" });
    expect(activeRoomFromHistory([{ ts: "3.0", subtype: "huddle_thread", room: { ...room, has_ended: true } }, { ts: "2.0", subtype: "huddle_thread", room }])).toBeUndefined();
  });

  it("hears Kevin's name", () => {
    expect(addressesKevin("hey Kevin, skip this")).toBe(true);
    expect(addressesKevin("kev?")).toBe(true);
    expect(addressesKevin("Kevlar vests")).toBe(false);
  });
});

describe("huddles", () => {
  const slack = (history: Record<string, unknown>[], rooms: Record<string, unknown> = {}): HuddleSlack & { calls: string[] } => {
    const calls: string[] = [];
    return {
      calls,
      clientApi: async (method) => {
        calls.push(method);
        return method === "screenhero.rooms.info" ? { ok: true, room: rooms } : { ok: false, error: "not_in_channel" };
      },
      rawHistory: async () => history,
      ensureChannelAccess: async () => true,
      displayName: async (user) => `name-${user}`,
    };
  };
  const options = { region: "ap-southeast-2", maxSessions: 2, acceptInvites: true };
  const speech = {} as SpeechClient;

  it("reports a running huddle with live participants", async () => {
    const fake = slack([{ ts: "2.0", subtype: "huddle_thread", room: { id: "R1", participants: ["U1"], created_by: "U1" } }], { id: "R1", participants: ["U1", "U2", "UKEVIN"] });
    const status = await new Huddles(fake, speech, "UKEVIN", options).status("C1");
    expect(status).toMatchObject({ inProgress: true, kevinPresent: false, startedBy: "U1", participants: [{ id: "U1", name: "name-U1" }, { id: "U2", name: "name-U2" }] });
  });

  it("reports no huddle when the room has ended since", async () => {
    const fake = slack([{ ts: "2.0", subtype: "huddle_thread", room: { id: "R1", participants: ["U1"] } }], { id: "R1", has_ended: true });
    expect(await new Huddles(fake, speech, "UKEVIN", options).status("C1")).toMatchObject({ inProgress: false });
  });

  it("will not start a huddle unless asked", async () => {
    const fake = slack([]);
    const result = await new Huddles(fake, speech, "UKEVIN", options).join("C1");
    expect(result).toMatchObject({ ok: false, error: "no_huddle" });
    expect(fake.calls).not.toContain("rooms.join");
  });

  it("ignores invitations when they are turned off", async () => {
    const fake = slack([]);
    new Huddles(fake, speech, "UKEVIN", { ...options, acceptInvites: false }).handleEvent({ type: "huddle_invite", channel_id: "C1", call_id: "R1", sender_user_id: "U1", free_willy: freeWilly });
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(fake.calls).toEqual([]);
  });
});
