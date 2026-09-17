import { KevinAgent } from "./agent.js";
import { BotExchanges, botExchangeKey } from "./bot-exchanges.js";
import { ChannelModes } from "./channel-modes.js";
import { config, configSummary } from "./config.js";
import { ConversationQueue } from "./conversation-queue.js";
import { createLogger, getLogLevel, preview, setLogFormat, setLogLevel, timer } from "./logger.js";
import { MemoryStore } from "./memory.js";
import { isBotMessage, isEphemeralMessage, isIgnoredMessage, isMentioned, isRespondableMessage, isStopCommand, shouldClassifyRelevance, shouldConsiderMessage } from "./message-rules.js";
import { messageRef, Slack, type SlackMessage } from "./slack.js";
import { ThreadMutes } from "./thread-mutes.js";

setLogLevel(config.logLevel);
setLogFormat(config.logFormat);

const log = createLogger("kevin");
const intake = log.child("intake");
const reply = log.child("reply");

log.info("Kevin starting", { pid: process.pid, node: process.version, ...configSummary() });
if (config.logLevel !== getLogLevel()) log.warn("Unknown LOG_LEVEL; keeping the current level", { requested: config.logLevel, level: getLogLevel() });

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
const kevin = new KevinAgent(slack, new MemoryStore(config.memoryFile), channelModes, userId);
log.info("Kevin connected", { team: team ?? "Slack", userId, autoMode: channelModes.list(), logLevel: getLogLevel() });

type Incoming = { message: SlackMessage; pinged: boolean; dm: boolean };

const queue = new ConversationQueue<Incoming>(async ({ values, omitted }) => {
  const elapsed = timer();
  const latest = values.at(-1)!;
  const combined = values.length > 1 || omitted > 0;
  const message = combined ? {
    ...latest.message,
    text: `[${values.length + omitted} consecutive messages from the same user${omitted ? `; ${omitted} oldest omitted due to flooding` : ""}]\n${values.map(({ message }) => message.text).join("\n")}`,
  } : latest.message;
  const pinged = values.some((item) => item.pinged);
  const dm = values.some((item) => item.dm);
  const fromBot = values.some((item) => isBotMessage(item.message));
  const exchangeKey = botExchangeKey(message);
  const threadKey = `${message.channel}:${message.thread_ts ?? message.ts}`;
  const trigger = pinged ? "ping" : dm ? "dm" : "auto";
  const scope = reply.with({ ...messageRef(message), trigger });
  scope.info("Handling conversation", { messages: values.length, omitted, combined, fromBot, conversation: exchangeKey });

  if (threadMutes.has(threadKey)) {
    scope.info("Skipped; thread is muted", { thread: threadKey });
    return;
  }
  if (fromBot && botExchanges.atLimit(exchangeKey)) {
    scope.info("Skipped; bot-loop cap reached", { conversation: exchangeKey, max: botExchanges.max });
    return;
  }

  const classify = shouldClassifyRelevance({ pinged, dm, autoMode: channelModes.isEnabled(message.channel) });
  const relevant = classify ? await kevin.relevant(message) : false;
  if (!pinged && !dm && !relevant) {
    scope.info("Skipped; not relevant", { classified: classify, ms: elapsed() });
    return;
  }

  const stopTyping = slack.startTyping(message.channel, message.thread_ts);
  try {
    const text = await kevin.respond(message);
    if (!text) {
      scope.warn("No reply produced; nothing sent", { ms: elapsed() });
      return;
    }
    if (threadMutes.has(threadKey)) {
      scope.info("Reply discarded; thread was muted while composing", { thread: threadKey, ms: elapsed() });
      return;
    }
    const sent = await slack.post(message.channel, text, message.thread_ts);
    if (sent.ts) remember(`${message.channel}:${sent.ts}`);
    if (fromBot) botExchanges.noteBotReply(exchangeKey);
    scope.info("Replied", {
      replyTs: sent.ts,
      messages: values.length + omitted,
      chars: text.length,
      ...(fromBot ? { botExchange: `${botExchanges.count(exchangeKey)}/${botExchanges.max}` } : {}),
      ms: elapsed(),
    });
  } catch (error) {
    scope.failure("Reply failed", error, { ms: elapsed() });
    throw error;
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

/** Why an incoming event is not conversational at all; the checks keep their original order. */
const dropReason = (message: SlackMessage, text: string) => {
  if (!message.channel) return "no-channel";
  if (!message.ts) return "no-timestamp";
  if (!text && !slack.hasImages(message)) return "no-text-or-image";
  if (message.hidden && !isEphemeralMessage(message)) return "hidden-system-event";
  if (message.user === userId) return "own-message";
  if (isIgnoredMessage(text)) return "hash-prefixed";
  if (!isRespondableMessage(message)) return `unsupported-subtype:${message.subtype}`;
  return undefined;
};

slack.onMessage(async (message) => {
  const text = message.text ?? "";
  // Hidden system events (edits/deletes) are dropped; ephemeral notices for Kevin are allowed through.
  const dropped = dropReason(message, text);
  if (dropped) {
    intake.debug("Message dropped", { ...messageRef(message), reason: dropped });
    return;
  }

  const key = `${message.channel}:${message.ts}`;
  if (seen.has(key)) {
    intake.debug("Message dropped", { ...messageRef(message), reason: "already-seen" });
    return;
  }
  remember(key);

  const exchangeKey = botExchangeKey(message);
  const fromBot = isBotMessage(message);
  if (fromBot) {
    if (botExchanges.atLimit(exchangeKey)) {
      intake.info("Bot message ignored; exchange cap reached", { ...messageRef(message), conversation: exchangeKey, max: botExchanges.max });
      return;
    }
  } else {
    botExchanges.noteHuman(exchangeKey);
  }

  const pinged = isMentioned(text, userId);
  const threadTs = message.thread_ts ?? message.ts;
  const threadKey = `${message.channel}:${threadTs}`;

  if (isStopCommand(text, userId)) {
    intake.info("Stop command received", { ...messageRef(message), thread: threadKey });
    queue.cancel(conversationKey(message));
    await threadMutes.mute(threadKey);
    const sent = await slack.post(message.channel, "Kevin has left this thread.", threadTs);
    if (sent.ts) remember(`${message.channel}:${sent.ts}`);
    return;
  }

  if (pinged) await threadMutes.subscribe(threadKey);
  if (threadMutes.has(threadKey)) {
    intake.debug("Message dropped", { ...messageRef(message), reason: "thread-muted", thread: threadKey });
    return;
  }

  const auto = channelModes.isEnabled(message.channel);
  const dm = message.channel.startsWith("D");
  const subscribed = threadMutes.isSubscribed(threadKey);
  if (!shouldConsiderMessage({ pinged, dm, autoMode: auto })) {
    intake.debug("Message dropped", { ...messageRef(message), reason: "not-pinged-dm-or-auto", autoMode: auto, subscribed });
    return;
  }

  const priority = pinged || dm ? 2 : subscribed ? 1 : 0;
  const accepted = queue.enqueue({
    key: conversationKey(message),
    sender: message.user ?? message.bot_id ?? "unknown",
    priority,
    value: { message, pinged, dm },
  });
  intake.info(accepted ? "Message accepted" : "Message rejected; queue full", {
    ...messageRef(message),
    trigger: pinged ? "ping" : dm ? "dm" : "auto",
    priority,
    fromBot,
    subscribed,
    text: preview(text, 200),
  });
  if (!accepted && (pinged || dm)) await slack.post(message.channel, "Kevin is occupied. Your queue-capacity fee has been charged.", message.thread_ts);
});

process.on("unhandledRejection", (error) => log.failure("Unhandled promise rejection", error));
process.on("uncaughtException", (error) => log.failure("Uncaught exception", error));

const shutdown = async (signal: string) => {
  log.info("Shutting down", { signal });
  try {
    await slack.stop();
  } catch (error) {
    log.failure("Shutdown failed to close the Slack gateway cleanly", error, { signal });
  }
  log.info("Kevin stopped", { signal, uptimeSeconds: Math.round(process.uptime()) });
  process.exit(0);
};
process.once("SIGINT", () => void shutdown("SIGINT"));
process.once("SIGTERM", () => void shutdown("SIGTERM"));

await slack.start();
log.info("Kevin is listening", { userId, team: team ?? "Slack" });
