import { KevinAgent } from "./agent.js";
import { config } from "./config.js";
import { MemoryStore } from "./memory.js";
import { Slack } from "./slack.js";

const slack = new Slack(config.slackToken, config.slackCookie, config.slackCookieS);
const kevin = new KevinAgent(slack, new MemoryStore(config.memoryFile));
const seen = new Set<string>();

const remember = (key: string) => {
  seen.add(key);
  if (seen.size > 2_000) seen.delete(seen.values().next().value!);
};

const { userId, team } = await slack.identity();
console.log(`Kevin connected to ${team ?? "Slack"} as ${userId}; auto mode: ${config.autoChannel}`);

slack.onMessage(async (message) => {
  if (!message.channel || !message.ts || !message.text || message.hidden || message.user === userId) return;
  if (message.subtype && message.subtype !== "bot_message") return;

  const key = `${message.channel}:${message.ts}`;
  if (seen.has(key)) return;
  remember(key);

  const pinged = message.text.includes(`<@${userId}>`);
  const auto = message.channel === config.autoChannel;
  if (!pinged && !auto) return;

  const relevant = auto ? await kevin.relevant(message) : false;
  if (!pinged && !relevant) return;

  const stopTyping = slack.startTyping(message.channel);
  try {
    const reply = await kevin.respond(message);
    if (!reply) return;
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
