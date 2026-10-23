import { mkdir, mkdtemp, readdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { MAX_MEMORY_CHARS, MemoryStore, promptMemory, rankMemories, selectMemories, type Memory } from "../src/memory.js";

describe("MemoryStore", () => {
  it("persists memories with private permissions", async () => {
    const dir = await mkdtemp(join(tmpdir(), "kevin-"));
    const file = join(dir, "memory.json");
    const store = new MemoryStore(file);
    await store.save("The Briefcase is occupied.");
    expect(await store.list()).toMatchObject([{ content: "The Briefcase is occupied." }]);
    expect(JSON.parse(await readFile(file, "utf8"))).toHaveLength(1);
  });

  it("edits a memory by ID without creating a duplicate", async () => {
    const file = join(await mkdtemp(join(tmpdir(), "kevin-")), "memory.json");
    const store = new MemoryStore(file);
    const original = await store.save("Kevin owns one chair.");
    const edited = await store.edit(original.id, "Kevin owns two chairs.");

    expect(edited).toMatchObject({ id: original.id, content: "Kevin owns two chairs." });
    expect(await store.list()).toMatchObject([{ id: original.id, content: "Kevin owns two chairs." }]);
    await expect(store.edit("missing", "No.")).rejects.toThrow("Memory missing not found");
  });

  it("deletes a memory by ID", async () => {
    const store = new MemoryStore(join(await mkdtemp(join(tmpdir(), "kevin-")), "memory.json"));
    const keep = await store.save("Kevin owns the chair.");
    const drop = await store.save("Kevin likes sharks.");
    expect(await store.delete(drop.id)).toMatchObject({ ok: true, deleted: { id: drop.id } });
    expect(await store.list()).toMatchObject([{ id: keep.id }]);
    await expect(store.delete(drop.id)).rejects.toThrow("not found");
  });
});

describe("MemoryStore reliability", () => {
  const fresh = async () => join(await mkdtemp(join(tmpdir(), "kevin-")), "memory.json");

  it("reads the file once and keeps the cache current across writes", async () => {
    const file = await fresh();
    const store = new MemoryStore(file);
    await store.save("Kevin owns the chair.");
    await writeFile(file, "[]");
    // The store is the only writer; it answers from what it last wrote, not by re-reading.
    expect(await store.list()).toHaveLength(1);
    expect(await new MemoryStore(file).list()).toHaveLength(0);
  });

  it("skips identical saves and points out similar ones", async () => {
    const store = new MemoryStore(await fresh());
    const first = await store.save("Slack user U123ABC (Bob) moved to Melbourne.");
    expect(await store.save("slack user U123ABC (bob) moved to melbourne")).toMatchObject({ id: first.id, duplicate: true });
    const similar = await store.save("Slack user U123ABC (Bob) moved to Melbourne in March.");
    expect(similar.related).toMatchObject([{ id: first.id }]);
    expect(await store.list()).toHaveLength(2);
  });

  it("rejects empty and oversized content", async () => {
    const store = new MemoryStore(await fresh());
    await expect(store.save("   ")).rejects.toThrow("non-empty");
    await expect(store.save("x".repeat(MAX_MEMORY_CHARS + 1))).rejects.toThrow("keep it under");
    expect(await store.list()).toEqual([]);
  });

  it("moves a corrupt file aside instead of failing every turn", async () => {
    const file = await fresh();
    await writeFile(file, "{not json");
    const store = new MemoryStore(file);
    expect(await store.list()).toEqual([]);
    expect((await readdir(dirname(file))).some((name) => name.startsWith("memory.json.corrupt-"))).toBe(true);
    await store.save("Fresh start.");
    expect(JSON.parse(await readFile(file, "utf8"))).toHaveLength(1);
  });

  it("keeps the cached state when a write fails", async () => {
    const dir = await mkdtemp(join(tmpdir(), "kevin-"));
    const store = new MemoryStore(join(dir, "memory.json"));
    await store.save("Kept.");
    await writeFile(join(dir, "blocker"), "");
    Object.assign(store, { file: join(dir, "blocker", "memory.json") });
    await expect(store.save("Lost.")).rejects.toThrow();
    expect((await store.list()).map(({ content }) => content)).toEqual(["Kept."]);
  });

  it("searches by words and Slack IDs", async () => {
    const store = new MemoryStore(await fresh());
    await store.save("Slack user U123ABC (Bob) owes Kevin a report.");
    await store.save("The Briefcase is occupied.");
    expect(await store.search("U123ABC")).toMatchObject([{ content: "Slack user U123ABC (Bob) owes Kevin a report." }]);
    expect(await store.search("briefcase")).toMatchObject([{ content: "The Briefcase is occupied." }]);
    expect(await store.search("nothing matches this")).toEqual([]);
  });
});

describe("selectMemories", () => {
  const memory = (id: string, content: string, day: number): Memory => ({ id, content, createdAt: `2026-01-${String(day).padStart(2, "0")}T00:00:00.000Z` });
  const all = [
    memory("a", "Slack user UBOBBOB1 (Bob) hates parking fees.", 1),
    memory("b", "The fourth floor printer is cursed.", 2),
    memory("c", "Slack user UALICE01 (Alice) runs finance.", 3),
    memory("d", "Kevin's chair is non-negotiable.", 4),
  ];

  it("shows everything that fits", () => {
    expect(selectMemories(all, { text: "hi" }, 10_000)).toEqual({ memories: all, omitted: 0 });
  });

  it("keeps relevant records first when over budget, then the most recent, in store order", () => {
    const { memories, omitted } = selectMemories(all, { text: "what about the printer?", ids: ["UBOBBOB1"] }, 300);
    expect(memories.map(({ id }) => id)).toEqual(["a", "b", "d"]);
    expect(omitted).toBe(1);
  });

  it("ranks an exact Slack ID above a shared word", () => {
    expect(rankMemories(all, { text: "finance", ids: ["UBOBBOB1"] })[0]!.memory.id).toBe("a");
  });

  it("formats records compactly for prompts", () => {
    expect(promptMemory(all[0]!)).toEqual({ id: "a", content: all[0]!.content, date: "2026-01-01" });
  });
});
