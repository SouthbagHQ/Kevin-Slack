import { WebClient } from "@slack/web-api";
import WebSocket from "ws";
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
};

export class Slack {
  readonly web: WebClient;
  private names = new Map<string, Promise<string>>();
  private socket?: WebSocket;
  private ping?: NodeJS.Timeout;
  private reconnect?: NodeJS.Timeout;
  private outgoingId = 0;
  private gateway?: string;
  private stopped = false;
  private handler?: (message: SlackMessage) => Promise<void>;
  private queue = Promise.resolve();

  constructor(private token: string, private cookie: string, private cookieS?: string) {
    this.web = new WebClient(token, { headers: { Cookie: this.cookieHeader() } });
  }

  async identity() {
    const result = await this.web.auth.test();
    if (!result.user_id) throw new Error("Slack auth.test returned no user_id");
    return { userId: result.user_id, team: result.team };
  }

  onMessage(handler: (message: SlackMessage) => Promise<void>) {
    this.handler = handler;
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
    return this.format((result.messages ?? []) as SlackMessage[]);
  }

  async replies(channel: string, ts: string, limit = 30) {
    const result = await this.web.conversations.replies({ channel, ts, limit: Math.min(limit, 100) });
    return this.format((result.messages ?? []) as SlackMessage[]);
  }

  async search(query: string, count = 20) {
    const result = await this.web.search.messages({ query, count: Math.min(count, 100), sort: "timestamp", sort_dir: "desc" });
    const matches = (result.messages?.matches ?? []).filter((message) => !isIgnoredMessage(message.text));
    return Promise.all(matches.map(async (message) => ({
      channel: message.channel?.id ?? message.channel?.name,
      ts: message.ts,
      user: message.user ? await this.name(message.user) : message.username,
      text: message.text,
    })));
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

  private async format(messages: SlackMessage[]) {
    return Promise.all(messages.filter(({ text }) => !isIgnoredMessage(text)).map(async ({ ts, user, bot_id, text, thread_ts }) => ({
      ts,
      authorId: user ?? bot_id,
      author: await this.name(user ?? bot_id),
      text: text ?? "",
      thread_ts,
    })));
  }

  private cookieHeader() {
    return `d=${this.cookie}${this.cookieS ? `; d-s=${this.cookieS}` : ""}`;
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
          if (event.type !== "message" || !this.handler) return;
          this.queue = this.queue.then(() => this.handler!(event)).catch((error) => console.error("Message failed", error));
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
