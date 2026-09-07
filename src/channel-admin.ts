import { ChannelModes } from "./channel-modes.js";

const channelId = (value: unknown): value is string => typeof value === "string" && /^[CG][A-Z0-9]+$/.test(value);
const userId = (value: unknown): value is string => typeof value === "string" && /^U[A-Z0-9]+$/.test(value);

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
  if (!kevinId) return { ok: false, error: "Kevin could not be identified. The user was not removed." };
  if (!channelId(channel) || !userId(user)) {
    return { ok: false, error: "A valid Slack channel ID and user ID are required. The user was not removed." };
  }
  if (user === kevinId) return { ok: false, error: "Kevin cannot remove Himself from a channel." };
  if (!(await managersFor(channel)).includes(kevinId)) {
    return { ok: false, error: "Kevin is not a manager of that channel. The user was not removed." };
  }
  await kick(channel, user);
  return { ok: true, channel, user };
};
