/** Tracks consecutive Kevin↔bot replies with no human in between, per conversation. */
export class BotExchanges {
  private counts = new Map<string, number>();

  constructor(readonly max: number) {}

  count(key: string) {
    return this.counts.get(key) ?? 0;
  }

  atLimit(key: string) {
    return this.count(key) >= this.max;
  }

  noteHuman(key: string) {
    this.counts.delete(key);
  }

  noteBotReply(key: string) {
    this.counts.set(key, this.count(key) + 1);
  }
}

/** Scope for the bot-loop counter: thread, DM, or whole channel (top-level). */
export const botExchangeKey = (message: { channel: string; thread_ts?: string }) => {
  if (message.thread_ts) return `${message.channel}:thread:${message.thread_ts}`;
  if (message.channel.startsWith("D")) return `${message.channel}:dm`;
  return `${message.channel}:channel`;
};
