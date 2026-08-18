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
});
