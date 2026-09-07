const mention = (userId: string) => `<@${userId}(?:\\|[^>]+)?>`;

/** Slack message subtypes Kevin may treat as conversational events (beyond plain messages). */
const RESPONDABLE_SUBTYPES = new Set([
  "file_share",
  "bot_message",
  "channel_topic",
  "channel_purpose",
  "channel_name",
]);

export const isIgnoredMessage = (text = "") => text.trimStart().startsWith("##");
export const isBotMessage = ({ bot_id, subtype }: { bot_id?: string; subtype?: string }) => Boolean(bot_id || subtype === "bot_message");
export const isRespondableMessage = ({ subtype }: { subtype?: string }) => !subtype || RESPONDABLE_SUBTYPES.has(subtype);
export const isMentioned = (text: string, userId: string) => new RegExp(mention(userId)).test(text);
export const isStopCommand = (text: string, userId: string) => new RegExp(`${mention(userId)}\\s*!stop(?:\\s|$)`, "i").test(text);
export const shouldConsiderMessage = ({ pinged, dm, autoMode }: { pinged: boolean; dm: boolean; autoMode: boolean }) => pinged || dm || autoMode;
export const shouldClassifyRelevance = ({ pinged, dm, autoMode }: { pinged: boolean; dm: boolean; autoMode: boolean }) => !pinged && !dm && autoMode;
