import { describe, expect, it } from "vitest";
import { isIgnoredMessage, isMentioned, isStopCommand } from "../src/message-rules.js";

describe("message rules", () => {
  it("ignores messages beginning with ##", () => {
    expect(isIgnoredMessage("## quiet")).toBe(true);
    expect(isIgnoredMessage("  ## quiet")).toBe(true);
    expect(isIgnoredMessage("message ## visible")).toBe(false);
  });

  it("recognizes pings and both stop forms", () => {
    expect(isMentioned("hello <@U123>", "U123")).toBe(true);
    expect(isStopCommand("<@U123>!stop", "U123")).toBe(true);
    expect(isStopCommand("<@U123> !stop", "U123")).toBe(true);
    expect(isStopCommand("<@U123> hello", "U123")).toBe(false);
  });
});
