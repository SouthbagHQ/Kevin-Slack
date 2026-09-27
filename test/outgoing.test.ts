import { describe, expect, it } from "vitest";
import { formatOutgoing, MAX_OUTGOING_CHARS } from "../src/outgoing.js";

describe("formatOutgoing", () => {
  it("defuses channel-wide notifications in both Slack and plain form", () => {
    const text = formatOutgoing("<!channel> fees are due. <!here|here> too. Also @everyone and email@here.com");
    expect(text).not.toMatch(/<!(channel|here|everyone)/);
    expect(text).not.toMatch(/(^|\s)@(channel|here|everyone)\b/);
    expect(text).toContain("email@here.com");
  });

  it("keeps user and user-group mentions", () => {
    expect(formatOutgoing("<@U123> and <!subteam^S123>")).toBe("<@U123> and <!subteam^S123>");
  });

  it("rewrites Markdown as Slack mrkdwn outside code", () => {
    expect(formatOutgoing("## Notice\n**Fee** is __due__, ~~waived~~. See [policy](https://example.com/p).")).toBe(
      "*Notice*\n*Fee* is _due_, ~waived~. See <https://example.com/p|policy>.",
    );
    expect(formatOutgoing("Run `**raw**` then\n```\n**also raw**\n```")).toBe("Run `**raw**` then\n```\n**also raw**\n```");
  });

  it("drops a leading Kevin speaker label", () => {
    expect(formatOutgoing("**Kevin:** Denied.")).toBe("Denied.");
    expect(formatOutgoing("Kevin: Denied.")).toBe("Denied.");
    expect(formatOutgoing("Kevin knows.")).toBe("Kevin knows.");
  });

  it("caps length at a word boundary", () => {
    const text = formatOutgoing("fee ".repeat(1_000));
    expect(text.length).toBeLessThanOrEqual(MAX_OUTGOING_CHARS);
    expect(text.endsWith("fee…")).toBe(true);
  });

  it("returns an empty string for whitespace", () => {
    expect(formatOutgoing("  \n ")).toBe("");
  });
});
