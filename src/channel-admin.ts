import { ChannelModes } from "./channel-modes.js";
import { createLogger, preview } from "./logger.js";

const log = createLogger("channel-admin");

const channelId = (value: unknown): value is string => typeof value === "string" && /^[CG][A-Z0-9]+$/.test(value);
const userId = (value: unknown): value is string => typeof value === "string" && /^U[A-Z0-9]+$/.test(value);
const channelText = (value: unknown): value is string => typeof value === "string" && value.length <= 250;

/** Logs and returns a refusal so every denied privileged action leaves a trace. */
const deny = (action: string, reason: string, error: string, fields: Record<string, unknown>) => {
  log.warn(`${action} denied`, { ...fields, reason });
  return { ok: false as const, error };
};

const requireKevinManager = async (
  managersFor: (channel: string) => Promise<string[]>,
  kevinId: string | undefined,
  channel: unknown,
  failure: string,
  action: string,
) => {
  if (!kevinId) return deny(action, "kevin-unidentified", `Kevin could not be identified. ${failure}`, { channel });
  if (!channelId(channel)) return deny(action, "invalid-channel", `A valid Slack channel ID is required. ${failure}`, { channel: preview(channel, 40) });
  const managers = await managersFor(channel);
  if (!managers.includes(kevinId)) {
    return deny(action, "kevin-not-manager", `Kevin is not a manager of that channel. ${failure}`, { channel, kevinId, managers: managers.length });
  }
  log.debug(`${action} authorized`, { channel, kevinId, managers: managers.length });
  return { ok: true as const, channel };
};

export const setChannelAutoMode = async (
  managersFor: (channel: string) => Promise<string[]>,
  modes: ChannelModes,
  requester: string | undefined,
  channel: unknown,
  enabled: unknown,
) => {
  const action = "set_channel_auto_mode";
  log.debug(`${action} requested`, { channel: preview(channel, 40), enabled, requester });
  if (!requester) return deny(action, "requester-unidentified", "The requester could not be identified. Auto mode was not changed.", { channel: preview(channel, 40) });
  if (!channelId(channel) || typeof enabled !== "boolean") {
    return deny(action, "invalid-arguments", "A valid Slack channel ID and explicit mode are required. Auto mode was not changed.", { channel: preview(channel, 40), enabled, requester });
  }
  const managers = await managersFor(channel);
  if (!managers.includes(requester)) {
    return deny(action, "requester-not-manager", "The requester is not a manager of that channel. Auto mode was not changed.", { channel, requester, managers: managers.length });
  }
  await modes.set(channel, enabled);
  log.info(`${action} applied`, { channel, enabled, requester });
  return { ok: true, channel, enabled };
};

export const removeChannelMember = async (
  managersFor: (channel: string) => Promise<string[]>,
  kick: (channel: string, user: string) => Promise<void>,
  kevinId: string | undefined,
  channel: unknown,
  user: unknown,
) => {
  const action = "remove_channel_member";
  log.debug(`${action} requested`, { channel: preview(channel, 40), user: preview(user, 40) });
  const allowed = await requireKevinManager(managersFor, kevinId, channel, "The user was not removed.", action);
  if (!allowed.ok) return allowed;
  if (!userId(user)) return deny(action, "invalid-user", "A valid Slack user ID is required. The user was not removed.", { channel: allowed.channel, user: preview(user, 40) });
  if (user === kevinId) return deny(action, "self-removal", "Kevin cannot remove Himself from a channel.", { channel: allowed.channel, user });
  await kick(allowed.channel, user);
  log.info(`${action} applied`, { channel: allowed.channel, user });
  return { ok: true, channel: allowed.channel, user };
};

/** Any channel member may change the topic or description unless the workspace restricts it; Slack enforces that, not Kevin's manager role. */
const setChannelText = async (
  action: string,
  field: "topic" | "description",
  apply: (channel: string, text: string) => Promise<void>,
  channel: unknown,
  text: unknown,
) => {
  log.debug(`${action} requested`, { channel: preview(channel, 40), [field]: preview(text, 120) });
  const failure = `The ${field} was not changed.`;
  if (!channelId(channel)) return deny(action, "invalid-channel", `A valid Slack channel ID is required. ${failure}`, { channel: preview(channel, 40) });
  if (!channelText(text)) {
    return deny(action, `invalid-${field}`, `A ${field} of at most 250 characters is required. ${failure}`, { channel, [field]: preview(text, 120) });
  }
  await apply(channel, text);
  log.info(`${action} applied`, { channel, [field]: preview(text, 120) });
  return { ok: true, channel, [field]: text };
};

export const setChannelTopic = (setTopic: (channel: string, topic: string) => Promise<void>, channel: unknown, topic: unknown) =>
  setChannelText("set_channel_topic", "topic", setTopic, channel, topic);

export const setChannelDescription = (setDescription: (channel: string, description: string) => Promise<void>, channel: unknown, description: unknown) =>
  setChannelText("set_channel_description", "description", setDescription, channel, description);
