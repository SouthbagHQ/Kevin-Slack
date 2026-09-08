import { KevinAgent } from "./agent.js";
import { BotExchanges, botExchangeKey } from "./bot-exchanges.js";
import { ChannelModes } from "./channel-modes.js";
import { config } from "./config.js";
import { ConversationQueue } from "./conversation-queue.js";
import { MemoryStore } from "./memory.js";
import { isBotMessage, isEphemeralMessage, isIgnoredMessage, isMentioned, isRespondableMessage, isStopCommand, shouldClassifyRelevance, shouldConsiderMessage } from "./message-rules.js";
import { Slack, type SlackMessage } from "./slack.js";
import { ThreadMutes } from "./thread-mutes.js";

const slack = new Slack(config.slackToken, config.slackCookie, config.slackCookieS);
const channelModes = await new ChannelModes(config.channelModesFile).load();
const threadMutes = await new ThreadMutes(config.threadMutesFile).load();
const botExchanges = new BotExchanges(config.maxBotExchanges);
const seen = new Set<string>();

const remember = (key: string) => {
  seen.add(key);
  if (seen.size > 2_000) seen.delete(seen.values().next().value!);
};

const { userId, team } = await slack.identity();
const kevin = new KevinAgent(slack, await new MemoryStore(config.memoryFile).load(), channelModes, userId);
console.log(`Kevin connected to ${team ?? "Slack"} as ${userId}; auto mode: ${channelModes.list().join(", ") || "off"}`);

type Incoming = { message: SlackMessage; pinged: boolean; dm: boolean };

const queue = new ConversationQueue<Incoming>(async ({ values, omitted }) => {
  const latest = values.at(-1)!;
  const message = values.length === 1 && !omitted ? latest.message : {
    ...latest.message,
    text: `[${values.length + omitted} consecutive messages from the same user${omitted ? `; ${omitted} oldest omitted due to flooding` : ""}]\n${values.map(({ message }) => message.text).join("\n")}`,
  };
  const pinged = values.some((item) => item.pinged);
  const dm = values.some((item) => item.dm);
  const fromBot = values.some((item) => isBotMessage(item.message));
  const exchangeKey = botExchangeKey(message);
  const threadKey = `${message.channel}:${message.thread_ts ?? message.ts}`;
  if (threadMutes.has(threadKey)) return;
  if (fromBot && botExchanges.atLimit(exchangeKey)) {
    console.log(`Skipping bot loop in ${exchangeKey} after ${botExchanges.max} exchanges`);
    return;
  }

  const relevant = shouldClassifyRelevance({ pinged, dm, autoMode: channelModes.isEnabled(message.channel) })
    ? await kevin.relevant(message)
    : false;
  if (!pinged && !dm && !relevant) return;

  const stopTyping = slack.startTyping(message.channel, message.thread_ts);
  try {
    const reply = await kevin.respond(message);
    if (!reply || threadMutes.has(threadKey)) return;
    if (threadMutes.has(threadKey)) return;
    const sent = await slack.post(message.channel, reply, message.thread_ts);
    if (sent.ts) remember(`${message.channel}:${sent.ts}`);
    if (fromBot) botExchanges.noteBotReply(exchangeKey);
    console.log(`Replied in ${message.channel} to ${message.ts} (${pinged ? "ping" : dm ? "dm" : "auto"}; ${values.length + omitted} message${values.length + omitted === 1 ? "" : "s"}${fromBot ? `; bot exchange ${botExchanges.count(exchangeKey)}/${botExchanges.max}` : ""})`);
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
  : `${message.channel}:${message.channel.startsWith("D") ? "dm" : `channel:${message.user ?? message.bot_id ?? "unknown"}`}`;

slack.onMessage(async (message) => {
  const text = message.text ?? "";
  // Hidden system events (edits/deletes) are dropped; ephemeral notices for Kevin are allowed through.
  if (!message.channel || !message.ts || (!text && !slack.hasImages(message)) || (message.hidden && !isEphemeralMessage(message)) || message.user === userId || isIgnoredMessage(text) || !isRespondableMessage(message)) return;

  const key = `${message.channel}:${message.ts}`;
  if (seen.has(key)) return;
  remember(key);

  const exchangeKey = botExchangeKey(message);
  if (isBotMessage(message)) {
    if (botExchanges.atLimit(exchangeKey)) {
      console.log(`Ignoring bot message in ${exchangeKey}; exchange cap ${botExchanges.max} reached`);
      return;
    }
  } else {
    botExchanges.noteHuman(exchangeKey);
  }

  const pinged = isMentioned(text, userId);
  const threadTs = message.thread_ts ?? message.ts;
  const threadKey = `${message.channel}:${threadTs}`;

  if (isStopCommand(text, userId)) {
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
  if (!shouldConsiderMessage({ pinged, dm, autoMode: auto })) return;
  const accepted = queue.enqueue({
    key: conversationKey(message),
    sender: message.user ?? message.bot_id ?? "unknown",
    priority: pinged || dm ? 2 : subscribed ? 1 : 0,
    value: { message, pinged, dm },
  });
  if (!accepted && (pinged || dm)) await slack.post(message.channel, "Kevin is occupied. Your queue-capacity fee has been charged.", message.thread_ts);
});

const shutdown = async () => {
  await slack.stop();
  process.exit(0);
};
process.once("SIGINT", shutdown);
process.once("SIGTERM", shutdown);

await slack.start();
