import { replyThread } from "./actions.js";
import { KevinAgent, type Turn } from "./agent.js";
import { BotExchanges, botExchangeKey } from "./bot-exchanges.js";
import { ChannelModes } from "./channel-modes.js";
import { config, configSummary } from "./config.js";
import { ConversationQueue } from "./conversation-queue.js";
import { parseCron } from "./cron.js";
import { HuddleFm, type Announcement } from "./huddlefm.js";
import { KevinChannel } from "./kevin-channel.js";
import { Huddles } from "./huddle/huddles.js";
import { SpeechClient } from "./huddle/speech.js";
import { OPENROUTER_BASE } from "./chat.js";
import { createLogger, getLogLevel, preview, setLogFormat, setLogLevel, timer } from "./logger.js";
import { MemoryStore } from "./memory.js";
import { isBotMessage, isEphemeralMessage, isIgnoredMessage, isManagerCommand, isMentioned, isRespondableMessage, isStopCommand, shouldClassifyRelevance, shouldConsiderMessage } from "./message-rules.js";
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
const huddleFm = config.huddleFmUserId
  ? await new HuddleFm({
    openDm: (user) => slack.openDm(user),
    post: async (channel, text) => (await slack.postVerbatim(channel, text)).ts,
  }, config.huddleFmUserId, config.huddleFmFile).load()
  : undefined;
const huddles = config.huddles
  ? new Huddles(slack, new SpeechClient({
    apiKey: config.openRouterKey,
    baseUrl: OPENROUTER_BASE,
    sttModel: config.sttModel,
    ttsModel: config.ttsModel,
    ttsVoice: config.ttsVoice,
    ttsSampleRate: config.ttsSampleRate,
    ttsInstructions: "Flat, low, unhurried corporate executive. Quietly menacing understatement. Never cheerful.",
    language: config.huddleLanguage,
  }), userId, { region: config.huddleRegion, maxSessions: config.huddleMaxSessions, acceptInvites: config.huddleAcceptInvites })
  : undefined;
/** The group's handle, so Kevin can name it; the ID alone still works if Slack will not list groups. */
const userGroupHandle = async (id: string) => {
  try {
    return (await slack.userGroups()).find((group) => group.id === id)?.handle;
  } catch (error) {
    log.warn("Could not look up Kevin's channel user group", { usergroup: id, error: error instanceof Error ? error.message : String(error) });
    return undefined;
  }
};
const ownChannel = config.kevinChannel ? {
  channel: config.kevinChannel,
  timezone: config.kevinChannelTimezone,
  ...(config.kevinChannelUserGroup ? { userGroup: { id: config.kevinChannelUserGroup, handle: await userGroupHandle(config.kevinChannelUserGroup) } } : {}),
} : undefined;
if (ownChannel?.userGroup) slack.allowGroupPing(ownChannel.channel, ownChannel.userGroup.id);
// Parsed before connecting so a bad schedule fails at startup, not at the first tick.
const ownSchedule = ownChannel ? parseCron(config.kevinChannelCron, ownChannel.timezone) : undefined;
const memory = new MemoryStore(config.memoryFile);
// Read once at startup so a missing volume or a broken file shows up now, not on the first reply.
log.info("Memory ready", { file: config.memoryFile, records: (await memory.list()).length });
const kevin = new KevinAgent(slack, memory, channelModes, userId, huddleFm, huddles, ownChannel);
if (huddles) {
  huddles.onVoiceTurn = (input) => kevin.voiceTurn(input);
  slack.onEvent((event) => huddles.handleEvent(event));
  huddles.start();
}
log.info("Kevin connected", { team: team ?? "Slack", userId, autoMode: channelModes.list(), huddleFm: config.huddleFmUserId ?? "off", huddles: Boolean(huddles), logLevel: getLogLevel() });

type Incoming = { message: SlackMessage; pinged: boolean; dm: boolean };

/** Channels Kevin chose to leave during a turn; left only after the final action so a parting reply still lands. */
const leaveChannels = async (turn: Turn, scope: typeof reply) => {
  for (const channel of turn.leaveAfter) {
    try {
      await slack.leave(channel);
    } catch (error) {
      scope.failure("Leaving the channel failed", error, { leave: channel });
    }
  }
};

/** Reactions land on the message being answered; one bad emoji does not stop the rest or the reply. */
const addReactions = async (message: Pick<SlackMessage, "channel" | "ts">, reactions: string[], scope: typeof reply) => {
  let added = 0;
  for (const emoji of reactions) {
    try {
      await slack.react(message.channel, message.ts, emoji);
      added++;
    } catch (error) {
      scope.warn("Reaction failed", { emoji, error: error instanceof Error ? error.message : String(error) });
    }
  }
  return added;
};

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
  const own = message.channel === config.kevinChannel;
  const manager = values.some((item) => isManagerCommand(item.message, config.kevinManagers));
  const trigger = manager ? "manager" : pinged ? "ping" : dm ? "dm" : own ? "own-channel" : "auto";
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

  // Kevin watches His own channel Himself; the reply model decides whether to speak.
  const classify = !own && shouldClassifyRelevance({ pinged, dm, autoMode: channelModes.isEnabled(message.channel) });
  const relevant = own || (classify ? await kevin.relevant(message) : false);
  if (!pinged && !dm && !relevant) {
    scope.info("Skipped; not relevant", { classified: classify, ms: elapsed() });
    return;
  }

  const stopTyping = slack.startTyping(message.channel, message.thread_ts);
  let turn: Turn | undefined;
  try {
    turn = await kevin.respond(message, { manager });
    if (turn.action === "silent") {
      scope.info("Stayed silent", { reason: preview(turn.reason, 200), ms: elapsed() });
      return;
    }
    if (threadMutes.has(threadKey)) {
      scope.info("Reply discarded; thread was muted while composing", { thread: threadKey, ms: elapsed() });
      return;
    }
    const reactions = await addReactions(message, turn.reactions, scope);
    const sent = turn.text ? await slack.post(message.channel, turn.text, replyThread(message, turn.inThread, turn.threadTs), turn.broadcast) : undefined;
    if (sent?.ts) remember(`${message.channel}:${sent.ts}`);
    if (sent && fromBot) botExchanges.noteBotReply(exchangeKey);
    scope.info(sent ? "Replied" : "Reacted", {
      replyTs: sent?.ts,
      reactions,
      messages: values.length + omitted,
      chars: turn.text?.length ?? 0,
      ...(sent && fromBot ? { botExchange: `${botExchanges.count(exchangeKey)}/${botExchanges.max}` } : {}),
      ms: elapsed(),
    });
  } catch (error) {
    scope.failure("Reply failed", error, { ms: elapsed() });
    throw error;
  } finally {
    stopTyping();
    if (turn) await leaveChannels(turn, scope);
  }
}, {
  concurrency: config.queueConcurrency,
  debounceMs: config.messageDebounceMs,
  maxBatchMessages: config.maxBatchMessages,
  maxPendingBatches: config.maxPendingBatches,
});

/** Kevin writes His own word on what HuddleFM reported, where He was asked. */
const announce = async (announcement: Announcement) => {
  const { origin } = announcement;
  const scope = reply.with({ channel: origin.channel, thread: origin.thread_ts, event: announcement.event, huddleChannel: announcement.huddleChannel });
  if (origin.thread_ts && threadMutes.has(`${origin.channel}:${origin.thread_ts}`)) {
    scope.info("HuddleFM announcement skipped; thread is muted");
    return;
  }
  const elapsed = timer();
  const stopTyping = slack.startTyping(origin.channel, origin.thread_ts);
  let turn: Turn | undefined;
  try {
    turn = await kevin.announce(announcement);
    if (turn.action === "silent" || !turn.text) {
      scope.info("No HuddleFM announcement sent", { reason: turn.action === "silent" ? preview(turn.reason, 200) : "reactions-only", ms: elapsed() });
      return;
    }
    const sent = await slack.post(origin.channel, turn.text, origin.thread_ts, turn.broadcast && Boolean(origin.thread_ts));
    if (sent.ts) remember(`${origin.channel}:${sent.ts}`);
    scope.info("Announced a HuddleFM event", { replyTs: sent.ts, chars: turn.text.length, ms: elapsed() });
  } finally {
    stopTyping();
    if (turn) await leaveChannels(turn, scope);
  }
};
if (huddleFm) huddleFm.onAnnouncement = announce;

/** Kevin's unprompted word in His own channel: a scheduled post, or His take on what just happened there. */
const postInOwnChannel = async (channel: string, phase: "muse" | "observe", compose: () => Promise<Turn>) => {
  const scope = reply.with({ channel, phase });
  const elapsed = timer();
  const stopTyping = slack.startTyping(channel);
  let turn: Turn | undefined;
  try {
    turn = await compose();
    if (turn.action === "silent") {
      scope.info("Nothing posted in Kevin's channel", { reason: preview(turn.reason, 200), ms: elapsed() });
      return;
    }
    // With nothing to answer, a thread or reactions need a message Kevin named.
    const reactions = turn.threadTs ? await addReactions({ channel, ts: turn.threadTs }, turn.reactions, scope) : 0;
    if (!turn.text) {
      scope.info(reactions ? "Reacted in Kevin's channel" : "Nothing posted in Kevin's channel", { thread: turn.threadTs, reactions, ms: elapsed() });
      return;
    }
    const sent = await slack.post(channel, turn.text, turn.threadTs, turn.broadcast && Boolean(turn.threadTs));
    if (sent.ts) remember(`${channel}:${sent.ts}`);
    scope.info("Posted in Kevin's channel", { replyTs: sent.ts, thread: turn.threadTs, reactions, chars: turn.text.length, ms: elapsed() });
  } finally {
    stopTyping();
    if (turn) await leaveChannels(turn, scope);
  }
};

const kevinChannel = ownChannel && ownSchedule
  ? new KevinChannel({
    channel: ownChannel.channel,
    kevinId: userId,
    schedule: ownSchedule,
    chance: config.kevinChannelChance,
    jitterMs: Math.max(0, config.kevinChannelJitterMinutes) * 60_000,
    muse: () => postInOwnChannel(ownChannel.channel, "muse", () => kevin.muse()),
    onJoin: config.kevinChannelUserGroup ? async (user) => {
      const usergroup = config.kevinChannelUserGroup!;
      try {
        return { userGroup: usergroup, ...(await slack.addToUserGroup(usergroup, user)) };
      } catch (error) {
        log.failure("Adding a newcomer to the user group failed", error, { usergroup, user });
        return { userGroup: usergroup, ok: false, error: error instanceof Error ? error.message : String(error) };
      }
    } : undefined,
    observe: (events, omitted) => postInOwnChannel(ownChannel.channel, "observe", () => kevin.observe(events, omitted)),
  })
  : undefined;
if (kevinChannel) {
  if (!(await slack.ensureChannelAccess(kevinChannel.channel).catch(() => false))) log.warn("Kevin cannot see His own channel; invite Him to it", { channel: kevinChannel.channel });
  slack.onEvent((event) => kevinChannel.handleEvent(event));
  kevinChannel.start();
}

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
  // HuddleFM's DMs are protocol replies and events, never conversation.
  if (huddleFm?.accepts(message)) {
    await huddleFm.receive(message);
    return;
  }
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
  const own = message.channel === config.kevinChannel;
  const dm = message.channel.startsWith("D");
  const subscribed = threadMutes.isSubscribed(threadKey);
  if (!shouldConsiderMessage({ pinged, dm, autoMode: auto || own })) {
    intake.debug("Message dropped", { ...messageRef(message), reason: "not-pinged-dm-or-auto", autoMode: auto, subscribed });
    return;
  }

  const priority = pinged || dm ? 2 : subscribed || own ? 1 : 0;
  const accepted = queue.enqueue({
    key: conversationKey(message),
    sender: message.user ?? message.bot_id ?? "unknown",
    priority,
    value: { message, pinged, dm },
  });
  intake.info(accepted ? "Message accepted" : "Message rejected; queue full", {
    ...messageRef(message),
    trigger: pinged ? "ping" : dm ? "dm" : own ? "own-channel" : "auto",
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
  huddleFm?.stop();
  kevinChannel?.stop();
  await huddles?.stop().catch((error) => log.failure("Leaving huddles on shutdown failed", error));
  await memory.flush();
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
