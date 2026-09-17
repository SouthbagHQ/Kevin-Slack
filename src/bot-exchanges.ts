import { createLogger } from "./logger.js";

const log = createLogger("bot-exchanges");

/** Tracks consecutive Kevin↔bot replies with no human in between, per conversation. */
export class BotExchanges {
  private counts = new Map<string, number>();

  constructor(readonly max: number) {}

  count(key: string) {
    return this.counts.get(key) ?? 0;
  }

  atLimit(key: string) {
    const limited = this.count(key) >= this.max;
    if (limited) log.debug("Bot exchange cap reached", { conversation: key, count: this.count(key), max: this.max });
    return limited;
  }

  noteHuman(key: string) {
    const previous = this.count(key);
    this.counts.delete(key);
    if (previous) log.debug("Bot exchange counter reset by a human message", { conversation: key, previous, max: this.max });
  }

  noteBotReply(key: string) {
    const count = this.count(key) + 1;
    this.counts.set(key, count);
    log.debug("Bot exchange counted", { conversation: key, count, max: this.max, tracked: this.counts.size });
  }
}

/** Scope for the bot-loop counter: thread, DM, or whole channel (top-level). */
export const botExchangeKey = (message: { channel: string; thread_ts?: string }) => {
  if (message.thread_ts) return `${message.channel}:thread:${message.thread_ts}`;
  if (message.channel.startsWith("D")) return `${message.channel}:dm`;
  return `${message.channel}:channel`;
};
