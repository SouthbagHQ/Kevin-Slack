import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ChannelModes } from "../src/channel-modes.js";

describe("ChannelModes", () => {
  it("persists enabled channels", async () => {
    const file = join(await mkdtemp(join(tmpdir(), "kevin-")), "channel-modes.json");
    const modes = await new ChannelModes(file).load();
    expect(modes.list()).toEqual([]);
    await modes.set("C2", true);
    const reloaded = await new ChannelModes(file).load();
    expect(reloaded.isEnabled("C1")).toBe(false);
    expect(reloaded.isEnabled("C2")).toBe(true);
  });
});
