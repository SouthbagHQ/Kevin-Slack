import type { SlackMessage } from "./slack.js";
import type { Slack } from "./slack.js";
import type { OpenRouter } from "./openrouter.js";
import type { HuddleBrowser, HuddleBrowserSession } from "./huddle-browser.js";
import type { ActiveHuddle, HuddleEvent, JoinedHuddle } from "./huddle-types.js";

const joinTool = {
  type: "function",
  function: {
    name: "join_huddle",
    description: "Join the active Slack Huddle associated with this conversation. Kevin can be in only one Huddle at a time.",
    parameters: { type: "object", properties: {}, additionalProperties: false },
  },
};

const leaveTool = {
  type: "function",
  function: {
    name: "leave_huddle",
    description: "Leave the Slack Huddle Kevin is currently in.",
    parameters: { type: "object", properties: {}, additionalProperties: false },
  },
};

type Active = { joined: JoinedHuddle; session: HuddleBrowserSession };
type Transcript = { text: string; speakerId?: string; channelId: string; threadTs: string };

export class HuddleManager {
  private active?: Active;
  private transition?: Promise<unknown>;
  private joiningCallId?: string;
  private audioQueue = Promise.resolve();
  private transcriptHandler?: (transcript: Transcript) => Promise<void>;

  constructor(
    private slack: Slack,
    private openRouter: OpenRouter,
    private browser: HuddleBrowser,
    private userId: string,
    private config: { mediaRegion: string; sttModel: string; ttsModel: string; ttsVoice: string },
  ) {}

  onTranscript(handler: (transcript: Transcript) => Promise<void>) {
    this.transcriptHandler = handler;
  }

  async capabilities(message: SlackMessage) {
    if (this.active) return { status: `Kevin is in the Huddle in ${this.active.joined.channelId}.`, tools: [leaveTool] };
    if (this.transition) return { status: "Kevin is currently joining or leaving a Huddle.", tools: [] };
    const target = this.target(message);
    if (!target) return { status: "No active Huddle is associated with this conversation.", tools: [] };
    const active = await this.slack.activeHuddle(target, target === message.channel ? message.thread_ts : undefined).catch(() => undefined);
    return active
      ? { status: `An active Huddle is available in ${active.channelId}.`, tools: [joinTool] }
      : { status: "No active Huddle is associated with this conversation.", tools: [] };
  }

  async runTool(name: string, message: SlackMessage) {
    if (name === "join_huddle") {
      const target = this.target(message);
      if (!target) return { ok: false, error: "No target channel was provided." };
      const active = await this.slack.activeHuddle(target, target === message.channel ? message.thread_ts : undefined);
      if (!active) return { ok: false, error: "There is no active Huddle in that channel." };
      return this.join(active);
    }
    if (name === "leave_huddle") return this.leave();
    return { ok: false, error: `Unknown Huddle tool: ${name}` };
  }

  async handleEvent(event: HuddleEvent) {
    if (event.type === "invited") {
      const busyCallId = this.active?.joined.callId ?? this.joiningCallId;
      if (this.transition || this.active) {
        if (busyCallId !== event.callId) await this.slack.declineHuddle(event.channelId, event.callId);
        return;
      }
      await this.join({ channelId: event.channelId, callId: event.callId, threadTs: "" }, event.inviterUserId);
      return;
    }
    if (event.type === "ended" && (this.active?.joined.callId === event.callId || this.active?.joined.huddleId === event.callId)) await this.leave();
    if (event.type === "member_left" && event.userId === this.userId && (this.active?.joined.callId === event.callId || this.active?.joined.huddleId === event.callId)) await this.leave();
  }

  async speak(text: string) {
    const active = this.active;
    if (!active) return false;
    const speakable = text
      .replace(/<@[^>]+>/g, "")
      .replace(/<#[^|>]+\|([^>]+)>/g, "$1")
      .replace(/[*_~`]/g, "")
      .replace(/https?:\/\/\S+/g, "the link")
      .trim();
    if (!speakable) return false;
    const audio = await this.openRouter.speech(speakable, this.config.ttsModel, this.config.ttsVoice);
    if (this.active !== active) return false;
    await active.session.speak(audio);
    return true;
  }

  async stop() {
    await this.transition?.catch(() => undefined);
    await this.leave();
    await this.browser.stop();
  }

  private target(message: SlackMessage) {
    return message.text?.match(/<#([CG][A-Z0-9]+)(?:\|[^>]+)?>/)?.[1] ?? (/^[CG]/.test(message.channel) ? message.channel : undefined);
  }

  private async join(target: ActiveHuddle, inviterUserId?: string) {
    if (this.active || this.transition) return { ok: false, error: "Kevin is already in, joining, or leaving another Huddle." };
    this.joiningCallId = target.callId;
    const operation = (async () => {
      if (!(await this.slack.ensureChannelAccess(target.channelId))) {
        if (inviterUserId) await this.slack.declineHuddle(target.channelId, target.callId);
        return { ok: false, error: `Kevin cannot access that private channel.${inviterUserId ? " The invitation was declined." : ""}` };
      }
      const joined = await this.slack.joinHuddle(target.channelId, this.config.mediaRegion);
      if (target.callId && joined.callId !== target.callId) throw new Error("The invited Huddle is no longer active");
      const session = await this.browser.join(
        joined,
        (audio) => this.receive(audio.data, audio.speakerId, joined),
        () => void this.ended(joined),
      );
      this.active = { joined, session };
      console.log(`Kevin joined Huddle ${joined.callId} in ${joined.channelId}${inviterUserId ? ` (invited by ${inviterUserId})` : ""}`);
      return { ok: true, channel: joined.channelId, threadTs: joined.threadTs };
    })();
    this.transition = operation;
    try {
      return await operation;
    } finally {
      if (this.transition === operation) this.transition = undefined;
      this.joiningCallId = undefined;
    }
  }

  private async leave() {
    if (this.transition) return { ok: false, error: "Kevin is already joining or leaving a Huddle." };
    const active = this.active;
    if (!active) return { ok: false, error: "Kevin is not in a Huddle." };
    const operation = active.session.close();
    this.transition = operation;
    try {
      await operation;
      if (this.active === active) this.active = undefined;
      console.log(`Kevin left Huddle ${active.joined.callId}`);
      return { ok: true };
    } finally {
      if (this.transition === operation) this.transition = undefined;
    }
  }

  private receive(audio: Buffer, speakerId: string | undefined, joined: JoinedHuddle) {
    this.audioQueue = this.audioQueue.then(async () => {
      if (this.active?.joined !== joined || speakerId === this.userId) return;
      const text = await this.openRouter.transcribe(audio, this.config.sttModel);
      if (!text || /^\s*(?:\[blank_audio\]|thank you\.?|you)\s*$/i.test(text)) return;
      console.log(`Huddle transcript${speakerId ? ` ${speakerId}` : ""}: ${text}`);
      await this.transcriptHandler?.({ text, speakerId, channelId: joined.channelId, threadTs: joined.threadTs });
    }).catch((error) => console.error("Huddle audio failed", error));
    return Promise.resolve();
  }

  private async ended(joined: JoinedHuddle) {
    if (this.active?.joined !== joined || this.transition) return;
    await this.leave();
  }
}
