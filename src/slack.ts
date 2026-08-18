import { WebClient } from "@slack/web-api";
import WebSocket from "ws";
import { activeHuddleFromMessages, normalizeHuddleEvent, normalizeJoinResponse, type HuddleEvent } from "./huddle-types.js";
import { isIgnoredMessage } from "./message-rules.js";

export type SlackMessage = {
  channel: string;
  ts: string;
  text?: string;
  user?: string;
  bot_id?: string;
  subtype?: string;
  thread_ts?: string;
  hidden?: boolean;
  huddle?: boolean;
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

export class Slack {
  readonly web: WebClient;
  private names = new Map<string, Promise<string>>();
  private images = new Map<string, ImageSource>();
  private socket?: WebSocket;
  private ping?: NodeJS.Timeout;
  private reconnect?: NodeJS.Timeout;
  private outgoingId = 0;
  private gateway?: string;
  private workspaceUrl?: string;
  private stopped = false;
  private handler?: (message: SlackMessage) => Promise<void>;
  private huddleHandler?: (event: HuddleEvent) => Promise<void>;

  constructor(private token: string, private cookie: string, private cookieS?: string) {
    this.web = new WebClient(token, { headers: { Cookie: this.cookieHeader() } });
  }

  async identity() {
    const result = await this.web.auth.test();
    if (!result.user_id) throw new Error("Slack auth.test returned no user_id");
    if (result.url) this.workspaceUrl = result.url;
    return { userId: result.user_id, team: result.team };
  }

  onMessage(handler: (message: SlackMessage) => Promise<void>) {
    this.handler = handler;
  }

  onHuddleEvent(handler: (event: HuddleEvent) => Promise<void>) {
    this.huddleHandler = handler;
  }

  async start() {
    this.stopped = false;
    this.gateway ??= await this.gatewayUrl();
    await this.connect();
  }

  async stop() {
    this.stopped = true;
    clearInterval(this.ping);
    clearTimeout(this.reconnect);
    this.socket?.close();
  }

  async history(channel: string, limit = 20) {
    const result = await this.web.conversations.history({ channel, limit: Math.min(limit, 100) });
    return this.format((result.messages ?? []) as SlackMessage[], channel);
  }

  async replies(channel: string, ts: string, limit = 30) {
    const result = await this.web.conversations.replies({ channel, ts, limit: Math.min(limit, 100) });
    return this.format((result.messages ?? []) as SlackMessage[], channel);
  }

  async search(query: string, count = 20) {
    const result = await this.web.search.messages({ query, count: Math.min(count, 100), sort: "timestamp", sort_dir: "desc" });
    const matches = (result.messages?.matches ?? []).filter((message) => !isIgnoredMessage(message.text));
    return Promise.all(matches.map(async (message) => {
      const channel = message.channel?.id ?? message.channel?.name ?? "unknown";
      const images = this.imageReferences(message as SlackMessage, channel);
      return {
        channel,
        ts: message.ts,
        user: message.user ? await this.name(message.user) : message.username,
        text: message.text,
        ...(images.length ? { images } : {}),
      };
    }));
  }

  modelMessage(message: SlackMessage) {
    const { files: _files, attachments: _attachments, blocks: _blocks, ...plain } = message;
    const images = this.imageReferences(message, message.channel);
    return { ...plain, ...(images.length ? { images } : {}) };
  }

  hasImages(message: SlackMessage) {
    return this.imageReferences(message, message.channel).length > 0;
  }

  async viewImage(id: string): Promise<ViewedImage> {
    const source = this.images.get(id);
    if (!source) throw new Error(`Unknown or expired image ID: ${id}`);
    let url = source.url;
    if (!url && source.fileId) {
      const result = await this.web.files.info({ file: source.fileId });
      const file = result.file as SlackImage | undefined;
      url = file && this.imageUrl(file);
    }
    if (!url) throw new Error(`Image ${id} has no readable URL`);
    const parsed = new URL(url);
    if (parsed.protocol !== "https:") throw new Error(`Image ${id} does not use HTTPS`);
    if (parsed.hostname !== "slack.com" && !parsed.hostname.endsWith(".slack.com")) return { id, name: source.name, url };
    const response = await fetch(url, { headers: { Authorization: `Bearer ${this.token}`, Cookie: this.cookieHeader() } });
    if (!response.ok) throw new Error(`Slack image download failed: ${response.status}`);
    const size = Number(response.headers.get("content-length") ?? 0);
    if (size > 10_000_000) throw new Error(`Image ${id} exceeds 10 MB`);
    const mime = response.headers.get("content-type")?.split(";", 1)[0] ?? "";
    if (!new Set(["image/png", "image/jpeg", "image/webp", "image/gif"]).has(mime)) throw new Error(`Unsupported image type: ${mime || "unknown"}`);
    const bytes = Buffer.from(await response.arrayBuffer());
    if (bytes.length > 10_000_000) throw new Error(`Image ${id} exceeds 10 MB`);
    return { id, name: source.name, url: `data:${mime};base64,${bytes.toString("base64")}` };
  }

  async channelInfo(channel: string) {
    const { channel: info } = await this.web.conversations.info({ channel });
    return {
      id: info?.id,
      name: info?.name,
      topic: info?.topic?.value,
      purpose: info?.purpose?.value,
      private: info?.is_private,
      directMessage: info?.is_im,
      groupMessage: info?.is_mpim,
      members: info?.num_members,
    };
  }

  async channelManagers(channel: string) {
    const result = await this.web.apiCall("admin.roles.entity.listAssignments", { entity_id: channel }) as unknown as {
      role_assignments?: { users?: string[] }[];
    };
    return [...new Set((result.role_assignments ?? []).flatMap(({ users }) => users ?? []))];
  }

  async userInfo(user: string) {
    const { user: info } = await this.web.users.info({ user });
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
    const result = await this.web.conversations.members({ channel, limit: Math.min(limit, 100) });
    return Promise.all((result.members ?? []).map(async (id) => ({ id, name: await this.name(id) })));
  }

  async activeHuddle(channel: string, threadTs?: string) {
    const result = threadTs
      ? await this.web.conversations.replies({ channel, ts: threadTs, limit: 1, inclusive: true })
      : await this.web.conversations.history({ channel, limit: 100 });
    return activeHuddleFromMessages(result.messages, channel, threadTs);
  }

  async ensureChannelAccess(channel: string) {
    const { channel: info } = await this.web.conversations.info({ channel });
    if (info?.is_member) return true;
    if (!info || info.is_private) return false;
    await this.web.conversations.join({ channel });
    return true;
  }

  async joinHuddle(channel: string, mediaRegion: string) {
    const form = new FormData();
    form.set("channel_id", channel);
    form.set("regions", mediaRegion);
    form.set("token", this.token);
    form.set("multidevice", "true");
    const response = await fetch(new URL("/api/rooms.join", await this.workspace()), { method: "POST", headers: { Cookie: this.cookieHeader() }, body: form });
    if (!response.ok) throw new Error(`rooms.join HTTP ${response.status}`);
    return normalizeJoinResponse(await response.json());
  }

  async declineHuddle(channel: string, callId: string) {
    const form = new FormData();
    form.set("token", this.token);
    form.set("response", "decline");
    form.set("channel_id", channel);
    form.set("room_id", callId);
    form.set("_x_reason", "respond-to-huddle-invite");
    const response = await fetch(new URL("/api/rooms.inviteResponse", await this.workspace()), { method: "POST", headers: { Cookie: this.cookieHeader() }, body: form });
    const result = await response.json() as { ok?: boolean; error?: string };
    if (!response.ok || !result.ok) throw new Error(`rooms.inviteResponse failed: ${result.error ?? response.status}`);
  }

  async post(channel: string, text: string, threadTs?: string) {
    return this.web.chat.postMessage({
      channel,
      text,
      thread_ts: threadTs,
      unfurl_links: false,
      unfurl_media: false,
    });
  }

  startTyping(channel: string, threadTs?: string) {
    const send = () => {
      if (this.socket?.readyState === WebSocket.OPEN) this.socket.send(JSON.stringify({ id: ++this.outgoingId, type: "user_typing", channel, thread_ts: threadTs }));
    };
    send();
    const timer = setInterval(send, 3_000);
    return () => clearInterval(timer);
  }

  private async name(user?: string) {
    if (!user) return "unknown";
    const cached = this.names.get(user);
    if (cached) return cached;
    const resolving = this.web.users.info({ user }).then((result) => {
      const profile = result.user?.profile;
      return profile?.display_name || profile?.real_name || result.user?.name || user;
    }).catch(() => user);
    this.names.set(user, resolving);
    return resolving;
  }

  private async format(messages: SlackMessage[], channel: string) {
    return Promise.all(messages.filter(({ text }) => !isIgnoredMessage(text)).map(async (message) => {
      const images = this.imageReferences(message, channel);
      return {
        ts: message.ts,
        authorId: message.user ?? message.bot_id,
        author: await this.name(message.user ?? message.bot_id),
        text: message.text ?? "",
        thread_ts: message.thread_ts,
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
    while (this.images.size > 500) this.images.delete(this.images.keys().next().value!);
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

  private async workspace() {
    if (this.workspaceUrl) return this.workspaceUrl;
    const auth = await this.web.auth.test();
    if (!auth.url) throw new Error("Slack auth.test returned no workspace URL");
    return this.workspaceUrl = auth.url;
  }

  private async gatewayUrl() {
    const auth = await this.web.auth.test();
    if (!auth.url) throw new Error("Slack auth.test returned no workspace URL");
    const host = new URL(auth.url).hostname;
    const body = new URLSearchParams({ token: this.token, _x_reason: "client.userBoot", _x_mode: "online", _x_sonic: "true", _x_app_name: "client" });
    const response = await fetch(`https://${host}/api/client.userBoot`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded", Cookie: this.cookieHeader() },
      body,
    });
    const boot = await response.json() as { ok: boolean; error?: string; workspaces?: { id: string; domain: string }[] };
    if (!boot.ok) throw new Error(`client.userBoot: ${boot.error}`);
    const domain = host.replace(/\.slack\.com$/, "");
    const workspace = boot.workspaces?.find((item) => item.domain === domain) ?? (boot.workspaces?.length === 1 ? boot.workspaces[0] : undefined);
    if (!workspace) throw new Error(`client.userBoot did not return ${domain}`);
    const query = new URLSearchParams({ token: this.token, gateway_server: workspace.id, slack_client: "desktop", flannel: "3", lazy_channels: "1" });
    return `wss://wss-primary.slack.com/?${query}`;
  }

  private connect() {
    return new Promise<void>((resolve, reject) => {
      const socket = new WebSocket(this.gateway!, {
        origin: "https://app.slack.com",
        headers: { Cookie: this.cookieHeader(), "User-Agent": "Mozilla/5.0 Chrome/136.0.0.0 Safari/537.36" },
      });
      this.socket = socket;
      let opened = false;
      socket.once("open", () => {
        opened = true;
        this.ping = setInterval(() => socket.readyState === WebSocket.OPEN && socket.send(JSON.stringify({ type: "ping", id: ++this.outgoingId })), 30_000);
        console.log("Slack browser gateway connected");
        resolve();
      });
      socket.on("message", (data) => {
        try {
          const event = JSON.parse(data.toString()) as SlackMessage & { type?: string };
          const huddleEvent = normalizeHuddleEvent(event);
          if (huddleEvent && this.huddleHandler) {
            void this.huddleHandler(huddleEvent).catch((error) => console.error("Huddle event failed", error));
            return;
          }
          if (event.type !== "message" || !this.handler) return;
          void this.handler(event).catch((error) => console.error("Message failed", error));
        } catch (error) {
          console.error("Invalid Slack gateway event", error);
        }
      });
      socket.once("error", (error) => {
        if (!opened) reject(error);
        else console.error("Slack gateway error", error);
      });
      socket.once("close", () => {
        clearInterval(this.ping);
        if (!this.stopped) this.reconnect = setTimeout(() => this.connect().catch((error) => console.error("Slack reconnect failed", error)), 2_000);
      });
    });
  }
}
