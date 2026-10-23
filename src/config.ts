import "dotenv/config";

const required = (name: string, fallback?: string) => {
  const value = process.env[name] ?? fallback;
  if (!value) throw new Error(`Missing ${name}`);
  return value;
};

export const config = {
  hackClubAiKey: required("HACKCLUB_AI_KEY", process.env.HACK_CLUB_AI_KEY),
  openRouterKey: required("OPENROUTER_KEY", process.env.OPENROUTER_API_KEY),
  slackToken: required("SLACK_XOXC"),
  slackCookie: required("SLACK_XOXD"),
  slackCookieS: process.env.SLACK_XOXD_S,
  channelModesFile: process.env.CHANNEL_MODES_FILE ?? "./data/channel-modes.json",
  memoryFile: process.env.MEMORY_FILE ?? "./data/memory.json",
  memoryPromptChars: Number(process.env.MEMORY_PROMPT_CHARS ?? 24_000),
  threadMutesFile: process.env.THREAD_MUTES_FILE ?? "./data/thread-mutes.json",
  huddleFmUserId: process.env.HUDDLEFM_USER_ID?.trim() || undefined,
  huddleFmFile: process.env.HUDDLEFM_FILE ?? "./data/huddlefm.json",
  queueConcurrency: Number(process.env.QUEUE_CONCURRENCY ?? 4),
  messageDebounceMs: Number(process.env.MESSAGE_DEBOUNCE_MS ?? 900),
  maxBatchMessages: Number(process.env.MAX_BATCH_MESSAGES ?? 20),
  maxPendingBatches: Number(process.env.MAX_PENDING_BATCHES ?? 50),
  maxBotExchanges: Number(process.env.MAX_BOT_EXCHANGES ?? 10),
  huddles: !/^(off|false|0|no)$/i.test(process.env.HUDDLES ?? "on"),
  huddleAcceptInvites: !/^(off|false|0|no)$/i.test(process.env.HUDDLE_ACCEPT_INVITES ?? "on"),
  huddleMaxSessions: Number(process.env.HUDDLE_MAX_SESSIONS ?? 2),
  huddleRegion: process.env.CHIME_MEDIA_REGION ?? "ap-southeast-2",
  huddleLanguage: process.env.HUDDLE_LANGUAGE?.trim() || undefined,
  sttModel: process.env.HUDDLE_STT_MODEL ?? "openai/gpt-4o-mini-transcribe",
  ttsModel: process.env.HUDDLE_TTS_MODEL ?? "google/gemini-3.8-flash-lite-tts",
  ttsVoice: process.env.HUDDLE_TTS_VOICE ?? "Charon",
  ttsSampleRate: Number(process.env.HUDDLE_TTS_SAMPLE_RATE ?? 24_000),
  kevinManagers: new Set((process.env.KEVIN_MANAGERS ?? "").split(/[\s,]+/).filter(Boolean)),
  kevinChannel: process.env.KEVIN_CHANNEL?.trim() || undefined,
  kevinChannelCron: process.env.KEVIN_CHANNEL_CRON?.trim() || "17 9-21 * * *",
  kevinChannelChance: Math.min(1, Math.max(0, Number(process.env.KEVIN_CHANNEL_CHANCE ?? 0.35))),
  kevinChannelJitterMinutes: Number(process.env.KEVIN_CHANNEL_JITTER_MINUTES ?? 40),
  kevinChannelUserGroup: process.env.KEVIN_CHANNEL_USER_GROUP?.trim() || undefined,
  kevinChannelTimezone: process.env.KEVIN_CHANNEL_TIMEZONE?.trim() || undefined,
  logLevel: process.env.LOG_LEVEL ?? "info",
  logFormat: process.env.LOG_FORMAT ?? "text",
  replyModel: "google/gemini-3.8-flash",
  classifierModel: "google/gemini-3.5-flash-lite",
};

/** The runtime settings worth printing at startup; never includes credentials. */
export const configSummary = () => ({
  replyModel: config.replyModel,
  classifierModel: config.classifierModel,
  queueConcurrency: config.queueConcurrency,
  messageDebounceMs: config.messageDebounceMs,
  maxBatchMessages: config.maxBatchMessages,
  maxPendingBatches: config.maxPendingBatches,
  maxBotExchanges: config.maxBotExchanges,
  channelModesFile: config.channelModesFile,
  memoryFile: config.memoryFile,
  memoryPromptChars: config.memoryPromptChars,
  threadMutesFile: config.threadMutesFile,
  huddleFm: config.huddleFmUserId ?? "off",
  huddleFmFile: config.huddleFmUserId ? config.huddleFmFile : undefined,
  huddles: config.huddles ? { acceptInvites: config.huddleAcceptInvites, maxSessions: config.huddleMaxSessions, region: config.huddleRegion, sttModel: config.sttModel, ttsModel: config.ttsModel, ttsVoice: config.ttsVoice } : "off",
  kevinManagers: config.kevinManagers.size,
  kevinChannel: config.kevinChannel ? { channel: config.kevinChannel, cron: config.kevinChannelCron, chance: config.kevinChannelChance, jitterMinutes: config.kevinChannelJitterMinutes, userGroup: config.kevinChannelUserGroup ?? "off", timezone: config.kevinChannelTimezone ?? "system" } : "off",
  logLevel: config.logLevel,
  logFormat: config.logFormat,
  openRouterFallback: Boolean(config.openRouterKey),
});
