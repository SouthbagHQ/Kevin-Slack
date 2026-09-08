import "dotenv/config";

const required = (name: string, fallback?: string) => {
  const value = process.env[name] ?? fallback;
  if (!value) throw new Error(`Missing ${name}`);
  return value;
};

export const config = {
  hackClubAiKey: required("HACKCLUB_AI_KEY", process.env.HACK_CLUB_AI_KEY),
  slackToken: required("SLACK_XOXC"),
  slackCookie: required("SLACK_XOXD"),
  slackCookieS: process.env.SLACK_XOXD_S,
  channelModesFile: process.env.CHANNEL_MODES_FILE ?? "./data/channel-modes.json",
  memoryFile: process.env.MEMORY_FILE ?? "./data/memory.json",
  memoryContextLimit: Number.isFinite(Number(process.env.MEMORY_CONTEXT_LIMIT ?? 24))
    ? Math.min(100, Math.max(1, Number(process.env.MEMORY_CONTEXT_LIMIT ?? 24)))
    : 24,
  threadMutesFile: process.env.THREAD_MUTES_FILE ?? "./data/thread-mutes.json",
  queueConcurrency: Number(process.env.QUEUE_CONCURRENCY ?? 4),
  messageDebounceMs: Number(process.env.MESSAGE_DEBOUNCE_MS ?? 900),
  maxBatchMessages: Number(process.env.MAX_BATCH_MESSAGES ?? 20),
  maxPendingBatches: Number(process.env.MAX_PENDING_BATCHES ?? 50),
  maxBotExchanges: Number(process.env.MAX_BOT_EXCHANGES ?? 10),
  logLevel: process.env.LOG_LEVEL ?? "info",
  replyModel: "google/gemini-3.7-flash",
  classifierModel: "google/gemini-3.5-flash-lite",
};
