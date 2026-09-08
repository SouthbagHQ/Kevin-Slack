import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { formatMemoryContext, MemoryStore, selectMemories, type Memory } from "../src/memory.js";

const file = async () => join(await mkdtemp(join(tmpdir(), "kevin-")), "memory.json");

const record = (id: string, content: string, createdAt = "2026-01-01T00:00:00.000Z"): Memory => ({
  id,
  content,
  createdAt,
});

describe("MemoryStore", () => {
  it("persists memories with private permissions", async () => {
    const path = await file();
    const store = new MemoryStore(path);
    await store.save("The Briefcase is occupied.");
    expect(await store.list()).toMatchObject([{ content: "The Briefcase is occupied." }]);
    expect(JSON.parse(await readFile(path, "utf8"))).toHaveLength(1);
  });

  it("edits a memory by ID without creating a duplicate", async () => {
    const store = new MemoryStore(await file());
    const original = await store.save("Kevin owns one chair.");
    const edited = await store.edit(original.id, "Kevin owns two chairs.");

    expect(edited).toMatchObject({ id: original.id, content: "Kevin owns two chairs." });
    expect(await store.list()).toMatchObject([{ id: original.id, content: "Kevin owns two chairs." }]);
    await expect(store.edit("missing", "No.")).rejects.toThrow("Memory missing not found");
  });

  it("keeps an in-memory cache across reads and writes", async () => {
    const path = await file();
    const store = new MemoryStore(path);
    const saved = await store.save("Cached.");
    await writeFile(path, "[]");
    expect(await store.list()).toMatchObject([{ id: saved.id, content: "Cached." }]);
    expect(await new MemoryStore(path).list()).toEqual([]);
  });

  it("serializes concurrent writes against the cache", async () => {
    const store = new MemoryStore(await file());
    await Promise.all([store.save("Alpha"), store.save("Bravo"), store.save("Charlie")]);
    expect(await store.list()).toHaveLength(3);
  });

  it("deletes a memory by ID", async () => {
    const store = new MemoryStore(await file());
    const keep = await store.save("Keep.");
    const drop = await store.save("Drop.");
    expect(await store.delete(drop.id)).toMatchObject({ id: drop.id, content: "Drop." });
    expect(await store.list()).toMatchObject([{ id: keep.id }]);
    await expect(store.delete(drop.id)).rejects.toThrow(`Memory ${drop.id} not found`);
  });

  it("searches by Slack user ID and keywords", async () => {
    const store = new MemoryStore(await file());
    await store.save("Slack user U111 (Ada) prefers window desks.");
    await store.save("The Briefcase is occupied.");
    await store.save("Parking remains empty.");
    const userHits = await store.search("U111");
    const keywordHits = await store.search("briefcase");
    expect(userHits).toMatchObject([{ content: "Slack user U111 (Ada) prefers window desks." }]);
    expect(keywordHits).toMatchObject([{ content: "The Briefcase is occupied." }]);
    expect(await store.search("nothing-relevant")).toEqual([]);
  });
});

describe("selectMemories", () => {
  const memories = [
    record("1", "Slack user U111 (Ada) prefers window desks.", "2026-01-01T00:00:00.000Z"),
    record("2", "The Briefcase is occupied.", "2026-02-01T00:00:00.000Z"),
    record("3", "Parking remains empty.", "2026-03-01T00:00:00.000Z"),
    record("4", "Slack user U222 (Ben) filed a complaint.", "2026-04-01T00:00:00.000Z"),
    ...Array.from({ length: 30 }, (_, index) => record(
      `n${index}`,
      `Unrelated note ${index}.`,
      new Date(Date.UTC(2026, 5, 1, 0, 0, index)).toISOString(),
    )),
  ];

  it("returns the full store when it fits the budget", () => {
    const subset = memories.slice(0, 4);
    const selected = selectMemories(subset, "U111 asked about the briefcase", 24);
    expect(selected).toEqual({
      records: [
        { id: "1", content: "Slack user U111 (Ada) prefers window desks." },
        { id: "2", content: "The Briefcase is occupied." },
        { id: "4", content: "Slack user U222 (Ben) filed a complaint." },
        { id: "3", content: "Parking remains empty." },
      ],
      total: 4,
      omitted: 0,
    });
  });

  it("keeps matching records and a small recent fill when the store is large", () => {
    const selected = selectMemories(memories, "U111 C123 asked about the briefcase", 24);
    expect(selected.total).toBe(34);
    expect(selected.records.map((item) => item.id)).toEqual(["1", "2", "n29", "n28", "n27", "n26", "n25", "n24"]);
    expect(selected.omitted).toBe(26);
    expect(selected.records.every((item) => !("createdAt" in item))).toBe(true);
  });

  it("caps a flood of matches instead of dumping the whole store", () => {
    const flood = Array.from({ length: 40 }, (_, index) => record(`u${index}`, `Slack user U111 note ${index}.`));
    const selected = selectMemories(flood, "U111", 10);
    expect(selected.records).toHaveLength(10);
    expect(selected.omitted).toBe(30);
    expect(selected.records.every((item) => item.content.includes("U111"))).toBe(true);
  });
});

describe("formatMemoryContext", () => {
  it("tells Kevin when more memories exist", () => {
    expect(formatMemoryContext({ records: [], total: 0, omitted: 0 })).toBe("No persistent memory records yet.");
    expect(formatMemoryContext({
      records: [{ id: "1", content: "Kept." }],
      total: 3,
      omitted: 2,
    })).toContain("2 additional memories are stored.");
  });
});
