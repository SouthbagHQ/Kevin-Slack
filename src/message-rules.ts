const mention = (userId: string) => `<@${userId}(?:\\|[^>]+)?>`;

export const isIgnoredMessage = (text = "") => text.trimStart().startsWith("##");
export const isMentioned = (text: string, userId: string) => new RegExp(mention(userId)).test(text);
export const isStopCommand = (text: string, userId: string) => new RegExp(`${mention(userId)}\\s*!stop(?:\\s|$)`, "i").test(text);
