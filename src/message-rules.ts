const mention = (userId: string) => `<@${userId}(?:\\|[^>]+)?>`;

export const isIgnoredMessage = (text = "") => text.trimStart().startsWith("##");
export const isBotMessage = ({ bot_id, subtype }: { bot_id?: string; subtype?: string }) => Boolean(bot_id || subtype === "bot_message");
export const isMentioned = (text: string, userId: string) => new RegExp(mention(userId)).test(text);
export const isStopCommand = (text: string, userId: string) => new RegExp(`${mention(userId)}\\s*!stop(?:\\s|$)`, "i").test(text);
export const shouldConsiderMessage = ({ pinged, dm, autoMode }: { pinged: boolean; dm: boolean; autoMode: boolean }) => pinged || dm || autoMode;
export const shouldClassifyRelevance = ({ pinged, dm, autoMode }: { pinged: boolean; dm: boolean; autoMode: boolean }) => !pinged && !dm && autoMode;
