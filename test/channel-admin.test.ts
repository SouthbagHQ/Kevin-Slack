import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { removeChannelMember, setChannelAutoMode } from "../src/channel-admin.js";
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

describe("removeChannelMember", () => {
  it("removes only when Kevin is a channel manager", async () => {
    const kick = vi.fn(async () => undefined);
    const managers = async () => ["UKEVIN1"];

    expect(await removeChannelMember(managers, kick, "UOTHER1", "C123", "UTARGET1")).toMatchObject({ ok: false });
    expect(kick).not.toHaveBeenCalled();

    expect(await removeChannelMember(managers, kick, "UKEVIN1", "C123", "UKEVIN1")).toMatchObject({ ok: false });
    expect(kick).not.toHaveBeenCalled();

    expect(await removeChannelMember(managers, kick, "UKEVIN1", "bad", "UTARGET1")).toMatchObject({ ok: false });
    expect(await removeChannelMember(managers, kick, "UKEVIN1", "C123", "bad")).toMatchObject({ ok: false });

    expect(await removeChannelMember(managers, kick, "UKEVIN1", "C123", "UTARGET1")).toEqual({
      ok: true,
      channel: "C123",
      user: "UTARGET1",
    });
    expect(kick).toHaveBeenCalledWith("C123", "UTARGET1");
  });
});
