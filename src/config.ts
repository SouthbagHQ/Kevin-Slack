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
  channelModesFile: process.env.CHANNEL_MODES_FILE ?? "./data/channel-modes.json",
  memoryFile: process.env.MEMORY_FILE ?? "./data/memory.json",
  threadMutesFile: process.env.THREAD_MUTES_FILE ?? "./data/thread-mutes.json",
  chromePath: process.env.CHROME_PATH ?? "/usr/bin/chromium",
  chimeMediaRegion: process.env.CHIME_MEDIA_REGION ?? "ap-southeast-2",
  huddleSilenceMs: Number(process.env.HUDDLE_SILENCE_MS ?? 900),
  sttModel: process.env.STT_MODEL ?? "qwen/qwen3-asr-0.6b",
  ttsModel: process.env.TTS_MODEL ?? "hexgrad/kokoro-82m",
  ttsVoice: process.env.TTS_VOICE ?? "alloy",
  logLevel: process.env.LOG_LEVEL ?? "info",
  replyModel: "google/gemini-3.5-flash",
  classifierModel: "google/gemini-3.5-flash-lite",
};
