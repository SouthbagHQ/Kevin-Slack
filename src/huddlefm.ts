import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { createLogger, preview, timer } from "./logger.js";
import type { SlackMessage } from "./slack.js";

/**
 * Kevin's side of the HuddleFM bot API (docs/bot-api.md in ingoau/huddlefm).
 *
 * Commands are JSON DMs to the HuddleFM user. Replies arrive threaded under
 * the command with `replyTo`; events arrive as top-level DMs. Nothing here
 * writes human-facing text: grant outcomes, session endings, and notable
 * changes to Kevin's own picks are handed to `onAnnouncement`, which asks
 * Kevin to write the message.
 */

export const HUDDLEFM_PERMISSIONS = [
  "add",
  "add-bulk",
  "remove-own",
  "manage-queue",
  "skip",
  "pause",
  "volume",
  "configure-settings",
  "clear",
  "end-session",
] as const;
export const HUDDLEFM_EVENTS = ["playback.state", "track", "queue", "volume", "session"] as const;
/** Everything except ending the session, which Kevin must ask for on purpose. */
export const DEFAULT_PERMISSIONS = HUDDLEFM_PERMISSIONS.filter((permission) => permission !== "end-session");

export const HUDDLEFM_COMMANDS = [
  "add",
  "remove",
  "move",
  "shuffle",
  "clear",
  "skip",
  "previous",
  "toggle",
  "pause",
  "resume",
  "seek",
  "volume",
  "settings",
  "end",
  "release_control",
] as const;
export type HuddleFmCommand = (typeof HUDDLEFM_COMMANDS)[number] | "status" | "search";

/** The fields each command may carry; anything else a model supplies is dropped. */
const COMMAND_FIELDS: Record<HuddleFmCommand, readonly string[]> = {
  status: [],
  search: ["query"],
  add: ["reference"],
  remove: ["trackId"],
  move: ["trackId", "direction", "playNext", "position"],
  shuffle: [],
  clear: [],
  skip: [],
  previous: [],
  toggle: [],
  pause: [],
  resume: [],
  seek: ["seconds"],
  volume: ["percent"],
  settings: ["displayMode", "autoplay", "loopMode", "transitionMode", "duckingMode", "anchorEnabled"],
  end: [],
  release_control: [],
};

export type HuddleFmReply = { v: 1; ok: boolean; type?: string; error?: string; message?: string; replyTo?: string; [key: string]: unknown };
export type HuddleFmEvent = { v: 1; type: "event"; channel: string; event: string; payload?: Record<string, unknown> };

/** Where Kevin was asked, so outcomes are reported back into the same conversation. */
export type Origin = { channel: string; thread_ts?: string; requester?: string; request?: string };

type Grant = {
  channel: string;
  state: "pending" | "granted";
  permissions: string[];
  events: string[];
  requestTs: string;
  origin: Origin;
  requestedAt: number;
  grantedAt?: number;
  /** Asked again on Kevin's own initiative after HuddleFM restarted. */
  renewal?: boolean;
};

type Activity = { at: string; event: string; title?: string; artist?: string; by?: string; detail?: Record<string, unknown> };

export type Announcement = {
  origin: Origin;
  huddleChannel: string;
  event: string;
  detail: Record<string, unknown>;
};

export type HuddleFmTransport = {
  /** Returns the DM channel between Kevin and the HuddleFM user. */
  openDm(user: string): Promise<string>;
  /** Posts a top-level message and returns its timestamp. */
  post(channel: string, text: string): Promise<string | undefined>;
};

export type HuddleFmOptions = {
  replyTimeoutMs?: number;
  immediateReplyMs?: number;
  statusMaxAgeMs?: number;
  rejoinIntervalMs?: number;
  rejoinWindowMs?: number;
  grantTimeoutMs?: number;
  now?: () => number;
};

type Waiter = { resolve: (reply: HuddleFmReply) => void; timer: NodeJS.Timeout };
type Status = { at: number; body: Record<string, unknown> };
type KevinPick = { id: string; channel: string; title?: string; artist?: string; origin: Origin };

const log = createLogger("huddlefm");

const SLACK_SENSITIVE = /[&<>@.:/*_~`|#!]/;

/**
 * JSON that survives a Slack round trip unchanged. Slack escapes `&<>`,
 * links URLs and domains, and formats mentions in message text; the same
 * characters written as `\uXXXX` escapes inside strings are left alone and
 * JSON.parse restores them on the other side.
 */
export const slackSafeJson = (value: unknown) => {
  const json = JSON.stringify(value);
  let out = "";
  let inString = false;
  for (let index = 0; index < json.length; index++) {
    const char = json[index]!;
    if (!inString) {
      if (char === "\"") inString = true;
      out += char;
      continue;
    }
    if (char === "\\") {
      out += char + json[++index];
      continue;
    }
    if (char === "\"") inString = false;
    out += SLACK_SENSITIVE.test(char) ? `\\u${char.charCodeAt(0).toString(16).padStart(4, "0")}` : char;
  }
  return out;
};

/** Undoes Slack's message formatting so HuddleFM's JSON parses as sent. */
export const decodeSlackText = (text: string) => text
  .replace(/<((?:https?|mailto|tel):[^|>]*)(?:\|([^>]*))?>/g, (_match, url: string, label?: string) => label ?? url)
  .replace(/&lt;/g, "<")
  .replace(/&gt;/g, ">")
  .replace(/&amp;/g, "&");

export const parseHuddleFmText = (text: string): Record<string, unknown> | undefined => {
  // Slack always escapes message text, so the decoded form is the one HuddleFM sent.
  for (const candidate of [decodeSlackText(text), text]) {
    try {
      const parsed: unknown = JSON.parse(candidate.trim());
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed) && (parsed as { v?: unknown }).v === 1) return parsed as Record<string, unknown>;
    } catch {
      // Try the raw form next.
    }
  }
  return undefined;
};

/** Only the parts of a status Kevin needs to talk about or act on the session. */
export const summarizeStatus = (status: Record<string, unknown>, queueItems = 20) => {
  const queue = Array.isArray(status.queue) ? status.queue as Record<string, unknown>[] : [];
  return {
    state: status.state,
    nowPlaying: status.nowPlaying ?? null,
    playbackSeconds: typeof status.playbackSeconds === "number" ? Math.round(status.playbackSeconds) : status.playbackSeconds,
    volumePercent: status.volumePercent,
    autoplay: status.autoplay,
    loopMode: status.loopMode,
    queueLength: queue.length,
    queueLimit: status.queueLimit,
    queue: queue.slice(0, queueItems),
    ...(queue.length > queueItems ? { queueOmitted: queue.length - queueItems } : {}),
    kevinCapabilities: status.yourCapabilities,
  };
};

export class HuddleFm {
  onAnnouncement?: (announcement: Announcement) => Promise<void>;

  private grants = new Map<string, Grant>();
  private waiters = new Map<string, Waiter>();
  private early = new Map<string, { at: number; reply: HuddleFmReply }>();
  private statuses = new Map<string, Status>();
  private activity = new Map<string, Activity[]>();
  private picks = new Map<string, KevinPick>();
  private ownChanges = new Map<string, number>();
  private lastSkipNotice = new Map<string, number>();
  private rejoins = new Map<string, { grant: Grant; until: number; timer: NodeJS.Timeout }>();
  private seen = new Set<string>();
  private dm?: Promise<string>;
  private writes = Promise.resolve();
  private readonly options: Required<HuddleFmOptions>;

  constructor(private transport: HuddleFmTransport, readonly userId: string, private file: string, options: HuddleFmOptions = {}) {
    this.options = {
      replyTimeoutMs: 30_000,
      immediateReplyMs: 4_000,
      statusMaxAgeMs: 15_000,
      rejoinIntervalMs: 30_000,
      rejoinWindowMs: 10 * 60_000,
      grantTimeoutMs: 5 * 60_000,
      now: Date.now,
      ...options,
    };
  }

  async load() {
    try {
      const saved = JSON.parse(await readFile(this.file, "utf8")) as { grants?: Grant[] };
      const now = this.options.now();
      for (const grant of saved.grants ?? []) {
        // A pending request HuddleFM has already expired would never be answered.
        if (grant.state === "pending" && now - grant.requestedAt > this.options.grantTimeoutMs + 60_000) continue;
        this.grants.set(grant.channel, grant);
      }
      log.info("Loaded HuddleFM grants", { file: this.file, grants: [...this.grants.values()].map(({ channel, state }) => `${channel}:${state}`) });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        log.failure("Reading HuddleFM state failed", error, { file: this.file });
        throw error;
      }
      log.info("No HuddleFM state file yet", { file: this.file });
    }
    return this;
  }

  stop() {
    for (const { timer: pending } of this.rejoins.values()) clearInterval(pending);
    this.rejoins.clear();
    for (const waiter of this.waiters.values()) clearTimeout(waiter.timer);
  }

  /** A message in Kevin's DM with the HuddleFM user; these are protocol, never conversation. */
  accepts(message: SlackMessage) {
    return Boolean(message.channel?.startsWith("D") && message.user === this.userId);
  }

  async receive(message: SlackMessage) {
    if (!message.ts || message.subtype || this.seen.has(message.ts)) return;
    this.seen.add(message.ts);
    if (this.seen.size > 2_000) this.seen.delete(this.seen.values().next().value!);
    const body = parseHuddleFmText(message.text ?? "");
    if (!body) {
      log.debug("Ignored a non-protocol HuddleFM DM", { ts: message.ts, text: preview(message.text ?? "", 120) });
      return;
    }
    if (body.type === "event" && typeof body.event === "string" && typeof body.channel === "string") {
      await this.handleEvent(body as HuddleFmEvent);
      return;
    }
    const replyTo = typeof body.replyTo === "string" ? body.replyTo : message.thread_ts;
    if (!replyTo) {
      log.debug("HuddleFM reply without a command to match", { ts: message.ts, type: body.type });
      return;
    }
    await this.handleReply(replyTo, body as HuddleFmReply);
  }

  /** Controlled or requested sessions worth mentioning in a conversation in `channel`. */
  sessionsFor(channel: string) {
    const all = [...this.grants.values()];
    if (channel.startsWith("D")) return all.filter((grant) => grant.state === "granted" || grant.origin.channel === channel);
    return all.filter((grant) => grant.channel === channel || grant.origin.channel === channel);
  }

  /** Cached, no network: whether Kevin runs the music for this channel, for the relevance gate. */
  quickContext(channel: string) {
    return this.sessionsFor(channel).map((grant) => {
      const status = this.statuses.get(grant.channel)?.body;
      const nowPlaying = status?.nowPlaying as { title?: unknown; artist?: unknown } | null | undefined;
      return {
        huddleChannel: grant.channel,
        kevinControl: grant.state,
        ...(nowPlaying ? { nowPlaying: { title: nowPlaying.title, artist: nowPlaying.artist } } : {}),
      };
    });
  }

  /** Live session context for a reply: status, queue, and what just happened. */
  async context(channel: string) {
    const sessions = this.sessionsFor(channel);
    return Promise.all(sessions.map(async (grant) => {
      const base = {
        huddleChannel: grant.channel,
        kevinControl: grant.state,
        permissionsRequested: grant.permissions,
        requestedFrom: grant.origin.channel,
      };
      if (grant.state === "pending") return { ...base, note: "Waiting for the huddle host to approve Kevin's control request." };
      const status = await this.freshStatus(grant.channel);
      return {
        ...base,
        ...(status ? summarizeStatus(status.body) : { note: "HuddleFM did not answer a status check." }),
        ...(status && this.options.now() - status.at > this.options.statusMaxAgeMs ? { statusAgeSeconds: Math.round((this.options.now() - status.at) / 1000) } : {}),
        recentActivity: this.activity.get(grant.channel) ?? [],
      };
    }));
  }

  async requestControl(input: { channel: string; permissions?: string[]; origin: Origin }) {
    const permissions = [...new Set(input.permissions?.length ? input.permissions : DEFAULT_PERMISSIONS)];
    const unknown = permissions.filter((permission) => !(HUDDLEFM_PERMISSIONS as readonly string[]).includes(permission));
    if (unknown.length) return { ok: false, error: "unknown_permissions", permissions: unknown };
    if (!/^[CGD][A-Z0-9]+$/.test(input.channel)) return { ok: false, error: "invalid_channel", message: "A Slack channel ID such as C123 is required." };
    const existing = this.grants.get(input.channel);
    if (existing?.state === "granted") return { ok: true, status: "already_granted", huddleChannel: input.channel, permissions: existing.permissions };
    this.cancelRejoin(input.channel);
    return this.sendRequest({ channel: input.channel, permissions, events: [...HUDDLEFM_EVENTS], origin: input.origin });
  }

  async command(type: HuddleFmCommand, fields: Record<string, unknown>, context: { channel?: string; current?: string; origin?: Origin }) {
    const channel = this.resolveChannel(context.channel, context.current);
    if (!channel.ok) return channel;
    const allowed = COMMAND_FIELDS[type];
    const body: Record<string, unknown> = { v: 1, type, channel: channel.channel };
    for (const name of allowed) if (fields[name] !== undefined && fields[name] !== null) body[name] = fields[name];
    if (type === "skip" || type === "previous" || type === "remove") this.ownChanges.set(channel.channel, this.options.now());
    const reply = await this.send(body, this.options.replyTimeoutMs);
    if (!reply) return { ok: false, type, error: "timeout", message: "HuddleFM did not answer in time. The command may or may not have happened." };
    this.afterCommand(channel.channel, type, reply, context.origin);
    const { v: _v, replyTo: _replyTo, ...rest } = reply;
    return { huddleChannel: channel.channel, ...rest };
  }

  private resolveChannel(explicit: string | undefined, current: string | undefined): { ok: true; channel: string } | { ok: false; error: string; message: string } {
    if (explicit) {
      if (this.grants.get(explicit)?.state === "granted") return { ok: true, channel: explicit };
      const byOrigin = [...this.grants.values()].find((grant) => grant.state === "granted" && grant.origin.channel === explicit);
      return { ok: true, channel: byOrigin?.channel ?? explicit };
    }
    const granted = [...this.grants.values()].filter((grant) => grant.state === "granted");
    const match = current ? granted.find((grant) => grant.channel === current) ?? granted.find((grant) => grant.origin.channel === current) : undefined;
    if (match) return { ok: true, channel: match.channel };
    if (granted.length === 1) return { ok: true, channel: granted[0]!.channel };
    if (!granted.length) {
      const pending = [...this.grants.values()].some((grant) => grant.state === "pending");
      return { ok: false, error: pending ? "grant_pending" : "not_granted", message: pending ? "The host has not approved Kevin's control request yet." : "Kevin controls no HuddleFM session. Request control first." };
    }
    return { ok: false, error: "channel_required", message: `Kevin controls several sessions; pass one of: ${granted.map((grant) => grant.channel).join(", ")}.` };
  }

  private afterCommand(channel: string, type: HuddleFmCommand, reply: HuddleFmReply, origin?: Origin) {
    if (!reply.ok && (reply.error === "not_granted" || reply.error === "session_not_found" || reply.error === "session_inactive")) {
      if (this.grants.delete(channel)) {
        log.info("Dropped a HuddleFM grant HuddleFM no longer honours", { channel, error: reply.error });
        void this.save();
      }
      return;
    }
    if (!reply.ok) return;
    if (type === "status") this.statuses.set(channel, { at: this.options.now(), body: reply });
    else this.statuses.delete(channel);
    if (type === "release_control" || type === "end") {
      this.grants.delete(channel);
      void this.save();
    }
    if (type === "add" && origin && Array.isArray(reply.added)) {
      for (const track of reply.added as { id?: unknown; title?: unknown; artist?: unknown }[]) {
        if (typeof track.id !== "string") continue;
        this.picks.set(track.id, { id: track.id, channel, title: String(track.title ?? ""), artist: String(track.artist ?? ""), origin });
      }
      while (this.picks.size > 300) this.picks.delete(this.picks.keys().next().value!);
    }
  }

  private async freshStatus(channel: string) {
    const cached = this.statuses.get(channel);
    if (cached && this.options.now() - cached.at < 3_000) return cached;
    const reply = await this.send({ v: 1, type: "status", channel }, 6_000).catch((error) => {
      log.failure("HuddleFM status check failed", error, { channel });
      return undefined;
    });
    if (reply) this.afterCommand(channel, "status", reply);
    return this.statuses.get(channel) ?? cached;
  }

  private async sendRequest(request: { channel: string; permissions: string[]; events: string[]; origin: Origin; renewal?: boolean }) {
    const elapsed = timer();
    const body = { v: 1, type: "request_control", channel: request.channel, permissions: request.permissions, events: request.events };
    const ts = await this.post(body);
    if (!ts) return { ok: false, error: "send_failed", message: "The request could not be delivered to HuddleFM." };
    this.grants.set(request.channel, {
      channel: request.channel,
      state: "pending",
      permissions: request.permissions,
      events: request.events,
      requestTs: ts,
      origin: request.origin,
      requestedAt: this.options.now(),
      ...(request.renewal ? { renewal: true } : {}),
    });
    await this.save();
    log.info("Requested HuddleFM control", { channel: request.channel, permissions: request.permissions, requestTs: ts });
    // A valid request is only answered once the host decides; an invalid one is refused at once.
    const reply = await this.wait(ts, this.options.immediateReplyMs);
    if (!reply) return { ok: true, status: "pending_host_approval", huddleChannel: request.channel, permissions: request.permissions, note: "The host must approve within five minutes. Kevin will be told the outcome." };
    if (reply.ok && reply.type === "grant_accepted") return { ok: true, status: "granted", huddleChannel: request.channel, ...summarizeStatus(reply) };
    this.dropGrant(request.channel, ts);
    if (reply.ok) return { ok: false, status: reply.type, huddleChannel: request.channel };
    log.info("HuddleFM refused the control request", { channel: request.channel, error: reply.error, ms: elapsed() });
    return { ok: false, huddleChannel: request.channel, error: reply.error, ...(reply.message ? { message: reply.message } : {}) };
  }

  private async send(body: Record<string, unknown>, timeoutMs: number) {
    const ts = await this.post(body);
    if (!ts) return undefined;
    return this.wait(ts, timeoutMs);
  }

  private async post(body: Record<string, unknown>) {
    try {
      this.dm ??= this.transport.openDm(this.userId);
      const channel = await this.dm;
      const ts = await this.transport.post(channel, slackSafeJson(body));
      log.debug("Sent a HuddleFM command", { type: body.type, channel: body.channel, ts });
      return ts;
    } catch (error) {
      this.dm = undefined;
      log.failure("Sending a HuddleFM command failed", error, { type: body.type, channel: body.channel });
      return undefined;
    }
  }

  private wait(ts: string, timeoutMs: number) {
    const early = this.early.get(ts);
    if (early) {
      this.early.delete(ts);
      return Promise.resolve<HuddleFmReply | undefined>(early.reply);
    }
    return new Promise<HuddleFmReply | undefined>((resolve) => {
      const pending = setTimeout(() => {
        this.waiters.delete(ts);
        resolve(undefined);
      }, timeoutMs);
      this.waiters.set(ts, { resolve, timer: pending });
    });
  }

  private async handleReply(replyTo: string, reply: HuddleFmReply) {
    log.debug("HuddleFM reply", { replyTo, type: reply.type, ok: reply.ok, error: reply.error });
    const waiter = this.waiters.get(replyTo);
    if (waiter) {
      clearTimeout(waiter.timer);
      this.waiters.delete(replyTo);
      waiter.resolve(reply);
      // The requester is still being answered directly; no separate announcement.
      if (reply.type === "grant_accepted") await this.grant(replyTo, reply);
      return;
    }
    const grant = [...this.grants.values()].find((item) => item.requestTs === replyTo);
    if (grant && typeof reply.type === "string" && reply.type.startsWith("grant_")) {
      await this.grantOutcome(grant, reply);
      return;
    }
    // The reply outran the post call that is about to wait for it.
    this.early.set(replyTo, { at: this.options.now(), reply });
    for (const [ts, { at }] of this.early) if (this.options.now() - at > 60_000) this.early.delete(ts);
  }

  private async grant(requestTs: string, reply: HuddleFmReply) {
    const grant = [...this.grants.values()].find((item) => item.requestTs === requestTs);
    if (!grant) return;
    grant.state = "granted";
    grant.grantedAt = this.options.now();
    if (Array.isArray(reply.permissions)) grant.permissions = reply.permissions.map(String);
    if ("state" in reply) this.statuses.set(grant.channel, { at: this.options.now(), body: reply });
    await this.save();
    log.info("HuddleFM control granted", { channel: grant.channel, permissions: grant.permissions });
    return grant;
  }

  private async grantOutcome(grant: Grant, reply: HuddleFmReply) {
    log.info("HuddleFM grant outcome", { channel: grant.channel, outcome: reply.type });
    if (reply.type === "grant_accepted") {
      await this.grant(grant.requestTs, reply);
      await this.announce(grant, "grant_accepted", {
        permissions: grant.permissions,
        ...(grant.renewal ? { renewalAfterHuddleFmRestart: true } : {}),
        ...("state" in reply ? { session: summarizeStatus(reply, 10) } : {}),
      });
      return;
    }
    this.dropGrant(grant.channel, grant.requestTs);
    await this.announce(grant, reply.type!, grant.renewal ? { renewalAfterHuddleFmRestart: true } : {});
  }

  private dropGrant(channel: string, requestTs?: string) {
    const grant = this.grants.get(channel);
    if (!grant || (requestTs && grant.requestTs !== requestTs)) return;
    this.grants.delete(channel);
    this.statuses.delete(channel);
    void this.save();
  }

  private async handleEvent(event: HuddleFmEvent) {
    const grant = this.grants.get(event.channel);
    const payload = event.payload ?? {};
    log.debug("HuddleFM event", { channel: event.channel, event: event.event, title: payload.title });
    if (!grant) return;
    this.statuses.delete(event.channel);
    this.record(event.channel, event.event, payload);

    if (event.event === "session.ended") {
      this.dropGrant(event.channel);
      this.activity.delete(event.channel);
      await this.announce(grant, "session.ended", {});
      return;
    }
    if (event.event === "session.suspended") {
      // HuddleFM is restarting; grants do not survive it, so ask again once the session is back.
      this.dropGrant(event.channel);
      this.scheduleRejoin(grant);
      return;
    }
    const id = typeof payload.id === "string" ? payload.id : undefined;
    const pick = id ? this.picks.get(id) : undefined;
    if (!pick) return;
    if (event.event === "track.finished") {
      this.picks.delete(pick.id);
      return;
    }
    if (event.event === "track.failed" || (event.event === "queue.removed" && payload.reason === "failed")) {
      this.picks.delete(pick.id);
      await this.announce({ ...grant, origin: pick.origin }, "kevin_pick_failed", { title: pick.title, artist: pick.artist });
      return;
    }
    if (event.event === "track.skipped" || event.event === "queue.removed") {
      this.picks.delete(pick.id);
      const now = this.options.now();
      if (now - (this.ownChanges.get(event.channel) ?? 0) < 10_000) return;
      // Kevin notices, but a busy huddle should not get a lecture per skip.
      if (now - (this.lastSkipNotice.get(event.channel) ?? 0) < 3 * 60_000) return;
      this.lastSkipNotice.set(event.channel, now);
      await this.announce({ ...grant, origin: pick.origin }, event.event === "track.skipped" ? "kevin_pick_skipped" : "kevin_pick_removed", { title: pick.title, artist: pick.artist });
    }
  }

  private record(channel: string, event: string, payload: Record<string, unknown>) {
    const entries = this.activity.get(channel) ?? [];
    const { id: _id, title, artist, ...detail } = payload;
    entries.push({
      at: new Date(this.options.now()).toISOString(),
      event,
      ...(typeof title === "string" ? { title } : {}),
      ...(typeof artist === "string" ? { artist } : {}),
      ...(typeof payload.id === "string" && this.picks.has(payload.id) ? { by: "Kevin" } : {}),
      ...(Object.keys(detail).length ? { detail } : {}),
    });
    while (entries.length > 12) entries.shift();
    this.activity.set(channel, entries);
  }

  private scheduleRejoin(grant: Grant) {
    this.cancelRejoin(grant.channel);
    const until = this.options.now() + this.options.rejoinWindowMs;
    const attempt = async () => {
      const rejoin = this.rejoins.get(grant.channel);
      if (!rejoin) return;
      if (this.options.now() > rejoin.until) {
        log.info("Gave up re-requesting HuddleFM control", { channel: grant.channel });
        this.cancelRejoin(grant.channel);
        await this.announce(grant, "session.suspended", {});
        return;
      }
      const result = await this.sendRequest({ channel: grant.channel, permissions: grant.permissions, events: grant.events, origin: grant.origin, renewal: true });
      if (result.ok) {
        log.info("Re-requested HuddleFM control after a restart", { channel: grant.channel });
        this.cancelRejoin(grant.channel);
      }
    };
    const interval = setInterval(() => void attempt().catch((error) => log.failure("Re-requesting HuddleFM control failed", error, { channel: grant.channel })), this.options.rejoinIntervalMs);
    interval.unref?.();
    this.rejoins.set(grant.channel, { grant, until, timer: interval });
    log.info("HuddleFM session suspended; will ask for control again", { channel: grant.channel, windowMs: this.options.rejoinWindowMs });
  }

  private cancelRejoin(channel: string) {
    const rejoin = this.rejoins.get(channel);
    if (!rejoin) return;
    clearInterval(rejoin.timer);
    this.rejoins.delete(channel);
  }

  private async announce(grant: Pick<Grant, "channel" | "origin">, event: string, detail: Record<string, unknown>) {
    if (!this.onAnnouncement) return;
    try {
      await this.onAnnouncement({ origin: grant.origin, huddleChannel: grant.channel, event, detail });
    } catch (error) {
      log.failure("HuddleFM announcement failed", error, { channel: grant.channel, event });
    }
  }

  private async save() {
    const write = this.writes.then(async () => {
      await mkdir(dirname(this.file), { recursive: true });
      const temp = `${this.file}.${process.pid}.tmp`;
      await writeFile(temp, JSON.stringify({ grants: [...this.grants.values()] }, null, 2), { mode: 0o600 });
      await rename(temp, this.file);
      log.debug("Wrote HuddleFM state", { file: this.file, grants: this.grants.size });
    });
    // The awaiting caller reports the failure; this keeps the write chain alive.
    this.writes = write.then(() => undefined, (error) => log.warn("HuddleFM state write failed", { file: this.file, error: error instanceof Error ? error.message : String(error) }));
    await write.catch(() => undefined);
  }
}
