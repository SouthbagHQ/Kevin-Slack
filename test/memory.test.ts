import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { MemoryStore } from "../src/memory.js";

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
});
