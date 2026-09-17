import { WebClient } from "@slack/web-api";
import WebSocket from "ws";
import { createLogger, preview, timer } from "./logger.js";
import { describeMessageType, isIgnoredMessage } from "./message-rules.js";

export type SlackMessage = {
  channel: string;
  ts: string;
  text?: string;
  user?: string;
  bot_id?: string;
  subtype?: string;
  thread_ts?: string;
  hidden?: boolean;
  is_ephemeral?: boolean;
  files?: SlackImage[];
  attachments?: { image_url?: string; thumb_url?: string; title?: string }[];
  blocks?: unknown[];
};

type SlackImage = {
  id?: string;
  name?: string;
  title?: string;
  mimetype?: string;
  url_private?: string;
  thumb_480?: string;
  thumb_720?: string;
  thumb_800?: string;
  thumb_1024?: string;
};

export type ViewedImage = { id: string; name?: string; url: string };
type ImageSource = { id: string; name?: string; url?: string; fileId?: string };

const log = createLogger("slack");
const gatewayLog = log.child("gateway");
const apiLog = log.child("api");

/** Identifying fields of a message, safe to log without its text. */
export const messageRef = (message: SlackMessage) => ({
  channel: message.channel,
  ts: message.ts,
  thread: message.thread_ts,
  user: message.user ?? message.bot_id,
  subtype: message.subtype,
  chars: message.text?.length ?? 0,
});

export class Slack {
  readonly web: WebClient;
  private names = new Map<string, Promise<string>>();
  private images = new Map<string, ImageSource>();
  private socket?: WebSocket;
  private ping?: NodeJS.Timeout;
  private reconnect?: NodeJS.Timeout;
  private outgoingId = 0;
  private gateway?: string;
  private stopped = false;
  private connections = 0;
  private events = 0;
  private handler?: (message: SlackMessage) => Promise<void>;

  constructor(private token: string, private cookie: string, private cookieS?: string) {
    this.web = new WebClient(token, { headers: { Cookie: this.cookieHeader() } });
    log.debug("Slack client created", { hasSessionCookie: Boolean(cookieS) });
  }

  async identity() {
    const result = await apiLog.track("auth.test", () => this.web.auth.test());
    if (!result.user_id) throw new Error("Slack auth.test returned no user_id");
    log.info("Slack identity resolved", { userId: result.user_id, team: result.team, teamId: result.team_id, url: result.url });
    return { userId: result.user_id, team: result.team };
  }

  onMessage(handler: (message: SlackMessage) => Promise<void>) {
    this.handler = handler;
  }

  async start() {
    this.stopped = false;
    log.info("Starting Slack gateway listener");
    this.gateway ??= await this.gatewayUrl();
    await this.connect();
  }

  async stop() {
    this.stopped = true;
    log.info("Stopping Slack gateway listener", { connections: this.connections, events: this.events });
    clearInterval(this.ping);
    clearTimeout(this.reconnect);
    this.socket?.close();
  }

  async history(channel: string, limit = 20) {
    const result = await apiLog.track(
      "conversations.history",
      () => this.web.conversations.history({ channel, limit: Math.min(limit, 100) }),
      { channel, limit: Math.min(limit, 100) },
      (response) => ({ messages: response.messages?.length ?? 0 }),
    );
    return this.format((result.messages ?? []) as SlackMessage[], channel);
  }

  async replies(channel: string, ts: string, limit = 30) {
    const result = await apiLog.track(
      "conversations.replies",
      () => this.web.conversations.replies({ channel, ts, limit: Math.min(limit, 100) }),
      { channel, thread: ts, limit: Math.min(limit, 100) },
      (response) => ({ messages: response.messages?.length ?? 0 }),
    );
    return this.format((result.messages ?? []) as SlackMessage[], channel);
  }

  async search(query: string, count = 20) {
    const result = await apiLog.track(
      "search.messages",
      () => this.web.search.messages({ query, count: Math.min(count, 100), sort: "timestamp", sort_dir: "desc" }),
      { query: preview(query, 120), count: Math.min(count, 100) },
      (response) => ({ matches: response.messages?.matches?.length ?? 0, total: response.messages?.total }),
    );
    const all = result.messages?.matches ?? [];
    const matches = all.filter((message) => !isIgnoredMessage(message.text));
    if (matches.length !== all.length) log.debug("Filtered ignored messages from search results", { dropped: all.length - matches.length });
    return Promise.all(matches.map(async (message) => {
      const channel = message.channel?.id ?? message.channel?.name ?? "unknown";
      const images = this.imageReferences(message as SlackMessage, channel);
      return {
        channel,
        ts: message.ts,
        user: message.user ? await this.name(message.user) : message.username,
        text: message.text,
        messageType: describeMessageType(message as SlackMessage),
        ...(images.length ? { images } : {}),
      };
    }));
  }

  modelMessage(message: SlackMessage) {
    const { files: _files, attachments: _attachments, blocks: _blocks, hidden: _hidden, is_ephemeral: _ephemeral, ...plain } = message;
    const images = this.imageReferences(message, message.channel);
    return {
      ...plain,
      messageType: describeMessageType(message),
      ...(images.length ? { images } : {}),
    };
  }

  hasImages(message: SlackMessage) {
    return this.imageReferences(message, message.channel).length > 0;
  }

  async viewImage(id: string): Promise<ViewedImage> {
    const elapsed = timer();
    const source = this.images.get(id);
    if (!source) {
      log.warn("Image lookup failed; unknown or expired ID", { image: id, tracked: this.images.size });
      throw new Error(`Unknown or expired image ID: ${id}`);
    }
    let url = source.url;
    if (!url && source.fileId) {
      const result = await apiLog.track("files.info", () => this.web.files.info({ file: source.fileId! }), { image: id, file: source.fileId });
      const file = result.file as SlackImage | undefined;
      url = file && this.imageUrl(file);
    }
    if (!url) throw new Error(`Image ${id} has no readable URL`);
    const parsed = new URL(url);
    if (parsed.protocol !== "https:") throw new Error(`Image ${id} does not use HTTPS`);
    if (parsed.hostname !== "slack.com" && !parsed.hostname.endsWith(".slack.com")) {
      log.info("Image passed through as an external URL", { image: id, host: parsed.hostname, ms: elapsed() });
      return { id, name: source.name, url };
    }
    const response = await fetch(url, { headers: { Authorization: `Bearer ${this.token}`, Cookie: this.cookieHeader() } });
    if (!response.ok) {
      log.warn("Slack image download failed", { image: id, host: parsed.hostname, status: response.status, ms: elapsed() });
      throw new Error(`Slack image download failed: ${response.status}`);
    }
    const size = Number(response.headers.get("content-length") ?? 0);
    if (size > 10_000_000) throw new Error(`Image ${id} exceeds 10 MB`);
    const mime = response.headers.get("content-type")?.split(";", 1)[0] ?? "";
    if (!new Set(["image/png", "image/jpeg", "image/webp", "image/gif"]).has(mime)) {
      log.warn("Refused an unsupported image type", { image: id, mime: mime || "unknown" });
      throw new Error(`Unsupported image type: ${mime || "unknown"}`);
    }
    const bytes = Buffer.from(await response.arrayBuffer());
    if (bytes.length > 10_000_000) throw new Error(`Image ${id} exceeds 10 MB`);
    log.info("Image loaded into context", { image: id, name: source.name, mime, bytes: bytes.length, ms: elapsed() });
    return { id, name: source.name, url: `data:${mime};base64,${bytes.toString("base64")}` };
  }

  async channelInfo(channel: string) {
    const { channel: info } = await apiLog.track(
      "conversations.info",
      () => this.web.conversations.info({ channel }),
      { channel },
      (response) => ({ name: response.channel?.name, private: response.channel?.is_private, members: response.channel?.num_members }),
    );
    return {
      id: info?.id,
      name: info?.name,
      topic: info?.topic?.value,
      description: info?.purpose?.value,
      purpose: info?.purpose?.value,
      private: info?.is_private,
      directMessage: info?.is_im,
      groupMessage: info?.is_mpim,
      members: info?.num_members,
    };
  }

  async channelManagers(channel: string) {
    const result = await apiLog.track(
      "admin.roles.entity.listAssignments",
      () => this.web.apiCall("admin.roles.entity.listAssignments", { entity_id: channel }) as unknown as Promise<{ role_assignments?: { users?: string[] }[] }>,
      { channel },
    );
    const managers = [...new Set((result.role_assignments ?? []).flatMap(({ users }) => users ?? []))];
    log.debug("Resolved channel managers", { channel, managers: managers.length });
    return managers;
  }

  async userInfo(user: string) {
    const { user: info } = await apiLog.track(
      "users.info",
      () => this.web.users.info({ user }),
      { user },
      (response) => ({ name: response.user?.name, bot: response.user?.is_bot }),
    );
    return {
      id: info?.id,
      username: info?.name,
      realName: info?.real_name,
      displayName: info?.profile?.display_name,
      title: info?.profile?.title,
      bot: info?.is_bot,
      deleted: info?.deleted,
      timezone: info?.tz,
    };
  }

  async members(channel: string, limit = 50) {
    const result = await apiLog.track(
      "conversations.members",
      () => this.web.conversations.members({ channel, limit: Math.min(limit, 100) }),
      { channel, limit: Math.min(limit, 100) },
      (response) => ({ members: response.members?.length ?? 0 }),
    );
    return Promise.all((result.members ?? []).map(async (id) => ({ id, name: await this.name(id) })));
  }

  async kick(channel: string, user: string) {
    await apiLog.track("conversations.kick", () => this.web.conversations.kick({ channel, user }), { channel, user });
    log.info("Removed a member from a channel", { channel, user });
  }

  async setTopic(channel: string, topic: string) {
    await apiLog.track("conversations.setTopic", () => this.web.conversations.setTopic({ channel, topic }), { channel, chars: topic.length });
    log.info("Channel topic changed", { channel, topic: preview(topic, 120) });
  }

  async setDescription(channel: string, description: string) {
    await apiLog.track("conversations.setPurpose", () => this.web.conversations.setPurpose({ channel, purpose: description }), { channel, chars: description.length });
    log.info("Channel description changed", { channel, description: preview(description, 120) });
  }

  async ensureChannelAccess(channel: string) {
    const { channel: info } = await apiLog.track("conversations.info", () => this.web.conversations.info({ channel }), { channel });
    if (info?.is_member) return true;
    if (!info || info.is_private) {
      log.warn("Cannot join channel", { channel, reason: info ? "private" : "not-found" });
      return false;
    }
    await apiLog.track("conversations.join", () => this.web.conversations.join({ channel }), { channel });
    log.info("Joined channel", { channel, name: info.name });
    return true;
  }

  async post(channel: string, text: string, threadTs?: string) {
    const result = await apiLog.track(
      "chat.postMessage",
      () => this.web.chat.postMessage({
        channel,
        text,
        thread_ts: threadTs,
        unfurl_links: false,
        unfurl_media: false,
      }),
      { channel, thread: threadTs, chars: text.length },
      (response) => ({ ts: response.ts }),
    );
    log.info("Posted a message", { channel, thread: threadTs, ts: result.ts, chars: text.length, text: preview(text, 200) });
    return result;
  }

  startTyping(channel: string, threadTs?: string) {
    const send = () => {
      if (this.socket?.readyState === WebSocket.OPEN) this.socket.send(JSON.stringify({ id: ++this.outgoingId, type: "user_typing", channel, thread_ts: threadTs }));
      else log.trace("Typing indicator skipped; gateway not open", { channel, thread: threadTs, readyState: this.socket?.readyState });
    };
    send();
    const timer = setInterval(send, 3_000);
    log.trace("Typing indicator started", { channel, thread: threadTs });
    return () => {
      clearInterval(timer);
      log.trace("Typing indicator stopped", { channel, thread: threadTs });
    };
  }

  private async name(user?: string) {
    if (!user) return "unknown";
    const cached = this.names.get(user);
    if (cached) return cached;
    const resolving = this.web.users.info({ user }).then((result) => {
      const profile = result.user?.profile;
      return profile?.display_name || profile?.real_name || result.user?.name || user;
    }).catch((error) => {
      log.debug("Name lookup failed; falling back to the raw ID", { user, error: error instanceof Error ? error.message : String(error) });
      return user;
    });
    this.names.set(user, resolving);
    log.trace("Name lookup started", { user, cached: this.names.size });
    return resolving;
  }

  private async format(messages: SlackMessage[], channel: string) {
    const visible = messages.filter(({ text }) => !isIgnoredMessage(text));
    if (visible.length !== messages.length) log.trace("Filtered ignored messages from history", { channel, dropped: messages.length - visible.length });
    return Promise.all(visible.map(async (message) => {
      const images = this.imageReferences(message, channel);
      return {
        ts: message.ts,
        authorId: message.user ?? message.bot_id,
        author: await this.name(message.user ?? message.bot_id),
        text: message.text ?? "",
        thread_ts: message.thread_ts,
        messageType: describeMessageType(message),
        ...(images.length ? { images } : {}),
      };
    }));
  }

  private imageReferences(message: SlackMessage, channel: string) {
    const sources: ImageSource[] = [];
    for (const file of message.files ?? []) {
      if (!file.mimetype?.startsWith("image/") || !file.id) continue;
      sources.push({ id: `image_${file.id}`, fileId: file.id, name: file.name ?? file.title, url: this.imageUrl(file) });
    }
    for (const [index, attachment] of (message.attachments ?? []).entries()) {
      const url = attachment.image_url ?? attachment.thumb_url;
      if (url) sources.push({ id: this.attachmentImageId(channel, message.ts, index), name: attachment.title, url });
    }
    for (const [index, block] of (message.blocks ?? []).entries()) {
      if (!block || typeof block !== "object" || (block as { type?: string }).type !== "image") continue;
      const image = block as { image_url?: string; alt_text?: string; slack_file?: { id?: string } };
      const fileId = image.slack_file?.id;
      if (image.image_url || fileId) sources.push({ id: fileId ? `image_${fileId}` : this.attachmentImageId(channel, message.ts, index + (message.attachments?.length ?? 0)), name: image.alt_text, url: image.image_url, fileId });
    }
    const unique = [...new Map(sources.map((source) => [source.id, source])).values()];
    for (const source of unique) {
      this.images.delete(source.id);
      this.images.set(source.id, source);
    }
    let evicted = 0;
    while (this.images.size > 500) {
      this.images.delete(this.images.keys().next().value!);
      evicted++;
    }
    if (evicted) log.debug("Evicted the oldest image references", { evicted, tracked: this.images.size });
    if (unique.length) log.trace("Registered image references", { channel, ts: message.ts, images: unique.map(({ id }) => id), tracked: this.images.size });
    return unique.map(({ id, name }) => ({ id, name }));
  }

  private imageUrl(file: SlackImage) {
    return file.thumb_1024 ?? file.thumb_800 ?? file.thumb_720 ?? file.thumb_480 ?? file.url_private;
  }

  private attachmentImageId(channel: string, ts: string, index: number) {
    return `image_${channel}_${ts.replace(/\W/g, "_")}_${index}`;
  }

  private cookieHeader() {
    return `d=${this.cookie}${this.cookieS ? `; d-s=${this.cookieS}` : ""}`;
  }

  private async gatewayUrl() {
    const elapsed = timer();
    const auth = await apiLog.track("auth.test", () => this.web.auth.test(), { purpose: "gateway" });
    if (!auth.url) throw new Error("Slack auth.test returned no workspace URL");
    const host = new URL(auth.url).hostname;
    const body = new URLSearchParams({ token: this.token, _x_reason: "client.userBoot", _x_mode: "online", _x_sonic: "true", _x_app_name: "client" });
    gatewayLog.debug("Requesting client.userBoot", { host });
    const response = await fetch(`https://${host}/api/client.userBoot`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded", Cookie: this.cookieHeader() },
      body,
    });
    const boot = await response.json() as { ok: boolean; error?: string; workspaces?: { id: string; domain: string }[] };
    if (!boot.ok) {
      gatewayLog.error("client.userBoot rejected the session", { host, status: response.status, error: boot.error });
      throw new Error(`client.userBoot: ${boot.error}`);
    }
    const domain = host.replace(/\.slack\.com$/, "");
    const workspace = boot.workspaces?.find((item) => item.domain === domain) ?? (boot.workspaces?.length === 1 ? boot.workspaces[0] : undefined);
    if (!workspace) {
      gatewayLog.error("client.userBoot returned no matching workspace", { host, domain, workspaces: boot.workspaces?.map(({ domain: name }) => name) });
      throw new Error(`client.userBoot did not return ${domain}`);
    }
    gatewayLog.info("Resolved gateway workspace", { host, domain, workspace: workspace.id, ms: elapsed() });
    const query = new URLSearchParams({ token: this.token, gateway_server: workspace.id, slack_client: "desktop", flannel: "3", lazy_channels: "1" });
    return `wss://wss-primary.slack.com/?${query}`;
  }

  private connect() {
    return new Promise<void>((resolve, reject) => {
      const attempt = ++this.connections;
      const elapsed = timer();
      gatewayLog.debug("Opening gateway socket", { attempt });
      const socket = new WebSocket(this.gateway!, {
        origin: "https://app.slack.com",
        headers: { Cookie: this.cookieHeader(), "User-Agent": "Mozilla/5.0 Chrome/136.0.0.0 Safari/537.36" },
      });
      this.socket = socket;
      let opened = false;
      socket.once("open", () => {
        opened = true;
        this.ping = setInterval(() => socket.readyState === WebSocket.OPEN && socket.send(JSON.stringify({ type: "ping", id: ++this.outgoingId })), 30_000);
        gatewayLog.info("Slack browser gateway connected", { attempt, ms: elapsed() });
        resolve();
      });
      socket.on("message", (data) => {
        try {
          const event = JSON.parse(data.toString()) as SlackMessage & { type?: string };
          if (event.type !== "message") {
            gatewayLog.trace("Gateway event ignored", { type: event.type ?? "unknown", bytes: data.toString().length });
            return;
          }
          this.events++;
          if (!this.handler) {
            gatewayLog.warn("Message event dropped; no handler registered", messageRef(event));
            return;
          }
          gatewayLog.debug("Message event received", { ...messageRef(event), events: this.events });
          void this.handler(event).catch((error) => log.failure("Message handling failed", error, messageRef(event)));
        } catch (error) {
          gatewayLog.failure("Invalid Slack gateway event", error, { bytes: data.toString().length, payload: preview(data.toString(), 200) });
        }
      });
      socket.once("error", (error) => {
        if (!opened) {
          gatewayLog.failure("Gateway connection failed", error, { attempt, ms: elapsed() });
          reject(error);
        } else {
          gatewayLog.failure("Gateway socket error", error, { attempt, events: this.events });
        }
      });
      socket.once("close", (code, reason) => {
        clearInterval(this.ping);
        gatewayLog.warn("Gateway socket closed", {
          attempt,
          code,
          reason: reason.toString() || undefined,
          events: this.events,
          uptimeMs: elapsed(),
          reconnecting: !this.stopped,
        });
        if (!this.stopped) {
          this.reconnect = setTimeout(() => {
            gatewayLog.info("Reconnecting to the Slack gateway", { attempt: this.connections + 1 });
            this.connect().catch((error) => gatewayLog.failure("Slack reconnect failed", error, { attempt: this.connections }));
          }, 2_000);
        }
      });
    });
  }
}
