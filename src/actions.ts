import { createLogger, preview } from "./logger.js";

const log = createLogger("actions");

export const MAX_SENDS_PER_TURN = 3;
export const MAX_REACTIONS_PER_TURN = 5;
export const MAX_RESPOND_REACTIONS = 3;
const MAX_STATUS_CHARS = 100;
const MAX_STATUS_MINUTES = 7 * 24 * 60;

export const isConversationId = (value: unknown): value is string => typeof value === "string" && /^[CDG][A-Z0-9]+$/.test(value);
export const isUserId = (value: unknown): value is string => typeof value === "string" && /^[UW][A-Z0-9]+$/.test(value);
export const isMessageTs = (value: unknown): value is string => typeof value === "string" && /^\d+\.\d+$/.test(value);

/** Accepts `thumbsup`, `:thumbsup:`, or `:wave::skin-tone-3:`; returns the bare name Slack expects. */
export const normalizeEmoji = (value: unknown) => {
  if (typeof value !== "string") return undefined;
  const name = value.trim().replace(/^:|:$/g, "").toLowerCase();
  return name.length <= 100 && /^[a-z0-9_+'-]+(?:::skin-tone-[2-6])?$/.test(name) ? name : undefined;
};

type Failure = { ok: false; error: string };

/** Logs and returns a refusal so every rejected action leaves a trace. */
const deny = (action: string, reason: string, error: string, fields: Record<string, unknown> = {}): Failure => {
  log.warn(`${action} denied`, { ...fields, reason });
  return { ok: false, error };
};

/** How a turn ends: a reply and/or reactions on the current message, or deliberate silence. */
export type Outcome =
  | { action: "respond"; text?: string; reactions: string[]; inThread?: boolean; broadcast: boolean }
  | { action: "silent"; reason: string };

export const TERMINAL_TOOLS = new Set(["respond", "stay_silent"]);

export const parseRespond = (args: Record<string, unknown>): { ok: true; outcome: Outcome } | Failure => {
  const action = "respond";
  const text = typeof args.text === "string" ? args.text.trim() : undefined;
  if (args.text !== undefined && typeof args.text !== "string") return deny(action, "invalid-text", "text must be a string.");
  const raw = args.reactions ?? [];
  if (!Array.isArray(raw)) return deny(action, "invalid-reactions", "reactions must be an array of emoji names.");
  const reactions = [...new Set(raw.map(normalizeEmoji))];
  if (reactions.some((name) => !name)) return deny(action, "invalid-reactions", "Every reaction must be an emoji name like thumbsup or :eyes:.", { reactions: preview(raw, 120) });
  if (reactions.length > MAX_RESPOND_REACTIONS) return deny(action, "too-many-reactions", `At most ${MAX_RESPOND_REACTIONS} reactions are allowed.`);
  if (!text && !reactions.length) return deny(action, "empty", "Provide text, reactions, or both; call stay_silent to say nothing.");
  for (const flag of ["in_thread", "broadcast"] as const) {
    if (args[flag] !== undefined && typeof args[flag] !== "boolean") return deny(action, `invalid-${flag}`, `${flag} must be a boolean.`);
  }
  const inThread = args.in_thread as boolean | undefined;
  const broadcast = args.broadcast === true;
  if (broadcast && inThread === false) return deny(action, "broadcast-without-thread", "broadcast only applies to a thread reply.");
  if (broadcast && !text) return deny(action, "broadcast-without-text", "broadcast requires text.");
  return { ok: true, outcome: { action: "respond", ...(text ? { text } : {}), reactions: reactions as string[], ...(inThread === undefined ? {} : { inThread }), broadcast } };
};

export const parseSilence = (args: Record<string, unknown>): { ok: true; outcome: Outcome } => ({
  ok: true,
  outcome: { action: "silent", reason: typeof args.reason === "string" && args.reason.trim() ? args.reason.trim() : "unspecified" },
});

/** Where the respond outcome lands relative to the message being answered. */
export const replyThread = (message: { ts: string; thread_ts?: string }, inThread?: boolean) => {
  if (inThread === false) return undefined;
  if (inThread === true) return message.thread_ts ?? message.ts;
  return message.thread_ts;
};

type Budgeted = "sends" | "reactions";

/** Per-turn caps on side effects, so injected text or a loop cannot mass-message or spam reactions. */
export class TurnBudget {
  private used = { sends: 0, reactions: 0 };
  private limits = { sends: MAX_SENDS_PER_TURN, reactions: MAX_REACTIONS_PER_TURN };
  /** Channels to leave once the final action is delivered. */
  readonly leaveAfter = new Set<string>();

  take(kind: Budgeted) {
    if (this.used[kind] >= this.limits[kind]) return false;
    this.used[kind]++;
    return true;
  }
}

const spend = (budget: TurnBudget, kind: Budgeted, action: string) => budget.take(kind)
  ? undefined
  : deny(action, "turn-budget-spent", `The per-turn limit for ${kind} is spent. Nothing was done.`);

export const addReaction = async (
  react: (channel: string, ts: string, name: string) => Promise<void>,
  budget: TurnBudget,
  channel: unknown,
  ts: unknown,
  emoji: unknown,
) => {
  const action = "add_reaction";
  const name = normalizeEmoji(emoji);
  if (!isConversationId(channel) || !isMessageTs(ts) || !name) {
    return deny(action, "invalid-arguments", "A valid channel ID, message ts, and emoji name are required. No reaction was added.", { channel: preview(channel, 40), ts: preview(ts, 40), emoji: preview(emoji, 40) });
  }
  const spent = spend(budget, "reactions", action);
  if (spent) return spent;
  await react(channel, ts, name);
  log.info(`${action} applied`, { channel, ts, emoji: name });
  return { ok: true, channel, ts, emoji: name };
};

export const sendMessage = async (
  post: (channel: string, text: string, threadTs?: string, broadcast?: boolean) => Promise<{ ts?: string; channel?: string }>,
  budget: TurnBudget,
  channel: unknown,
  text: unknown,
  threadTs: unknown,
  broadcast: unknown,
) => {
  const action = "send_message";
  if (!isConversationId(channel)) return deny(action, "invalid-channel", "A valid Slack conversation ID is required. Nothing was sent.", { channel: preview(channel, 40) });
  if (typeof text !== "string" || !text.trim()) return deny(action, "invalid-text", "Non-empty text is required. Nothing was sent.", { channel });
  if (threadTs !== undefined && !isMessageTs(threadTs)) return deny(action, "invalid-thread", "thread_ts must be a message timestamp. Nothing was sent.", { channel });
  if (broadcast === true && threadTs === undefined) return deny(action, "broadcast-without-thread", "broadcast requires thread_ts. Nothing was sent.", { channel });
  const spent = spend(budget, "sends", action);
  if (spent) return spent;
  const sent = await post(channel, text, threadTs, broadcast === true);
  log.info(`${action} applied`, { channel, thread: threadTs, ts: sent.ts });
  return { ok: true, channel, ts: sent.ts, ...(threadTs ? { thread_ts: threadTs } : {}) };
};

export const sendDm = async (
  openDm: (user: string) => Promise<string>,
  post: (channel: string, text: string) => Promise<{ ts?: string }>,
  budget: TurnBudget,
  kevinId: string,
  user: unknown,
  text: unknown,
) => {
  const action = "send_dm";
  if (!isUserId(user)) return deny(action, "invalid-user", "A valid Slack user ID is required. Nothing was sent.", { user: preview(user, 40) });
  if (user === kevinId) return deny(action, "self-dm", "Kevin does not DM Himself. Nothing was sent.", { user });
  if (typeof text !== "string" || !text.trim()) return deny(action, "invalid-text", "Non-empty text is required. Nothing was sent.", { user });
  const spent = spend(budget, "sends", action);
  if (spent) return spent;
  const channel = await openDm(user);
  const sent = await post(channel, text);
  log.info(`${action} applied`, { user, channel, ts: sent.ts });
  return { ok: true, user, channel, ts: sent.ts };
};

export const setPin = async (
  pin: (channel: string, ts: string) => Promise<void>,
  pinned: boolean,
  channel: unknown,
  ts: unknown,
) => {
  const action = pinned ? "pin_message" : "unpin_message";
  if (!isConversationId(channel) || !isMessageTs(ts)) {
    return deny(action, "invalid-arguments", `A valid channel ID and message ts are required. Nothing was ${pinned ? "pinned" : "unpinned"}.`, { channel: preview(channel, 40), ts: preview(ts, 40) });
  }
  await pin(channel, ts);
  log.info(`${action} applied`, { channel, ts });
  return { ok: true, channel, ts, pinned };
};

/** Leaving the current conversation waits until the final action is posted, or the reply could not be delivered. */
export const leaveChannel = async (
  leave: (channel: string) => Promise<void>,
  budget: TurnBudget,
  currentChannel: string | undefined,
  channel: unknown,
) => {
  const action = "leave_channel";
  if (typeof channel !== "string" || !/^[CG][A-Z0-9]+$/.test(channel)) {
    return deny(action, "invalid-channel", "A valid channel ID is required; direct messages cannot be left. Kevin stayed.", { channel: preview(channel, 40) });
  }
  if (channel === currentChannel) {
    budget.leaveAfter.add(channel);
    log.info(`${action} scheduled after the final action`, { channel });
    return { ok: true, channel, leaving: "after your final action is delivered" };
  }
  await leave(channel);
  log.info(`${action} applied`, { channel });
  return { ok: true, channel, left: true };
};

export const setStatus = async (
  apply: (text: string, emoji: string, expiration: number) => Promise<void>,
  text: unknown,
  emoji: unknown,
  expiresInMinutes: unknown,
  now = Date.now(),
) => {
  const action = "set_status";
  if (typeof text !== "string" || text.length > MAX_STATUS_CHARS) {
    return deny(action, "invalid-text", `Status text of at most ${MAX_STATUS_CHARS} characters is required; use an empty string to clear. Status was not changed.`, { text: preview(text, 120) });
  }
  const name = emoji === undefined || emoji === "" ? "" : normalizeEmoji(emoji);
  if (name === undefined) return deny(action, "invalid-emoji", "status_emoji must be an emoji name like :calendar:. Status was not changed.", { emoji: preview(emoji, 40) });
  if (expiresInMinutes !== undefined && (typeof expiresInMinutes !== "number" || !Number.isInteger(expiresInMinutes) || expiresInMinutes < 1 || expiresInMinutes > MAX_STATUS_MINUTES)) {
    return deny(action, "invalid-expiry", `expires_in_minutes must be a whole number from 1 to ${MAX_STATUS_MINUTES}. Status was not changed.`, { expiresInMinutes });
  }
  const expiration = typeof expiresInMinutes === "number" ? Math.floor(now / 1000) + expiresInMinutes * 60 : 0;
  const statusEmoji = name ? `:${name}:` : "";
  await apply(text.trim(), statusEmoji, expiration);
  log.info(`${action} applied`, { text: preview(text, 100), emoji: statusEmoji, expiration });
  return { ok: true, text: text.trim(), emoji: statusEmoji, ...(expiration ? { expires: new Date(expiration * 1000).toISOString() } : {}) };
};
