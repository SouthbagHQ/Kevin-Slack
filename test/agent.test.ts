import { beforeAll, describe, expect, it, vi } from "vitest";
import type { ChatCompletion, ToolCall } from "../src/chat.js";
import type { SlackMessage } from "../src/slack.js";

type AgentModule = typeof import("../src/agent.js");
let KevinAgent: AgentModule["KevinAgent"];

beforeAll(async () => {
  // config.ts requires credentials at import time; none are used because the model and Slack are faked.
  for (const name of ["HACKCLUB_AI_KEY", "OPENROUTER_KEY", "SLACK_XOXC", "SLACK_XOXD"]) process.env[name] ??= "test";
  ({ KevinAgent } = await import("../src/agent.js"));
});

const call = (name: string, args: Record<string, unknown>, id = name): ToolCall => ({ id, type: "function", function: { name, arguments: JSON.stringify(args) } });
const toolTurn = (...tool_calls: ToolCall[]): ChatCompletion => ({ choices: [{ finish_reason: "tool_calls", message: { role: "assistant", content: null, tool_calls } }] });
const textTurn = (content: string): ChatCompletion => ({ choices: [{ finish_reason: "stop", message: { role: "assistant", content } }] });

const message: SlackMessage = { channel: "C1", ts: "10.0", user: "UBOB", text: "Kevin, waive my fee" };

const setup = (...turns: ChatCompletion[]) => {
  const slack = {
    userInfo: vi.fn(async () => ({ id: "UBOB" })),
    channelInfo: vi.fn(async () => ({ id: "C1", name: "general" })),
    history: vi.fn(async () => []),
    replies: vi.fn(async () => []),
    modelMessage: vi.fn((value: SlackMessage) => value),
    openDm: vi.fn(async () => "D9"),
    post: vi.fn(async () => ({ ts: "11.0" })),
    leave: vi.fn(async () => undefined),
  };
  const agent = new KevinAgent(slack as never, { list: async () => [] } as never, {} as never, "UKEVIN");
  const sent: unknown[][] = [];
  const chat = vi.fn(async (request: { tools?: { function: { name: string } }[]; messages: unknown[] }) => {
    sent.push([...request.messages]);
    return turns.shift() ?? textTurn("");
  });
  Object.assign(agent, { ai: { chat } });
  return { agent, slack, chat, sent };
};

describe("KevinAgent.respond", () => {
  it("runs side actions, then ends on respond without another model call", async () => {
    const { agent, slack, chat } = setup(
      toolTurn(call("send_dm", { user: "UMGR", text: "Bob asked." }), call("respond", { text: "Denied.", reactions: [":moneybag:"] })),
    );
    expect(await agent.respond(message)).toEqual({ action: "respond", text: "Denied.", reactions: ["moneybag"], broadcast: false, leaveAfter: [] });
    expect(slack.openDm).toHaveBeenCalledWith("UMGR");
    expect(slack.post).toHaveBeenCalledWith("D9", "Bob asked.");
    expect(chat).toHaveBeenCalledTimes(1);
  });

  it("treats plain text as a reply and empty text as silence", async () => {
    expect(await setup(textTurn(" Noted. ")).agent.respond(message)).toMatchObject({ action: "respond", text: "Noted." });
    expect(await setup(textTurn("")).agent.respond(message)).toMatchObject({ action: "silent" });
  });

  it("returns deliberate silence", async () => {
    const { agent } = setup(toolTurn(call("stay_silent", { reason: "beneath Him" })));
    expect(await agent.respond(message)).toEqual({ action: "silent", reason: "beneath Him", leaveAfter: [] });
  });

  it("reports an invalid final action back to the model instead of ending", async () => {
    const { agent, chat, sent } = setup(toolTurn(call("respond", {})), toolTurn(call("respond", { reactions: ["eyes"] })));
    expect(await agent.respond(message)).toMatchObject({ action: "respond", reactions: ["eyes"] });
    expect(chat).toHaveBeenCalledTimes(2);
    const retried = sent[1]!.at(-1) as { role: string; content: string };
    expect(retried.role).toBe("tool");
    expect(JSON.parse(retried.content)).toHaveProperty("error");
  });

  it("defers leaving the current channel until after the final action", async () => {
    const { agent, slack } = setup(toolTurn(call("leave_channel", { channel: "C1" })), toolTurn(call("respond", { text: "Kevin is leaving." })));
    expect(await agent.respond(message)).toMatchObject({ action: "respond", leaveAfter: ["C1"] });
    expect(slack.leave).not.toHaveBeenCalled();
  });

  it("offers only the final actions on the last round", async () => {
    const lookups = Array.from({ length: 9 }, (_, index) => toolTurn(call("get_channel_info", { channel: "C1" }, `lookup${index}`)));
    const { agent, chat } = setup(...lookups, toolTurn(call("stay_silent", {})));
    expect(await agent.respond(message)).toMatchObject({ action: "silent" });
    expect(chat.mock.calls.at(-1)![0].tools!.map(({ function: { name } }) => name)).toEqual(["respond", "stay_silent"]);
  });
});

describe("KevinAgent in His own channel", () => {
  const own = (...turns: ChatCompletion[]) => {
    const { slack, chat } = setup();
    Object.assign(slack, { displayName: vi.fn(async (user: string) => `name-${user}`) });
    const memory = { list: async () => [{ id: "m1", content: "Slack user UBOB (Bob) owes Kevin a report." }], save: vi.fn(async (content: string) => ({ id: "m2", content })) };
    const agent = new KevinAgent(slack as never, memory as never, {} as never, "UKEVIN", undefined, undefined, { channel: "CKEVIN", timezone: "UTC" });
    chat.mockImplementation(async () => turns.shift() ?? textTurn(""));
    Object.assign(agent, { ai: { chat } });
    return { agent, slack, chat, memory };
  };

  it("lets a scheduled post use the same tools as a reply, and thread under a message", async () => {
    const { agent, slack, chat, memory } = own(
      toolTurn(call("send_dm", { user: "UBOB", text: "The report." }), call("save_memory", { content: "Slack user UBOB (Bob) was chased for the report." })),
      toolTurn(call("respond", { text: "Bob has been reminded.", thread_ts: "5.0", reactions: ["eyes"] })),
    );
    expect(await agent.muse()).toMatchObject({ action: "respond", text: "Bob has been reminded.", threadTs: "5.0", reactions: ["eyes"] });
    expect(slack.post).toHaveBeenCalledWith("D9", "The report.");
    expect(memory.save).toHaveBeenCalled();
    const offered = chat.mock.calls[0]![0].tools!.map(({ function: { name } }) => name);
    expect(offered).toEqual(expect.arrayContaining(["get_channel_history", "save_memory", "send_dm", "add_reaction", "pin_message", "respond", "stay_silent"]));
  });

  it("shows departures with who and when", async () => {
    const { agent, chat } = own(toolTurn(call("respond", { text: "Noted." })));
    const turn = await agent.observe([{ kind: "channel_leave", user: "UBOB", ts: "7.0", at: Date.now() }]);
    expect(turn).toMatchObject({ action: "respond", text: "Noted." });
    const prompt = (chat.mock.calls[0]![0].messages[1] as { content: string }).content;
    expect(prompt).toContain('"what":"left the channel"');
    expect(prompt).toContain('"messageTs":"7.0"');
  });
});

describe("KevinAgent manager commands", () => {
  it("offers delete_memory and the manager instructions only on a manager command", async () => {
    const { agent, chat } = setup(toolTurn(call("delete_memory", { id: "m1" })), toolTurn(call("respond", { text: "Deleted." })));
    const memory = { list: async () => [{ id: "m1", content: "Kevin likes sharks." }], delete: vi.fn(async (id: string) => ({ ok: true, deleted: { id } })) };
    Object.assign(agent, { memory });
    expect(await agent.respond({ channel: "D1", ts: "1.0", user: "UBOSS", text: "!forget the shark thing" }, { manager: true })).toMatchObject({ action: "respond", text: "Deleted." });
    expect(memory.delete).toHaveBeenCalledWith("m1");
    const request = chat.mock.calls[0]![0];
    expect(request.tools!.map(({ function: { name } }) => name)).toContain("delete_memory");
    expect((request.messages[0] as { content: string }).content).toContain("# Manager command");
    expect((request.messages[0] as { content: string }).content).toContain("New fee: forbidden");
  });

  it("refuses delete_memory outside a manager command", async () => {
    const { agent, chat, sent } = setup(toolTurn(call("delete_memory", { id: "m1" })), toolTurn(call("stay_silent", {})));
    const memory = { list: async () => [], delete: vi.fn() };
    Object.assign(agent, { memory });
    await agent.respond(message);
    expect(memory.delete).not.toHaveBeenCalled();
    expect(chat.mock.calls[0]![0].tools!.map(({ function: { name } }) => name)).not.toContain("delete_memory");
    expect((sent[0]![0] as { content: string }).content).not.toContain("# Manager command");
  });
});

describe("KevinAgent tool rounds and memory", () => {
  it("runs a round of lookups concurrently and returns results in call order", async () => {
    const { agent, slack, sent } = setup(
      toolTurn(call("get_channel_info", { channel: "C1" }, "a"), call("get_user_info", { user: "UBOB" }, "b")),
      toolTurn(call("stay_silent", {})),
    );
    let inFlight = 0;
    let peak = 0;
    const slow = <T>(value: T) => async () => {
      peak = Math.max(peak, ++inFlight);
      await new Promise((resolve) => setTimeout(resolve, 10));
      inFlight--;
      return value;
    };
    slack.channelInfo.mockImplementation(slow({ id: "C1", name: "general" }));
    slack.userInfo.mockImplementation(slow({ id: "UBOB" }));
    // No sender ID, so gathering context makes one slow call and only the tool round can make two at once.
    await agent.respond({ ...message, user: undefined });
    expect(peak).toBe(2);
    expect((sent[1]!.slice(-2) as { tool_call_id: string }[]).map(({ tool_call_id }) => tool_call_id)).toEqual(["a", "b"]);
  });

  it("offers search_memory and says when memories were left out", async () => {
    const { agent, chat } = setup(toolTurn(call("search_memory", { query: "sharks" })), toolTurn(call("stay_silent", {})));
    const records = Array.from({ length: 400 }, (_, index) => ({ id: `m${index}`, content: `Filler memory number ${index} about nothing in particular at all.`, createdAt: "2026-01-01T00:00:00.000Z" }));
    const memory = { list: async () => records, search: vi.fn(async () => [{ id: "m1", content: "Kevin likes sharks." }]) };
    Object.assign(agent, { memory });
    await agent.respond(message);
    const request = chat.mock.calls[0]![0];
    expect(request.tools!.map(({ function: { name } }) => name)).toContain("search_memory");
    expect((request.messages[0] as { content: string }).content).toMatch(/older records are not shown/);
    expect(memory.search).toHaveBeenCalledWith("sharks", undefined);
  });
});

describe("KevinAgent memory budget", () => {
  const saving = (manager: boolean) => {
    const { agent } = setup(
      toolTurn(call("save_memory", { content: "a" }, "1"), call("save_memory", { content: "b" }, "2"), call("edit_memory", { id: "m1", content: "c" }, "3")),
      toolTurn(call("stay_silent", {})),
    );
    const memory = { list: async () => [], save: vi.fn(async (content: string) => ({ id: content, content })), edit: vi.fn(async (id: string, content: string) => ({ id, content })) };
    Object.assign(agent, { memory });
    return { agent, memory, run: () => agent.respond(message, { manager }) };
  };

  it("caps memory changes per turn", async () => {
    const { memory, run } = saving(false);
    await run();
    expect(memory.save).toHaveBeenCalledTimes(2);
    expect(memory.edit).not.toHaveBeenCalled();
  });

  it("does not cap a manager command", async () => {
    const { memory, run } = saving(true);
    await run();
    expect(memory.save).toHaveBeenCalledTimes(2);
    expect(memory.edit).toHaveBeenCalledTimes(1);
  });

  it("tells Kevin memory is not a file on everyone", async () => {
    const { agent, chat } = setup(toolTurn(call("stay_silent", {})));
    await agent.respond(message);
    expect((chat.mock.calls[0]![0].messages[0] as { content: string }).content).toContain("not a file on everyone");
  });
});
