import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { setChannelAutoMode } from "../src/channel-admin.js";
import { ChannelModes } from "../src/channel-modes.js";

describe("setChannelAutoMode", () => {
  it("allows managers and rejects everyone else", async () => {
    const modes = await new ChannelModes(join(await mkdtemp(join(tmpdir(), "kevin-")), "modes.json")).load();
    const managers = async () => ["U_MANAGER"];
    expect(await setChannelAutoMode(managers, modes, "U_OTHER", "C123", true)).toMatchObject({ ok: false });
    expect(modes.isEnabled("C123")).toBe(false);
    expect(await setChannelAutoMode(managers, modes, "U_MANAGER", "C123", true)).toEqual({ ok: true, channel: "C123", enabled: true });
    expect(modes.isEnabled("C123")).toBe(true);
  });
});
