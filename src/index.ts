import { KevinAgent } from "./agent.js";
import { ChannelModes } from "./channel-modes.js";
import { config } from "./config.js";
import { ConversationQueue } from "./conversation-queue.js";
import { HuddleBrowser } from "./huddle-browser.js";
import { HuddleManager } from "./huddles.js";
import { MemoryStore } from "./memory.js";
import { isIgnoredMessage, isMentioned, isStopCommand } from "./message-rules.js";
import { OpenRouter } from "./openrouter.js";
import { Slack, type SlackMessage } from "./slack.js";
import { ThreadMutes } from "./thread-mutes.js";

const slack = new Slack(config.slackToken, config.slackCookie, config.slackCookieS);
const channelModes = await new ChannelModes(config.channelModesFile, [config.autoChannel]).load();
const threadMutes = await new ThreadMutes(config.threadMutesFile).load();
const seen = new Set<string>();

const remember = (key: string) => {
  seen.add(key);
  if (seen.size > 2_000) seen.delete(seen.values().next().value!);
};

const { userId, team } = await slack.identity();
const huddles = new HuddleManager(
  slack,
  new OpenRouter(config.openRouterKey),
  new HuddleBrowser(config.chromePath, config.huddleSilenceMs),
  userId,
  { mediaRegion: config.chimeMediaRegion, sttModel: config.sttModel, ttsModel: config.ttsModel, ttsVoice: config.ttsVoice },
);
const kevin = new KevinAgent(slack, new MemoryStore(config.memoryFile), channelModes, huddles);
console.log(`Kevin connected to ${team ?? "Slack"} as ${userId}; auto mode: ${channelModes.list().join(", ") || "off"}`);

slack.onHuddleEvent((event) => huddles.handleEvent(event));
huddles.onTranscript(async ({ text, speakerId, channelId, threadTs }) => {
  const message = {
    channel: channelId,
    thread_ts: threadTs,
    ts: `${Date.now() / 1_000}`,
    user: speakerId,
    text: `[Spoken in the current Huddle] ${text}`,
    huddle: true,
  };
  if (!/\bkevin\b/i.test(text) && !(await kevin.relevant(message))) return;
  const reply = await kevin.respond(message);
  if (reply) await huddles.speak(reply);
});

type Incoming = { message: SlackMessage; pinged: boolean; dm: boolean; subscribed: boolean };

const queue = new ConversationQueue<Incoming>(async ({ values, omitted }) => {
  const latest = values.at(-1)!;
  const message = values.length === 1 && !omitted ? latest.message : {
    ...latest.message,
    text: `[${values.length + omitted} consecutive messages from the same user${omitted ? `; ${omitted} oldest omitted due to flooding` : ""}]\n${values.map(({ message }) => message.text).join("\n")}`,
  };
  const pinged = values.some((item) => item.pinged);
  const dm = values.some((item) => item.dm);
  const subscribed = values.some((item) => item.subscribed);
  const threadKey = `${message.channel}:${message.thread_ts ?? message.ts}`;
  if (threadMutes.has(threadKey)) return;

  const relevant = !pinged && !dm && (channelModes.isEnabled(message.channel) || subscribed) ? await kevin.relevant(message) : false;
  if (!pinged && !dm && !relevant) return;

  const stopTyping = slack.startTyping(message.channel, message.thread_ts);
  const typingStarted = Date.now();
  try {
    const reply = await kevin.respond(message);
    if (!reply || threadMutes.has(threadKey)) return;
    const humanTypingTime = Math.min(4_500, 500 + reply.length * 12 + Math.random() * 700);
    const remaining = humanTypingTime - (Date.now() - typingStarted);
    if (remaining > 0) await new Promise((resolve) => setTimeout(resolve, remaining));
    if (threadMutes.has(threadKey)) return;
    const sent = await slack.post(message.channel, reply, message.thread_ts);
    if (sent.ts) remember(`${message.channel}:${sent.ts}`);
    console.log(`Replied in ${message.channel} to ${message.ts} (${pinged ? "ping" : dm ? "dm" : "auto"}; ${values.length + omitted} message${values.length + omitted === 1 ? "" : "s"})`);
  } finally {
    stopTyping();
  }
}, {
  concurrency: config.queueConcurrency,
  debounceMs: config.messageDebounceMs,
  maxBatchMessages: config.maxBatchMessages,
  maxPendingBatches: config.maxPendingBatches,
});

const conversationKey = (message: SlackMessage) => message.thread_ts
  ? `${message.channel}:thread:${message.thread_ts}`
  : `${message.channel}:${message.channel.startsWith("D") ? "dm" : `channel:${message.user ?? "unknown"}`}`;

slack.onMessage(async (message) => {
  if (!message.channel || !message.ts || !message.text || message.hidden || message.user === userId || isIgnoredMessage(message.text)) return;
  if (message.subtype && message.subtype !== "bot_message") return;

  const key = `${message.channel}:${message.ts}`;
  if (seen.has(key)) return;
  remember(key);

  const pinged = isMentioned(message.text, userId);
  const threadTs = message.thread_ts ?? message.ts;
  const threadKey = `${message.channel}:${threadTs}`;

  if (isStopCommand(message.text, userId)) {
    queue.cancel(conversationKey(message));
    await threadMutes.mute(threadKey);
    const sent = await slack.post(message.channel, "Kevin has left this thread.", threadTs);
    if (sent.ts) remember(`${message.channel}:${sent.ts}`);
    return;
  }

  if (pinged) await threadMutes.subscribe(threadKey);
  if (threadMutes.has(threadKey)) return;

  const auto = channelModes.isEnabled(message.channel);
  const dm = message.channel.startsWith("D");
  const subscribed = threadMutes.isSubscribed(threadKey);
  if (!pinged && !dm && !auto && !subscribed) return;
  const accepted = queue.enqueue({
    key: conversationKey(message),
    sender: message.user ?? message.bot_id ?? "unknown",
    priority: pinged || dm ? 2 : subscribed ? 1 : 0,
    value: { message, pinged, dm, subscribed },
  });
  if (!accepted && (pinged || dm)) await slack.post(message.channel, "Kevin is occupied. Your queue-capacity fee has been charged.", message.thread_ts);
});

const shutdown = async () => {
  await huddles.stop();
  await slack.stop();
  process.exit(0);
};
process.once("SIGINT", shutdown);
process.once("SIGTERM", shutdown);

await slack.start();
