import { createLogger, preview, timer } from "../logger.js";
import type { ChimeAttendee, ChimeMeeting } from "./chime-link.js";
import { HuddleSession, type JoinedHuddle, type TranscriptLine } from "./session.js";
import { speakable, type SpeechClient } from "./speech.js";

const log = createLogger("huddles");

/** How long after Kevin speaks that anything said counts as a reply to Him. */
const FOLLOW_UP_MS = 25_000;
/** How often Kevin checks who is still in each huddle. */
const PARTICIPANT_POLL_MS = 30_000;
/** Kevin leaves after this many polls in a row find Him alone. */
const ALONE_POLLS = 2;

type Json = Record<string, unknown>;

const object = (value: unknown) => (value && typeof value === "object" && !Array.isArray(value) ? value as Json : undefined);
const string = (value: unknown) => (typeof value === "string" && value ? value : undefined);

/** Slack lists huddle participants as user IDs or as membership objects. */
export const participantIds = (value: unknown) => Array.isArray(value)
  ? value.flatMap((entry) => {
    if (typeof entry === "string") return [entry];
    const user = object(entry)?.user_id;
    return typeof user === "string" ? [user] : [];
  })
  : [];

const chime = (value: unknown) => {
  const freeWilly = object(value);
  const meeting = object(freeWilly?.meeting);
  const attendee = object(freeWilly?.attendee);
  const placement = object(meeting?.MediaPlacement);
  if (!meeting || !attendee || !string(placement?.SignalingUrl) || !string(attendee.AttendeeId) || !string(attendee.JoinToken)) return undefined;
  return { meeting: meeting as unknown as ChimeMeeting, attendee: attendee as unknown as ChimeAttendee };
};

export type HuddleInvite = { channel: string; callId: string; inviter: string; freeWilly?: Json };

/** A `huddle_invite` gateway event, or undefined for anything else. */
export const parseInvite = (event: Json): HuddleInvite | undefined => {
  if (event.type !== "huddle_invite") return undefined;
  const channel = string(event.channel_id);
  const callId = string(event.call_id);
  const inviter = string(event.sender_user_id);
  if (!channel || !callId || !inviter) return undefined;
  return { channel, callId, inviter, freeWilly: object(event.free_willy) };
};

/** What `rooms.join` hands back, read leniently: only the call and its Chime credentials are required. */
export const parseRoomsJoin = (channel: string, body: Json): JoinedHuddle => {
  if (body.ok !== true) throw new Error(`rooms.join failed: ${String(body.error ?? "unknown_error")}`);
  const call = object(body.call);
  const huddle = object(body.huddle);
  const callId = string(call?.call_id) ?? string(huddle?.id);
  const media = chime(call?.free_willy);
  if (!callId || !media) throw new Error("rooms.join returned no call or Chime credentials");
  const meeting = { ...media.meeting } as Json;
  if (meeting.MeetingFeatures === null) delete meeting.MeetingFeatures;
  return {
    channel,
    callId,
    createdBy: string(huddle?.created_by),
    threadTs: string(object(body.canvas)?.root_thread_ts),
    participants: participantIds(huddle?.participants),
    meeting: meeting as unknown as ChimeMeeting,
    attendee: media.attendee,
  };
};

export type ActiveRoom = { callId: string; participants: string[]; createdBy?: string; threadTs?: string; startedAt?: number };

/** A room object from history or `screenhero.rooms.info`, when it is still running. */
export const liveRoom = (room: Json | undefined, threadTs?: string): ActiveRoom | undefined => {
  if (!room) return undefined;
  const endedAt = Number(room.date_end ?? 0);
  if (room.has_ended === true || (Number.isFinite(endedAt) && endedAt > 0)) return undefined;
  const callId = string(room.id) ?? string(room.call_id);
  if (!callId) return undefined;
  const started = Number(room.date_start ?? 0);
  return {
    callId,
    participants: participantIds(room.participants),
    createdBy: string(room.created_by),
    threadTs: threadTs ?? string(room.thread_root_ts),
    ...(started > 0 ? { startedAt: started * 1000 } : {}),
  };
};

/** The newest running huddle in a channel's history, if any; Slack posts a huddle_thread message for each one. */
export const activeRoomFromHistory = (messages: Json[]) => {
  for (const message of messages) {
    if (message.subtype !== "huddle_thread") continue;
    // Only the newest huddle can still be running.
    return liveRoom(object(message.room), string(message.ts));
  }
  return undefined;
};

export type VoiceTrigger = "addressed" | "follow-up" | "direct" | "joined";

export type VoiceTurnInput = {
  channel: string;
  trigger: VoiceTrigger;
  invitedBy?: string;
  participants: { id: string; name: string }[];
  transcript: { speaker: string; speakerId?: string; text: string; secondsAgo: number; kevin?: boolean }[];
  latest?: { speaker: string; speakerId?: string; text: string };
};

export type HuddleSlack = {
  clientApi(method: string, fields: Record<string, string>, timeoutMs?: number): Promise<Json>;
  rawHistory(channel: string, limit?: number): Promise<Json[]>;
  ensureChannelAccess(channel: string): Promise<boolean>;
  displayName(user?: string): Promise<string>;
};

export type HuddlesOptions = {
  region: string;
  maxSessions: number;
  acceptInvites: boolean;
};

/** Mentions of Kevin by name, as a transcription model would spell them. */
export const addressesKevin = (text: string) => /\b(?:kevin|kev)\b/i.test(text);

type TurnState = { running: boolean; pending?: VoiceTrigger; since: number };

/**
 * Every huddle Kevin is in. Accepts invitations, joins on request, keeps
 * track of who is present, hands transcribed speech to Kevin when it is His
 * business, and speaks His answers.
 */
export class Huddles {
  private sessions = new Map<string, HuddleSession>();
  private joining = new Set<string>();
  private turns = new Map<HuddleSession, TurnState>();
  private alone = new Map<HuddleSession, number>();
  private invitedBy = new Map<HuddleSession, string>();
  private poller?: NodeJS.Timeout;
  /** Composes what Kevin says (no text means silence) and whether He then leaves. */
  onVoiceTurn?: (input: VoiceTurnInput) => Promise<{ text?: string; leave?: boolean }>;

  constructor(private slack: HuddleSlack, private speech: SpeechClient, private kevinId: string, private options: HuddlesOptions) {}

  start() {
    this.poller = setInterval(() => void this.pollParticipants(), PARTICIPANT_POLL_MS);
  }

  async stop() {
    clearInterval(this.poller);
    await Promise.all([...this.sessions.values()].map((session) => session.leave()));
  }

  session(channel: string) {
    return [...this.sessions.values()].find((session) => session.channel === channel);
  }

  list() {
    return [...this.sessions.values()];
  }

  /** Gateway events: invitations and huddles ending. */
  handleEvent(event: Json) {
    const invite = parseInvite(event);
    if (invite) {
      void this.acceptInvite(invite);
      return;
    }
    if (event.type === "sh_room_update") {
      const huddle = object(event.huddle);
      const room = object(event.room);
      const callId = string(room?.call_id) ?? string(room?.id) ?? string(huddle?.id);
      const session = callId ? this.sessions.get(callId) : undefined;
      if (session && (huddle?.has_ended || huddle?.date_end || room?.has_ended || room?.date_end)) {
        log.info("Slack reported the huddle ended", { channel: session.channel, call: callId });
        void session.leave();
      }
      if (session && room?.participants) session.participants = participantIds(room.participants);
    }
  }

  /** Whether a huddle is running in a channel, who is in it, and whether Kevin is. */
  async status(channel: string) {
    const session = this.session(channel);
    if (session) {
      return {
        channel,
        inProgress: true,
        kevinPresent: true,
        participants: await this.named(session.participants.filter((id) => id !== this.kevinId)),
        startedBy: session.createdBy,
        kevinJoinedMinutesAgo: Math.round((Date.now() - session.joinedAt) / 60_000),
      };
    }
    let room: ActiveRoom | undefined;
    try {
      room = activeRoomFromHistory(await this.slack.rawHistory(channel, 50));
    } catch (error) {
      return { channel, inProgress: "unknown", error: `Kevin cannot read that conversation: ${error instanceof Error ? error.message : String(error)}` };
    }
    if (!room) return { channel, inProgress: false, kevinPresent: false };
    // History can lag; the room itself has the current participants.
    const current = await this.roomInfo(room.callId).catch(() => undefined);
    if (current === null) return { channel, inProgress: false, kevinPresent: false };
    const live = current ?? room;
    return {
      channel,
      inProgress: true,
      kevinPresent: false,
      participants: await this.named(live.participants.filter((id) => id !== this.kevinId)),
      startedBy: live.createdBy ?? room.createdBy,
      ...(room.startedAt ? { startedMinutesAgo: Math.round((Date.now() - room.startedAt) / 60_000) } : {}),
    };
  }

  /** Joins the channel's running huddle; starts one only when asked to. */
  async join(channel: string, startNew = false, invitedBy?: string) {
    if (this.session(channel)) return { ok: true, alreadyThere: true };
    if (this.joining.has(channel)) return { ok: true, joining: true };
    if (this.sessions.size >= this.options.maxSessions) return { ok: false, error: "too_many_huddles", message: `Kevin is already in ${this.sessions.size} huddles.` };
    if (!startNew) {
      const status = await this.status(channel);
      if (status.inProgress === false) return { ok: false, error: "no_huddle", message: "No huddle is running there. Pass start_new to start one." };
    }
    if (!channel.startsWith("D") && !(await this.slack.ensureChannelAccess(channel).catch(() => false))) {
      return { ok: false, error: "no_channel_access", message: "Kevin is not in that channel and cannot join it. Invite Him to the huddle instead." };
    }
    this.joining.add(channel);
    try {
      const body = await this.slack.clientApi("rooms.join", { channel_id: channel, regions: this.options.region, multidevice: "true" });
      return await this.open(parseRoomsJoin(channel, body), invitedBy);
    } catch (error) {
      log.failure("Joining the huddle failed", error, { channel });
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    } finally {
      this.joining.delete(channel);
    }
  }

  async leave(channel: string) {
    const session = this.session(channel);
    if (!session) return { ok: false, error: "not_in_huddle" };
    await session.leave();
    return { ok: true };
  }

  /** Says something in a huddle Kevin is in, on behalf of a text conversation. */
  async say(channel: string, text: string) {
    const session = this.session(channel);
    if (!session) return { ok: false, error: "not_in_huddle", message: "Kevin is not in a huddle there." };
    const spoken = await this.speakable(text);
    if (!spoken) return { ok: false, error: "empty" };
    session.note({ at: Date.now(), text: spoken, kevin: true, speaker: this.kevinId });
    const samples = await this.speech.synthesize(spoken);
    void session.say(samples);
    return { ok: true, seconds: Math.round(samples.length / 4_800) / 10 };
  }

  /** Live huddle context for a text reply in the huddle's channel. */
  async context(channel: string) {
    const session = this.session(channel);
    if (!session) return undefined;
    return {
      huddleChannel: channel,
      kevinPresent: true,
      participants: await this.named(session.participants.filter((id) => id !== this.kevinId)),
      recentSpeech: await this.lines(session.transcript.slice(-20)),
    };
  }

  /** Accepts an invitation with the credentials it carries, so Kevin need not be in the channel. */
  private async acceptInvite(invite: HuddleInvite) {
    const scope = log.with({ channel: invite.channel, call: invite.callId, inviter: invite.inviter });
    scope.info("Huddle invitation received");
    if (!this.options.acceptInvites) {
      scope.info("Invitation ignored; invites are turned off");
      return;
    }
    if (this.sessions.has(invite.callId) || this.joining.has(invite.channel)) return;
    if (this.sessions.size >= this.options.maxSessions) {
      scope.warn("Invitation declined; already at the huddle limit", { max: this.options.maxSessions });
      await this.decline(invite).catch((error) => scope.failure("Declining the invitation failed", error));
      return;
    }
    const media = chime(invite.freeWilly);
    if (!media) {
      // An invitation without credentials can still be joined the ordinary way when Kevin can see the channel.
      scope.info("Invitation carried no Chime credentials; joining through the channel");
      const result = await this.join(invite.channel, false, invite.inviter);
      if (!result.ok) scope.warn("Could not join the invited huddle", { error: "error" in result ? result.error : undefined });
      return;
    }
    this.joining.add(invite.channel);
    try {
      const room = await this.roomInfo(invite.callId).catch(() => undefined);
      await this.open({
        channel: invite.channel,
        callId: invite.callId,
        createdBy: room?.createdBy,
        threadTs: room?.threadTs,
        participants: room?.participants ?? [invite.inviter],
        meeting: media.meeting,
        attendee: media.attendee,
      }, invite.inviter);
    } catch (error) {
      scope.failure("Joining the invited huddle failed", error);
    } finally {
      this.joining.delete(invite.channel);
    }
  }

  private decline(invite: HuddleInvite) {
    return this.slack.clientApi("rooms.inviteResponse", { response: "decline", channel_id: invite.channel, room_id: invite.callId, _x_reason: "respond-to-huddle-invite" });
  }

  /** The room as Slack has it now; null when it has ended. */
  private async roomInfo(callId: string) {
    const body = await this.slack.clientApi("screenhero.rooms.info", { room: callId, _x_reason: "all-calls-store/conditional-fetch" }, 10_000);
    if (body.ok !== true) throw new Error(`screenhero.rooms.info failed: ${String(body.error ?? "unknown_error")}`);
    return liveRoom(object(body.room)) ?? null;
  }

  private async open(joined: JoinedHuddle, invitedBy?: string) {
    const elapsed = timer();
    const session = new HuddleSession(joined, this.speech, {
      onLine: (current, line) => this.heard(current, line),
      onEnded: (current, reason) => this.ended(current, reason),
    });
    await session.start();
    this.sessions.set(joined.callId, session);
    this.turns.set(session, { running: false, since: Date.now() });
    if (invitedBy) this.invitedBy.set(session, invitedBy);
    log.info("Kevin is in the huddle", { channel: joined.channel, call: joined.callId, participants: joined.participants.length, invitedBy, ms: elapsed() });
    this.trigger(session, "joined");
    return { ok: true, joined: true, participants: joined.participants.filter((id) => id !== this.kevinId).length };
  }

  private ended(session: HuddleSession, reason: string) {
    this.sessions.delete(session.callId);
    this.turns.delete(session);
    this.alone.delete(session);
    this.invitedBy.delete(session);
    log.info("Huddle session closed", { channel: session.channel, call: session.callId, reason });
  }

  private heard(session: HuddleSession, line: TranscriptLine) {
    const others = session.participants.filter((id) => id !== this.kevinId).length;
    if (addressesKevin(line.text)) this.trigger(session, "addressed");
    else if (session.channel.startsWith("D") || others === 1) this.trigger(session, "direct");
    else if (Date.now() - session.lastSpokeAt < FOLLOW_UP_MS) this.trigger(session, "follow-up");
  }

  /** Runs one voice turn at a time per huddle; speech that arrives meanwhile gets the next one. */
  private trigger(session: HuddleSession, trigger: VoiceTrigger) {
    const state = this.turns.get(session);
    if (!state || !this.onVoiceTurn) return;
    if (state.running) {
      if (!state.pending || trigger === "addressed") state.pending = trigger;
      return;
    }
    state.running = true;
    void this.voiceTurn(session, trigger, state).finally(() => {
      state.running = false;
      const next = state.pending;
      state.pending = undefined;
      if (next && this.sessions.has(session.callId)) this.trigger(session, next);
    });
  }

  private async voiceTurn(session: HuddleSession, trigger: VoiceTrigger, state: TurnState) {
    const scope = log.with({ channel: session.channel, call: session.callId, trigger });
    const elapsed = timer();
    // Let whoever is mid-sentence finish before Kevin starts thinking aloud.
    for (let waited = 0; session.someoneTalking && waited < 3_000; waited += 100) await new Promise((resolve) => setTimeout(resolve, 100));
    const recent = session.transcript.slice(-30);
    const latest = [...recent].reverse().find((line) => !line.kevin && line.at >= state.since);
    state.since = Date.now();
    try {
      const transcript = await this.lines(recent);
      const input: VoiceTurnInput = {
        channel: session.channel,
        trigger,
        invitedBy: this.invitedBy.get(session),
        participants: await this.named(session.participants.filter((id) => id !== this.kevinId)),
        transcript,
        ...(latest ? { latest: { speaker: latest.speaker ? await this.slack.displayName(latest.speaker) : "someone", speakerId: latest.speaker, text: latest.text } } : {}),
      };
      const { text, leave } = await this.onVoiceTurn!(input);
      const spoken = text ? await this.speakable(text) : "";
      if (!spoken || !this.sessions.has(session.callId)) scope.info("Kevin stayed quiet in the huddle", { leave, ms: elapsed() });
      else {
        const samples = await this.speech.synthesize(spoken);
        session.note({ at: Date.now(), text: spoken, kevin: true, speaker: this.kevinId });
        scope.info("Kevin spoke in the huddle", { chars: spoken.length, seconds: Math.round(samples.length / 4_800) / 10, text: preview(spoken, 120), leave, ms: elapsed() });
        await session.say(samples);
      }
      if (leave) await session.leave();
    } catch (error) {
      scope.failure("Voice turn failed", error, { ms: elapsed() });
    }
  }

  private async pollParticipants() {
    for (const session of this.sessions.values()) {
      try {
        const room = await this.roomInfo(session.callId);
        if (room === null) {
          log.info("The huddle has ended", { channel: session.channel, call: session.callId });
          void session.leave();
          continue;
        }
        session.participants = room.participants;
        const others = room.participants.filter((id) => id !== this.kevinId).length;
        const polls = others ? 0 : (this.alone.get(session) ?? 0) + 1;
        this.alone.set(session, polls);
        if (polls >= ALONE_POLLS) {
          log.info("Kevin is alone in the huddle; leaving", { channel: session.channel, call: session.callId });
          void session.leave();
        }
      } catch (error) {
        log.debug("Participant check failed", { channel: session.channel, error: error instanceof Error ? error.message : String(error) });
      }
    }
  }

  private async speakable(text: string) {
    const ids = [...new Set([...text.matchAll(/<@([UW][A-Z0-9]+)>/g)].map((match) => match[1]!))];
    const names = new Map(await Promise.all(ids.map(async (id) => [id, await this.slack.displayName(id)] as const)));
    return speakable(text, (id) => names.get(id));
  }

  private named(ids: string[]) {
    return Promise.all([...new Set(ids)].map(async (id) => ({ id, name: await this.slack.displayName(id) })));
  }

  private lines(lines: TranscriptLine[]) {
    const now = Date.now();
    return Promise.all(lines.map(async (line) => ({
      speaker: line.kevin ? "Kevin" : line.speaker ? await this.slack.displayName(line.speaker) : "someone",
      ...(line.speaker && !line.kevin ? { speakerId: line.speaker } : {}),
      text: line.text,
      secondsAgo: Math.round((now - line.at) / 1000),
      ...(line.kevin ? { kevin: true } : {}),
    })));
  }
}
