import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createLogger, describeError, getLogLevel, preview, sanitize, setLogFormat, setLogLevel, REDACTED } from "../src/logger.js";

const capture = () => {
  const lines: string[] = [];
  const spies = [
    vi.spyOn(console, "log").mockImplementation((line: string) => void lines.push(line)),
    vi.spyOn(console, "warn").mockImplementation((line: string) => void lines.push(line)),
    vi.spyOn(console, "error").mockImplementation((line: string) => void lines.push(line)),
  ];
  return { lines, restore: () => spies.forEach((spy) => spy.mockRestore()) };
};

beforeEach(() => {
  setLogLevel("info");
  setLogFormat("text");
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("log levels", () => {
  it("emits at or above the configured level and drops the rest", () => {
    setLogLevel("warn");
    const { lines, restore } = capture();
    const log = createLogger("test");
    log.error("boom");
    log.warn("careful");
    log.info("hello");
    log.debug("details");
    restore();

    expect(lines.map((line) => line.split(" ")[1])).toEqual(["ERROR", "WARN"]);
    expect(lines.every((line) => line.includes("[test]"))).toBe(true);
  });

  it("keeps the current level when an unknown one is requested", () => {
    setLogLevel("debug");
    expect(setLogLevel("chatty")).toBe("debug");
    expect(getLogLevel()).toBe("debug");
  });
});

describe("formatting", () => {
  it("writes key=value fields in text mode and JSON objects in json mode", () => {
    const text = capture();
    createLogger("slack").info("Posted a message", { channel: "C1", ms: 12, note: "two words" });
    text.restore();
    expect(text.lines[0]).toContain('[slack] Posted a message channel=C1 ms=12 note="two words"');

    setLogFormat("json");
    const json = capture();
    createLogger("slack").info("Posted a message", { channel: "C1", ms: 12 });
    json.restore();
    expect(JSON.parse(json.lines[0]!)).toMatchObject({ level: "info", scope: "slack", message: "Posted a message", channel: "C1", ms: 12 });
  });

  it("scopes and binds fields through child and with", () => {
    const { lines, restore } = capture();
    createLogger("slack").child("gateway", { attempt: 1 }).with({ channel: "C1" }).info("connected");
    restore();
    expect(lines[0]).toContain("[slack.gateway] connected attempt=1 channel=C1");
  });
});

describe("redaction", () => {
  it("hides secret-looking field names and values", () => {
    expect(sanitize({ slackToken: "xoxc-1234567890", cookie: "d=abc", nested: { apiKey: "k" } })).toEqual({
      slackToken: REDACTED,
      cookie: REDACTED,
      nested: { apiKey: REDACTED },
    });
    expect(sanitize({ url: "https://x/?token=v", detail: "auth failed for xoxd-0987654321abcdef" })).toEqual({
      url: "https://x/?token=v",
      detail: `auth failed for ${REDACTED}`,
    });
    expect(sanitize({ header: "Bearer sk-abcdefghijklmnop" })).toEqual({ header: REDACTED });
  });

  it("keeps ordinary fields that merely look secret-adjacent", () => {
    expect(sanitize({ maxTokens: 1024, promptTokens: 12, monkey: "yes" })).toEqual({ maxTokens: 1024, promptTokens: 12, monkey: "yes" });
  });

  it("redacts secrets inside logged lines", () => {
    const { lines, restore } = capture();
    createLogger("test").error("auth failed", { detail: "cookie d=abcdefghijklmnopqrstuvwxyz rejected" });
    restore();
    expect(lines[0]).not.toContain("abcdefghijklmnopqrstuvwxyz");
    expect(lines[0]).toContain(REDACTED);
  });
});

describe("value handling", () => {
  it("truncates long strings and bounds arrays and depth", () => {
    expect(preview("x".repeat(50), 10)).toBe(`${"x".repeat(10)}…(+40)`);
    const long = sanitize({ text: "y".repeat(900) }) as { text: string };
    expect(long.text).toContain("…(+400 chars)");
    const many = sanitize({ items: Array.from({ length: 25 }, (_, index) => index) }) as { items: unknown[] };
    expect(many.items).toHaveLength(21);
    expect(many.items.at(-1)).toBe("…(+5 more)");
  });

  it("flattens errors, causes, and error codes", () => {
    const error = Object.assign(new Error("nope", { cause: new Error("root") }), { code: "ENOENT" });
    const fields = describeError(error);
    expect(fields).toMatchObject({ error: "nope", errorType: "Error", errorCode: "ENOENT", cause: "root" });
    expect(String(fields.stack)).toContain("Error: nope");
    expect(describeError("plain string")).toEqual({ error: "plain string" });
  });

  it("prints the stack of a failure on its own line", () => {
    const { lines, restore } = capture();
    createLogger("test").failure("Conversation failed", new Error("bad"), { conversation: "C1" });
    restore();
    expect(lines[0]).toContain('[test] Conversation failed conversation=C1 error=bad errorType=Error');
    expect(lines[0]).toContain("\n");
    expect(lines[0]).toContain("Error: bad");
  });
});

describe("track", () => {
  it("times successes at debug level and reports failures as errors", async () => {
    setLogLevel("debug");
    const { lines, restore } = capture();
    const log = createLogger("slack.api");
    await log.track("conversations.history", async () => ({ messages: [1, 2] }), { channel: "C1" }, (result) => ({ messages: result.messages.length }));
    await expect(log.track("chat.postMessage", async () => { throw new Error("rate limited"); }, { channel: "C1" })).rejects.toThrow("rate limited");
    restore();

    expect(lines[0]).toContain("[slack.api] conversations.history channel=C1 messages=2 ms=");
    expect(lines[1]).toContain("[slack.api] chat.postMessage failed channel=C1 ms=");
    expect(lines[1]).toContain("error=\"rate limited\"");
  });
});
