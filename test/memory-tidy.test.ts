import { mkdtemp, readdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { ChatCompletion } from "../src/chat.js";
import { MemoryStore, type Memory } from "../src/memory.js";
import { MemoryTidy, parseTidy, tidyBatches } from "../src/memory-tidy.js";

const memory = (id: string, content: string): Memory => ({ id, content, createdAt: "2026-01-01T00:00:00.000Z" });
const answer = (records: unknown): ChatCompletion => ({ choices: [{ finish_reason: "stop", message: { role: "assistant", content: JSON.stringify({ records }) } }] });
const store = async () => new MemoryStore(join(await mkdtemp(join(tmpdir(), "kevin-")), "memory.json"));

describe("tidyBatches", () => {
  it("keeps each person's records together, people before general records", () => {
    const records = [memory("g1", "The chair is His."), memory("a1", "Slack user UAAAAAA1 (A) owes a fee."), memory("b1", "Slack user UBBBBBB1 (B) runs payroll."), memory("a2", "Slack user UAAAAAA1 (A) likes jazz.")];
    expect(tidyBatches(records, 3).map((batch) => batch.map(({ id }) => id))).toEqual([["a1", "a2", "b1"], ["g1"]]);
  });

  it("splits a person only when they alone fill a batch", () => {
    const records = Array.from({ length: 5 }, (_, index) => memory(`a${index}`, `Slack user UAAAAAA1 (A) fact ${index}.`));
    expect(tidyBatches(records, 2).map((batch) => batch.length)).toEqual([2, 2, 1]);
  });
});

describe("parseTidy", () => {
  const batch = [memory("m1", "one"), memory("m2", "two")];

  it("accepts merges and drops", () => {
    expect(parseTidy(batch, JSON.stringify({ records: [{ from: ["m1", "m2"], content: "one and two" }] }))).toEqual({ ok: true, records: [{ from: ["m1", "m2"], content: "one and two" }] });
  });

  it("rejects unknown IDs, double citations, and wiping the whole batch", () => {
    expect(parseTidy(batch, JSON.stringify({ records: [{ from: ["m9"], content: "x" }] }))).toMatchObject({ ok: false, error: "unknown-id" });
    expect(parseTidy(batch, JSON.stringify({ records: [{ from: ["m1"], content: "a" }, { from: ["m1"], content: "b" }] }))).toMatchObject({ ok: false, error: "id-cited-twice" });
    expect(parseTidy(batch, JSON.stringify({ records: [] }))).toMatchObject({ ok: false, error: "everything-dropped" });
    expect(parseTidy(batch, "not json")).toMatchObject({ ok: false, error: "unparsable" });
  });
});

describe("MemoryStore.consolidate", () => {
  it("merges in place under the first record's ID and drops uncited records", async () => {
    const memories = await store();
    const a = await memories.save("Slack user UAAAAAA1 (A) owes Kevin a report.");
    const keep = await memories.save("The Briefcase is occupied.");
    const b = await memories.save("Slack user UAAAAAA1 (A) promised it by Friday.");
    const trivia = await memories.save("Slack user UAAAAAA1 (A) had toast for breakfast.");
    const batch = await memories.list();
    expect(await memories.consolidate(batch, [
      { from: [a.id, b.id], content: "Slack user UAAAAAA1 (A) owes Kevin a report, promised by Friday." },
      { from: [keep.id], content: keep.content },
    ])).toMatchObject({ applied: true, before: 4, after: 2 });
    const after = await memories.list();
    expect(after.map(({ id }) => id)).toEqual([a.id, keep.id]);
    expect(after[0]).toMatchObject({ content: "Slack user UAAAAAA1 (A) owes Kevin a report, promised by Friday.", updatedAt: expect.any(String) });
    expect(after[1]).toEqual(batch[1]);
    expect(after.some(({ id }) => id === trivia.id)).toBe(false);
  });

  it("does nothing when a record changed since the batch was read", async () => {
    const memories = await store();
    const a = await memories.save("First.");
    const batch = await memories.list();
    await memories.edit(a.id, "First, revised.");
    expect(await memories.consolidate(batch, [])).toEqual({ applied: false });
    expect(await memories.list()).toMatchObject([{ content: "First, revised." }]);
  });
});

describe("MemoryStore.save", () => {
  it("points at an existing record on the same person", async () => {
    const memories = await store();
    const first = await memories.save("Slack user UAAAAAA1 (A) runs payroll.");
    const second = await memories.save("Slack user UAAAAAA1 (A) owes Kevin lunch.");
    expect(second.related).toMatchObject([{ id: first.id }]);
    expect(second.note).toMatch(/edit_memory/);
  });
});

describe("MemoryStore.backup", () => {
  it("keeps one backup per day and only the last three", async () => {
    const memories = await store();
    await memories.save("Something.");
    const dir = join((memories as unknown as { file: string }).file, "..");
    for (const day of ["2026-01-01", "2026-01-02", "2026-01-03"]) await writeFile(join(dir, `memory.json.bak-${day}`), "[]");
    await memories.backup();
    const backups = (await readdir(dir)).filter((name) => name.includes(".bak-")).sort();
    expect(backups).toHaveLength(3);
    expect(backups[0]).toBe("memory.json.bak-2026-01-02");
  });

  it("never overwrites the day's backup", async () => {
    const memories = await store();
    await memories.save("Before.");
    const target = await memories.backup();
    await memories.save("After.");
    await memories.backup();
    expect(JSON.parse(await readFile(target!, "utf8"))).toHaveLength(1);
  });
});

describe("MemoryTidy", () => {
  it("tidies every batch, backs up first, and skips when nothing changed", async () => {
    const memories = await store();
    const a = await memories.save("Slack user UAAAAAA1 (A) owes Kevin a report.");
    await memories.save("Slack user UAAAAAA1 (A) likes jazz and hiking.");
    const chat = vi.fn(async () => answer([{ from: [a.id], content: a.content }]));
    const tidy = new MemoryTidy(memories, { chat }, { model: "test", intervalMs: 1 });
    expect(await tidy.run()).toEqual({ before: 2, after: 1 });
    expect(await memories.list()).toMatchObject([{ id: a.id }]);
    const dir = join((memories as unknown as { file: string }).file, "..");
    expect((await readdir(dir)).some((name) => name.includes(".bak-"))).toBe(true);
    expect(await tidy.run()).toMatchObject({ skipped: true });
    expect(chat).toHaveBeenCalledTimes(1);
  });

  it("leaves a batch alone when the model's answer is unusable", async () => {
    const memories = await store();
    await memories.save("One.");
    await memories.save("Two.");
    const tidy = new MemoryTidy(memories, { chat: async () => answer([]) }, { model: "test", intervalMs: 1 });
    expect(await tidy.run()).toEqual({ before: 2, after: 2 });
  });
});
