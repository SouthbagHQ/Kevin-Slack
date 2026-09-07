const mention = (userId: string) => `<@${userId}(?:\\|[^>]+)?>`;

/** Slack message subtypes Kevin may treat as conversational events (beyond plain messages). */
const RESPONDABLE_SUBTYPES = new Set([
  "file_share",
  "bot_message",
  "channel_topic",
  "channel_purpose",
  "channel_name",
]);

const MESSAGE_KINDS = new Set([
  "message",
  "ephemeral",
  "file_share",
  "bot_message",
  "channel_topic",
  "channel_purpose",
  "channel_name",
]);

export type MessageTypeContext = {
  kind: string;
  visibility: "channel" | "ephemeral";
  fromBot: boolean;
  inThread: boolean;
  subtype?: string;
  note?: string;
};

export const isIgnoredMessage = (text = "") => text.trimStart().startsWith("##");
export const isBotMessage = ({ bot_id, subtype }: { bot_id?: string; subtype?: string }) => Boolean(bot_id || subtype === "bot_message");
export const isEphemeralMessage = ({ is_ephemeral }: { is_ephemeral?: boolean }) => Boolean(is_ephemeral);
export const isRespondableMessage = ({ subtype }: { subtype?: string }) => !subtype || RESPONDABLE_SUBTYPES.has(subtype);
export const isMentioned = (text: string, userId: string) => new RegExp(mention(userId)).test(text);
export const isStopCommand = (text: string, userId: string) => new RegExp(`${mention(userId)}\\s*!stop(?:\\s|$)`, "i").test(text);
export const shouldConsiderMessage = ({ pinged, dm, autoMode }: { pinged: boolean; dm: boolean; autoMode: boolean }) => pinged || dm || autoMode;
export const shouldClassifyRelevance = ({ pinged, dm, autoMode }: { pinged: boolean; dm: boolean; autoMode: boolean }) => !pinged && !dm && autoMode;

/** Structured type/visibility context for the model (current message and history). */
export const describeMessageType = (message: {
  subtype?: string;
  is_ephemeral?: boolean;
  bot_id?: string;
  thread_ts?: string;
}): MessageTypeContext => {
  const ephemeral = isEphemeralMessage(message);
  const fromBot = isBotMessage(message);
  const subtype = message.subtype;
  let kind = "message";
  if (ephemeral) kind = "ephemeral";
  else if (subtype && MESSAGE_KINDS.has(subtype)) kind = subtype;
  else if (fromBot) kind = "bot_message";
  else if (subtype) kind = subtype;

  return {
    kind,
    visibility: ephemeral ? "ephemeral" : "channel",
    fromBot,
    inThread: Boolean(message.thread_ts),
    ...(subtype ? { subtype } : {}),
    ...(ephemeral
      ? { note: "Only visible to Kevin in this channel; not stored in channel history for others" }
      : {}),
  };
};
