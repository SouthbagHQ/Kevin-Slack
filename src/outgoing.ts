/** Hard ceiling for any message Kevin posts; the prompt asks for far less. */
export const MAX_OUTGOING_CHARS = 2000;

const SPECIAL_MENTION = /<!(channel|here|everyone)(?:\|[^>]*)?>/gi;
const PLAIN_MENTION = /(^|[^\w<])@(channel|here|everyone)\b/gi;
const SPEAKER_LABEL = /^\s*(?:\*\*|\*|_)?Kevin(?:\*\*|\*|_)?\s*:(?:\*\*|\*|_)?\s*/;
const CODE = /(```[\s\S]*?```|`[^`\n]*`)/;

/** Standard Markdown the model tends to write, rewritten as Slack mrkdwn. */
const toMrkdwn = (text: string) => text
  .replace(/\[([^\]\n]+)\]\((https?:\/\/[^)\s]+)\)/g, "<$2|$1>")
  .replace(/\*\*([^*\n]+)\*\*/g, "*$1*")
  .replace(/__([^_\n]+)__/g, "_$1_")
  .replace(/~~([^~\n]+)~~/g, "~$1~")
  .replace(/^#{1,6}[ \t]+(.+)$/gm, "*$1*");

const truncate = (text: string) => {
  if (text.length <= MAX_OUTGOING_CHARS) return text;
  const cut = text.slice(0, MAX_OUTGOING_CHARS - 1);
  const space = cut.search(/\s\S*$/);
  return `${(space > MAX_OUTGOING_CHARS / 2 ? cut.slice(0, space) : cut).trimEnd()}…`;
};

/**
 * The single cleanup every outgoing message passes through: no channel-wide
 * notifications, Slack formatting instead of Markdown (code left untouched),
 * no "Kevin:" speaker label, and a hard length cap.
 */
export const formatOutgoing = (raw: string) => {
  const formatted = raw
    .replace(SPEAKER_LABEL, "")
    .split(CODE)
    .map((part, index) => (index % 2 ? part : toMrkdwn(part)))
    .join("")
    .replace(SPECIAL_MENTION, "@⁠$1")
    .replace(PLAIN_MENTION, "$1@⁠$2")
    .trim();
  return truncate(formatted);
};
