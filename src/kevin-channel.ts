import type { Cron } from "./cron.js";
import { createLogger } from "./logger.js";
import { isRespondableMessage } from "./message-rules.js";

const log = createLogger("kevin-channel");

type Json = Record<string, unknown>;

const object = (value: unknown) => (value && typeof value === "object" && !Array.isArray(value) ? value as Json : undefined);
const string = (value: unknown) => (typeof value === "string" && value ? value : undefined);

/** Something that happened in Kevin's channel that is not a conversational message. */
export type ChannelEvent = {
  kind: string;
  user?: string;
  /** Who did it to them, when Slack says (an inviter). */
  actor?: string;
  /** The message the event is, or is about, when there is one. */
  ts?: string;
  text?: string;
  emoji?: string;
  /** What Kevin's channel did about it automatically, such as a user group addition. */
  outcome?: Record<string, unknown>;
  at: number;
};

/** How long a join or departure reported twice (as a message and as a membership event) counts as one. */
const DUPLICATE_MS = 60_000;

/** Message subtypes that are edits, deletions, or thread bookkeeping rather than happenings. */
const NOT_EVENTS = new Set(["message_changed", "message_deleted", "message_replied", "thread_broadcast", "tombstone"]);

/** Which channel a huddle room belongs to; Slack lists it in a few places. */
const roomChannel = (event: Json) => {
  const room = object(event.room);
  const channels = Array.isArray(room?.channels) ? room.channels : [];
  return string(event.channel_id) ?? string(event.channel) ?? string(room?.channel) ?? string(channels[0]);
};

/**
 * A gateway event as something that happened in `channel`, or undefined when
 * it happened elsewhere, is Kevin's own doing, or is ordinary conversation
 * (those go through the normal reply path).
 */
export const channelEvent = (event: Json, channel: string, kevinId: string, now = Date.now()): ChannelEvent | undefined => {
  const type = string(event.type);
  if (type === "message") {
    const subtype = string(event.subtype);
    if (event.channel !== channel || !subtype || event.hidden || NOT_EVENTS.has(subtype) || isRespondableMessage({ subtype })) return undefined;
    const user = string(event.user) ?? string(object(event.message)?.user);
    if (user === kevinId) return undefined;
    return { kind: subtype, user, ts: string(event.ts), text: string(event.text), at: now };
  }
  // Slack reports membership both as these events and as channel_join/channel_leave messages; removals sometimes only as the event.
  if (type === "member_joined_channel" || type === "member_left_channel") {
    if (event.channel !== channel || event.user === kevinId) return undefined;
    const actor = string(event.inviter);
    return { kind: type === "member_joined_channel" ? "channel_join" : "channel_leave", user: string(event.user), ...(actor ? { actor } : {}), at: now };
  }
  if (type === "reaction_added" || type === "reaction_removed") {
    const item = object(event.item);
    if (item?.channel !== channel || event.user === kevinId) return undefined;
    return { kind: type, user: string(event.user), ts: string(item.ts), emoji: string(event.reaction), at: now };
  }
  if (type === "sh_room_join" || type === "sh_room_leave") {
    if (roomChannel(event) !== channel || event.user === kevinId) return undefined;
    return { kind: type === "sh_room_join" ? "huddle_joined" : "huddle_left", user: string(event.user), at: now };
  }
  return undefined;
};

export type KevinChannelOptions = {
  channel: string;
  kevinId: string;
  /** When Kevin considers posting on His own. */
  schedule: Cron;
  /** Chance that a scheduled moment becomes a post. */
  chance: number;
  /** A post waits up to this long past its scheduled minute, so it does not land on the dot. */
  jitterMs: number;
  /** Quiet after the last event before Kevin looks at a batch. */
  debounceMs?: number;
  /** The longest a batch waits however busy the channel is. */
  maxWaitMs?: number;
  /** Most events handed over at once; older ones are counted, not listed. */
  maxBatch?: number;
  random?: () => number;
  /** Kevin writes something of His own. */
  muse(): Promise<void>;
  /** Runs when someone joins the channel, before Kevin looks; what it returns is shown to Him with the join. */
  onJoin?(user: string): Promise<Record<string, unknown> | undefined>;
  /** Kevin looks at what just happened. */
  observe(events: ChannelEvent[], omitted: number): Promise<void>;
};

/**
 * Kevin's personal channel: He posts there on a schedule, at random, and
 * keeps watch over everything that happens in it.
 */
export class KevinChannel {
  private ticker?: NodeJS.Timeout;
  private pendingPost?: NodeJS.Timeout;
  private posting = false;
  private events: ChannelEvent[] = [];
  private omitted = 0;
  private flushTimer?: NodeJS.Timeout;
  private firstAt = 0;
  private observing = false;
  private stopped = false;
  private random: () => number;
  /** Recent joins and departures, so the second report of one fills in the first instead of counting twice. */
  private membership = new Map<string, ChannelEvent>();

  constructor(private options: KevinChannelOptions) {
    this.random = options.random ?? Math.random;
  }

  get channel() {
    return this.options.channel;
  }

  start() {
    this.stopped = false;
    this.scheduleTick();
    log.info("Watching Kevin's channel", { channel: this.channel, schedule: this.options.schedule.source, chance: this.options.chance });
  }

  stop() {
    this.stopped = true;
    clearTimeout(this.ticker);
    clearTimeout(this.pendingPost);
    clearTimeout(this.flushTimer);
  }

  /** Feeds a gateway event; anything that happened in the channel is queued for Kevin. */
  handleEvent(event: Json) {
    const happened = channelEvent(event, this.channel, this.options.kevinId);
    if (!happened || this.duplicate(happened)) return;
    if (happened.kind !== "channel_join" || !happened.user || !this.options.onJoin) {
      this.note(happened);
      return;
    }
    void this.options.onJoin(happened.user)
      .then((outcome) => outcome && (happened.outcome = outcome))
      .catch((error) => {
        log.failure("Handling a join failed", error, { channel: this.channel, user: happened.user });
        happened.outcome = { ok: false, error: error instanceof Error ? error.message : String(error) };
      })
      .finally(() => this.note(happened));
  }

  /** A join or departure already reported: merge what the second report adds (the message ts, the inviter). */
  private duplicate(event: ChannelEvent) {
    if ((event.kind !== "channel_join" && event.kind !== "channel_leave") || !event.user) return false;
    for (const [key, seen] of this.membership) if (event.at - seen.at > DUPLICATE_MS) this.membership.delete(key);
    const key = `${event.kind}:${event.user}`;
    const seen = this.membership.get(key);
    if (!seen) {
      // Leaving and coming back (or the reverse) is a new event, not a repeat.
      this.membership.delete(`${event.kind === "channel_join" ? "channel_leave" : "channel_join"}:${event.user}`);
      this.membership.set(key, event);
      return false;
    }
    seen.ts ??= event.ts;
    seen.text ??= event.text;
    seen.actor ??= event.actor;
    return true;
  }

  note(event: ChannelEvent) {
    if (this.stopped) return;
    const max = this.options.maxBatch ?? 20;
    if (!this.events.length) this.firstAt = Date.now();
    this.events.push(event);
    if (this.events.length > max) {
      this.events.shift();
      this.omitted++;
    }
    log.debug("Channel event noted", { channel: this.channel, kind: event.kind, user: event.user, pending: this.events.length });
    this.armFlush();
  }

  /** Runs the scheduled-post decision for a minute; exposed for tests. */
  tick(now = new Date()) {
    if (!this.options.schedule.matches(now) || this.posting || this.pendingPost) return;
    const roll = this.random();
    if (roll >= this.options.chance) {
      log.debug("Scheduled moment passed without a post", { channel: this.channel, roll: Math.round(roll * 100) / 100, chance: this.options.chance });
      return;
    }
    const delay = Math.floor(this.random() * this.options.jitterMs);
    log.info("Kevin will post in His channel", { channel: this.channel, inSeconds: Math.round(delay / 1000) });
    this.pendingPost = setTimeout(() => {
      this.pendingPost = undefined;
      void this.post();
    }, delay);
  }

  private async post() {
    if (this.stopped) return;
    this.posting = true;
    try {
      await this.options.muse();
    } catch (error) {
      log.failure("Kevin's scheduled post failed", error, { channel: this.channel });
    } finally {
      this.posting = false;
    }
  }

  private scheduleTick() {
    if (this.stopped) return;
    // Wake just after each minute starts.
    const wait = 60_000 - (Date.now() % 60_000) + 50;
    this.ticker = setTimeout(() => {
      this.tick();
      this.scheduleTick();
    }, wait);
  }

  private armFlush() {
    clearTimeout(this.flushTimer);
    if (this.observing) return;
    const debounce = this.options.debounceMs ?? 15_000;
    const remaining = Math.max(0, this.firstAt + (this.options.maxWaitMs ?? 60_000) - Date.now());
    this.flushTimer = setTimeout(() => void this.flush(), Math.min(debounce, remaining));
  }

  private async flush() {
    if (this.stopped || this.observing || !this.events.length) return;
    const events = this.events;
    const omitted = this.omitted;
    this.events = [];
    this.omitted = 0;
    this.observing = true;
    try {
      await this.options.observe(events, omitted);
    } catch (error) {
      log.failure("Kevin's look at His channel failed", error, { channel: this.channel, events: events.length });
    } finally {
      this.observing = false;
      // Whatever happened meanwhile gets its own look.
      if (this.events.length) {
        this.firstAt = Date.now();
        this.armFlush();
      }
    }
  }
}
