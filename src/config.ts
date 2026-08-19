import "dotenv/config";

const required = (name: string, fallback?: string) => {
  const value = process.env[name] ?? fallback;
  if (!value) throw new Error(`Missing ${name}`);
  return value;
};

export const config = {
  openRouterKey: required("OPENROUTER_KEY", process.env.OPENROUTER_API_KEY),
  slackToken: required("SLACK_XOXC"),
  slackCookie: required("SLACK_XOXD"),
  slackCookieS: process.env.SLACK_XOXD_S,
  channelModesFile: process.env.CHANNEL_MODES_FILE ?? "./data/channel-modes.json",
  memoryFile: process.env.MEMORY_FILE ?? "./data/memory.json",
  threadMutesFile: process.env.THREAD_MUTES_FILE ?? "./data/thread-mutes.json",
  queueConcurrency: Number(process.env.QUEUE_CONCURRENCY ?? 4),
  messageDebounceMs: Number(process.env.MESSAGE_DEBOUNCE_MS ?? 900),
  maxBatchMessages: Number(process.env.MAX_BATCH_MESSAGES ?? 20),
  maxPendingBatches: Number(process.env.MAX_PENDING_BATCHES ?? 50),
  logLevel: process.env.LOG_LEVEL ?? "info",
  replyModel: "google/gemini-3.5-flash",
  classifierModel: "google/gemini-3.5-flash-lite",
};
