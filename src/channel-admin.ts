import { ChannelModes } from "./channel-modes.js";

const channelId = (value: unknown): value is string => typeof value === "string" && /^[CG][A-Z0-9]+$/.test(value);
const userId = (value: unknown): value is string => typeof value === "string" && /^U[A-Z0-9]+$/.test(value);
const channelText = (value: unknown): value is string => typeof value === "string" && value.length <= 250;

const requireKevinManager = async (
  managersFor: (channel: string) => Promise<string[]>,
  kevinId: string | undefined,
  channel: unknown,
  failure: string,
) => {
  if (!kevinId) return { ok: false as const, error: `Kevin could not be identified. ${failure}` };
  if (!channelId(channel)) return { ok: false as const, error: `A valid Slack channel ID is required. ${failure}` };
  if (!(await managersFor(channel)).includes(kevinId)) {
    return { ok: false as const, error: `Kevin is not a manager of that channel. ${failure}` };
  }
  return { ok: true as const, channel };
};

export const setChannelAutoMode = async (
  managersFor: (channel: string) => Promise<string[]>,
  modes: ChannelModes,
  requester: string | undefined,
  channel: unknown,
  enabled: unknown,
) => {
  if (!requester) return { ok: false, error: "The requester could not be identified. Auto mode was not changed." };
  if (!channelId(channel) || typeof enabled !== "boolean") {
    return { ok: false, error: "A valid Slack channel ID and explicit mode are required. Auto mode was not changed." };
  }
  if (!(await managersFor(channel)).includes(requester)) {
    return { ok: false, error: "The requester is not a manager of that channel. Auto mode was not changed." };
  }
  await modes.set(channel, enabled);
  return { ok: true, channel, enabled };
};

export const removeChannelMember = async (
  managersFor: (channel: string) => Promise<string[]>,
  kick: (channel: string, user: string) => Promise<void>,
  kevinId: string | undefined,
  channel: unknown,
  user: unknown,
) => {
  const allowed = await requireKevinManager(managersFor, kevinId, channel, "The user was not removed.");
  if (!allowed.ok) return allowed;
  if (!userId(user)) return { ok: false, error: "A valid Slack user ID is required. The user was not removed." };
  if (user === kevinId) return { ok: false, error: "Kevin cannot remove Himself from a channel." };
  await kick(allowed.channel, user);
  return { ok: true, channel: allowed.channel, user };
};

export const setChannelTopic = async (
  managersFor: (channel: string) => Promise<string[]>,
  setTopic: (channel: string, topic: string) => Promise<void>,
  kevinId: string | undefined,
  channel: unknown,
  topic: unknown,
) => {
  const allowed = await requireKevinManager(managersFor, kevinId, channel, "The topic was not changed.");
  if (!allowed.ok) return allowed;
  if (!channelText(topic)) {
    return { ok: false, error: "A topic of at most 250 characters is required. The topic was not changed." };
  }
  await setTopic(allowed.channel, topic);
  return { ok: true, channel: allowed.channel, topic };
};

export const setChannelDescription = async (
  managersFor: (channel: string) => Promise<string[]>,
  setDescription: (channel: string, description: string) => Promise<void>,
  kevinId: string | undefined,
  channel: unknown,
  description: unknown,
) => {
  const allowed = await requireKevinManager(managersFor, kevinId, channel, "The description was not changed.");
  if (!allowed.ok) return allowed;
  if (!channelText(description)) {
    return { ok: false, error: "A description of at most 250 characters is required. The description was not changed." };
  }
  await setDescription(allowed.channel, description);
  return { ok: true, channel: allowed.channel, description };
};
