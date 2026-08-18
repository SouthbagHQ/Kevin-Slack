import { KevinAgent } from "./agent.js";
import { config } from "./config.js";
import { MemoryStore } from "./memory.js";
import { isIgnoredMessage, isMentioned, isStopCommand } from "./message-rules.js";
import { Slack } from "./slack.js";
import { ThreadMutes } from "./thread-mutes.js";

const slack = new Slack(config.slackToken, config.slackCookie, config.slackCookieS);
const kevin = new KevinAgent(slack, new MemoryStore(config.memoryFile));
const threadMutes = await new ThreadMutes(config.threadMutesFile).load();
const seen = new Set<string>();

const remember = (key: string) => {
  seen.add(key);
  if (seen.size > 2_000) seen.delete(seen.values().next().value!);
};

const { userId, team } = await slack.identity();
console.log(`Kevin connected to ${team ?? "Slack"} as ${userId}; auto mode: ${config.autoChannel}`);

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
    await threadMutes.mute(threadKey);
    const sent = await slack.post(message.channel, "Kevin has left this thread.", threadTs);
    if (sent.ts) remember(`${message.channel}:${sent.ts}`);
    return;
  }

  if (pinged) await threadMutes.subscribe(threadKey);
  if (threadMutes.has(threadKey)) return;

  const auto = message.channel === config.autoChannel;
  const subscribed = threadMutes.isSubscribed(threadKey);
  if (!pinged && !auto && !subscribed) return;

  const relevant = !pinged && (auto || subscribed) ? await kevin.relevant(message) : false;
  if (!pinged && !relevant) return;

  const stopTyping = slack.startTyping(message.channel, message.thread_ts);
  const typingStarted = Date.now();
  try {
    const reply = await kevin.respond(message);
    if (!reply) return;
    const humanTypingTime = Math.min(4_500, 500 + reply.length * 12 + Math.random() * 700);
    const remaining = humanTypingTime - (Date.now() - typingStarted);
    if (remaining > 0) await new Promise((resolve) => setTimeout(resolve, remaining));
    const sent = await slack.post(message.channel, reply, message.thread_ts);
    if (sent.ts) remember(`${message.channel}:${sent.ts}`);
    console.log(`Replied in ${message.channel} to ${message.ts} (${pinged ? "ping" : "auto"})`);
  } finally {
    stopTyping();
  }
});

const shutdown = async () => {
  await slack.stop();
  process.exit(0);
};
process.once("SIGINT", shutdown);
process.once("SIGTERM", shutdown);

await slack.start();
