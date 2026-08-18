import { ChannelModes } from "./channel-modes.js";

export const setChannelAutoMode = async (
  managersFor: (channel: string) => Promise<string[]>,
  modes: ChannelModes,
  requester: string | undefined,
  channel: unknown,
  enabled: unknown,
) => {
  if (!requester) return { ok: false, error: "The requester could not be identified. Auto mode was not changed." };
  if (typeof channel !== "string" || !/^[CG][A-Z0-9]+$/.test(channel) || typeof enabled !== "boolean") {
    return { ok: false, error: "A valid Slack channel ID and explicit mode are required. Auto mode was not changed." };
  }
  if (!(await managersFor(channel)).includes(requester)) {
    return { ok: false, error: "The requester is not a manager of that channel. Auto mode was not changed." };
  }
  await modes.set(channel, enabled);
  return { ok: true, channel, enabled };
};
