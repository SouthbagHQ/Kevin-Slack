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
  autoChannel: process.env.AUTO_CHANNEL ?? "C0BQG11SC8P",
  memoryFile: process.env.MEMORY_FILE ?? "./data/memory.json",
  threadMutesFile: process.env.THREAD_MUTES_FILE ?? "./data/thread-mutes.json",
  logLevel: process.env.LOG_LEVEL ?? "info",
  replyModel: "google/gemini-3.5-flash",
  classifierModel: "google/gemini-3.5-flash-lite",
};
