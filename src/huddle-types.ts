export type HuddleEvent =
  | { type: "invited"; channelId: string; callId: string; inviterUserId: string }
  | { type: "member_left"; callId: string; userId: string }
  | { type: "ended"; callId: string };

export type JoinedHuddle = {
  callId: string;
  huddleId: string;
  channelId: string;
  threadTs: string;
  meeting: Record<string, unknown>;
  attendee: Record<string, unknown>;
};

export type ActiveHuddle = { channelId: string; threadTs: string; callId: string };

const object = (value: unknown, name: string) => {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`Slack response is missing ${name}`);
  return value as Record<string, unknown>;
};

const text = (value: unknown, name: string) => {
  if (typeof value !== "string" || !value) throw new Error(`Slack response is missing ${name}`);
  return value;
};

export const normalizeJoinResponse = (raw: unknown): JoinedHuddle => {
  const root = object(raw, "response");
  if (root.ok !== true) throw new Error(`rooms.join failed: ${String(root.error ?? "unknown_error")}`);
  const call = object(root.call, "call");
  const freeWilly = object(call.free_willy, "call.free_willy");
  const canvas = object(root.canvas, "canvas");
  const huddle = object(root.huddle, "huddle");
  const meeting = { ...object(freeWilly.meeting, "meeting") };
  if (meeting.MeetingFeatures === null) delete meeting.MeetingFeatures;
  return {
    callId: text(call.call_id, "call.call_id"),
    huddleId: text(huddle.id, "huddle.id"),
    channelId: text(canvas.thread_channel_id, "canvas.thread_channel_id"),
    threadTs: text(canvas.root_thread_ts, "canvas.root_thread_ts"),
    meeting,
    attendee: object(freeWilly.attendee, "attendee"),
  };
};

export const normalizeHuddleEvent = (raw: unknown): HuddleEvent | undefined => {
  if (!raw || typeof raw !== "object") return;
  const event = raw as Record<string, unknown>;
  if (event.type === "huddle_invite" && typeof event.channel_id === "string" && typeof event.call_id === "string" && typeof event.sender_user_id === "string") {
    return { type: "invited", channelId: event.channel_id, callId: event.call_id, inviterUserId: event.sender_user_id };
  }
  const room = event.room && typeof event.room === "object" ? event.room as Record<string, unknown> : undefined;
  const huddle = event.huddle && typeof event.huddle === "object" ? event.huddle as Record<string, unknown> : undefined;
  const callId = event.call_id ?? room?.call_id ?? room?.id ?? huddle?.id;
  if (event.type === "sh_room_leave" && typeof callId === "string" && typeof event.user === "string") {
    return { type: "member_left", callId, userId: event.user };
  }
  if (event.type === "sh_room_update" && typeof callId === "string" && (huddle?.has_ended || huddle?.date_end)) {
    return { type: "ended", callId };
  }
};

export const activeHuddleFromMessages = (messages: unknown, channelId: string, threadTs?: string): ActiveHuddle | undefined => {
  if (!Array.isArray(messages)) return;
  for (const value of messages) {
    if (!value || typeof value !== "object") continue;
    const message = value as Record<string, unknown>;
    if (message.subtype !== "huddle_thread" || typeof message.ts !== "string" || (threadTs && message.ts !== threadTs)) continue;
    const room = message.room && typeof message.room === "object" ? message.room as Record<string, unknown> : undefined;
    const endedAt = Number(room?.date_end ?? 0);
    if (!room || room.has_ended === true || (Number.isFinite(endedAt) && endedAt > 0) || typeof room.id !== "string") continue;
    return { channelId, threadTs: message.ts, callId: room.id };
  }
};
