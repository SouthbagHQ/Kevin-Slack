import { describe, expect, it } from "vitest";
import { BotExchanges, botExchangeKey } from "../src/bot-exchanges.js";

describe("botExchangeKey", () => {
  it("scopes by thread, DM, or channel", () => {
    expect(botExchangeKey({ channel: "C1", thread_ts: "123.4" })).toBe("C1:thread:123.4");
    expect(botExchangeKey({ channel: "D9" })).toBe("D9:dm");
    expect(botExchangeKey({ channel: "C1" })).toBe("C1:channel");
  });
});

describe("BotExchanges", () => {
  it("caps consecutive bot replies until a human resets the streak", () => {
    const exchanges = new BotExchanges(10);
    const key = "C1:thread:1";

    for (let i = 0; i < 10; i++) {
      expect(exchanges.atLimit(key)).toBe(false);
      exchanges.noteBotReply(key);
    }
    expect(exchanges.count(key)).toBe(10);
    expect(exchanges.atLimit(key)).toBe(true);

    exchanges.noteHuman(key);
    expect(exchanges.count(key)).toBe(0);
    expect(exchanges.atLimit(key)).toBe(false);
  });
});
