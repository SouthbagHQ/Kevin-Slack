import { describe, expect, it, vi } from "vitest";
import { normalize, type Embedder } from "../src/embeddings.js";
import type { Memory } from "../src/memory.js";
import { MemoryRecall } from "../src/memory-recall.js";

const memory = (id: string, content: string): Memory => ({ id, content, createdAt: "2026-01-01T00:00:00.000Z" });
const records = [
  memory("bob", "Slack user UBOBBOB1 (Bob) owes Kevin a quarterly report."),
  memory("sharks", "Kevin keeps a photograph of a great white above His desk."),
  memory("chair", "The chair on floor 3 belongs to Kevin and nobody else."),
  memory("parking", "Slack user UALICE01 (Alice) was fined for parking in Kevin's spot."),
];
const store = (list = records) => ({ list: vi.fn(async () => list) });

/** A fake embedding space: each text maps to the topics it mentions. */
const TOPICS = [/shark|great white|ocean|fish/i, /chair|seat|furniture/i, /report|deadline|paperwork/i, /parking|car|spot/i];
const fakeEmbedder = (): Embedder & { embed: ReturnType<typeof vi.fn> } => ({
  embed: vi.fn(async (inputs: string[]) => inputs.map((text) => normalize([...TOPICS.map((topic) => (topic.test(text) ? 1 : 0)), 0.05]))),
});

describe("MemoryRecall", () => {
  it("surfaces records by meaning, not only shared words", async () => {
    const recall = new MemoryRecall(store(), fakeEmbedder());
    const { memories, total, mode } = await recall.relevant({ primary: "anyone else into fish?" });
    expect(mode).toBe("semantic");
    expect(total).toBe(4);
    expect(memories.map(({ id }) => id)).toEqual(["sharks"]);
  });

  it("always surfaces records about the people in play, most related first", async () => {
    const recall = new MemoryRecall(store(), fakeEmbedder());
    const { memories } = await recall.relevant({ primary: "where's my seat", ids: ["UBOBBOB1"] });
    expect(memories.map(({ id }) => id)).toEqual(["chair", "bob"]);
  });

  it("embeds each record once and only re-embeds what changed", async () => {
    const list = [...records];
    const embedder = fakeEmbedder();
    const recall = new MemoryRecall(store(list), embedder);
    await recall.prepare();
    await recall.relevant({ primary: "hello" });
    list[1] = { ...list[1]!, content: "Kevin has moved on from sharks." };
    await recall.relevant({ primary: "hello" });
    const embeddedRecords = embedder.embed.mock.calls.map(([inputs]) => inputs as string[]).filter((inputs) => inputs.some((text) => list.some(({ content }) => content === text) || records.some(({ content }) => content === text)));
    expect(embeddedRecords.map((inputs) => inputs.length)).toEqual([4, 1]);
  });

  it("falls back to keywords and IDs when embeddings fail", async () => {
    const embedder = { embed: vi.fn(async () => { throw new Error("down"); }) };
    const recall = new MemoryRecall(store(), embedder);
    const { memories, mode } = await recall.relevant({ primary: "the quarterly report is late", ids: ["UALICE01"] });
    expect(mode).toBe("keyword");
    expect(memories.map(({ id }) => id).sort()).toEqual(["bob", "parking"]);
    // Paused after the failure: the next turn does not wait on a dead endpoint.
    await recall.relevant({ primary: "again" });
    expect(embedder.embed).toHaveBeenCalledTimes(1);
  });

  it("shows nothing when nothing is related", async () => {
    const recall = new MemoryRecall(store(), fakeEmbedder());
    expect((await recall.relevant({ primary: "good morning" })).memories).toEqual([]);
  });

  it("keeps to the record and size limits", async () => {
    const many = Array.from({ length: 40 }, (_, index) => memory(`m${index}`, `Slack user UBOBBOB1 (Bob) fact number ${index}.`));
    const recall = new MemoryRecall(store(many), undefined, { limit: 5 });
    expect((await recall.relevant({ ids: ["UBOBBOB1"] })).memories).toHaveLength(5);
    const tight = new MemoryRecall(store(many), undefined, { budgetChars: 200 });
    expect((await tight.relevant({ ids: ["UBOBBOB1"] })).memories.length).toBeLessThan(5);
  });

  it("searches everything, by meaning or by any shared word", async () => {
    expect((await new MemoryRecall(store(), fakeEmbedder()).search("ocean creatures")).map(({ id }) => id)).toEqual(["sharks"]);
    expect((await new MemoryRecall(store()).search("photograph")).map(({ id }) => id)).toEqual(["sharks"]);
  });

  it("lets the channel and the people in it shape recall", async () => {
    const recall = new MemoryRecall(store(), fakeEmbedder());
    // Nothing in the message itself; the channel's name and topic carry it.
    const { memories } = await recall.relevant({ primary: "morning all", setting: "#parking-lot\nWho took whose spot" });
    expect(memories.map(({ id }) => id)).toEqual(["parking"]);
  });

  it("uses the setting's words without embeddings too", async () => {
    const recall = new MemoryRecall(store());
    const { memories } = await recall.relevant({ primary: "morning all", setting: "#quarterly-report" });
    expect(memories.map(({ id }) => id)).toEqual(["bob"]);
  });

  it("breaks search ties with the conversation it was asked in", async () => {
    const fees = [
      { ...memory("alice-fee", "Slack user UALICE01 (Alice) owes a late fee."), createdAt: "2026-02-01T00:00:00.000Z" },
      memory("bob-fee", "Slack user UBOBBOB1 (Bob) owes a late fee."),
    ];
    const recall = new MemoryRecall(store(fees));
    expect((await recall.search("late fee")).map(({ id }) => id)).toEqual(["alice-fee", "bob-fee"]);
    expect((await recall.search("late fee", 10, { ids: ["UBOBBOB1"] })).map(({ id }) => id)).toEqual(["bob-fee", "alice-fee"]);
  });

  it("embeds a turn's focus once even when it searches later", async () => {
    const embedder = fakeEmbedder();
    const recall = new MemoryRecall(store(), embedder);
    const focus = { primary: "where's my seat", text: "earlier chatter", setting: "#office" };
    await recall.relevant(focus);
    const calls = embedder.embed.mock.calls.length;
    await recall.search("chair", 10, focus);
    // Only the query itself is new.
    expect(embedder.embed.mock.calls.length).toBe(calls + 1);
  });
});
