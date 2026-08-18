import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ThreadMutes } from "../src/thread-mutes.js";

describe("ThreadMutes", () => {
  it("persists subscriptions and lets a ping reactivate a muted thread", async () => {
    const file = join(await mkdtemp(join(tmpdir(), "kevin-")), "thread-mutes.json");
    const store = await new ThreadMutes(file).load();
    await store.subscribe("C1:123");
    expect((await new ThreadMutes(file).load()).isSubscribed("C1:123")).toBe(true);
    await store.mute("C1:123");
    expect((await new ThreadMutes(file).load()).has("C1:123")).toBe(true);
    await store.subscribe("C1:123");
    const reloaded = await new ThreadMutes(file).load();
    expect(reloaded.has("C1:123")).toBe(false);
    expect(reloaded.isSubscribed("C1:123")).toBe(true);
  });
});
