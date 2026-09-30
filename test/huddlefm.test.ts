import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { HuddleFm, decodeSlackText, parseHuddleFmText, slackSafeJson, type Announcement } from "../src/huddlefm.js";

const HFM = "UHFM";
const DM = "DHFM";

type Sent = { ts: string; body: Record<string, unknown> };

/** A HuddleFM stand-in: records commands and answers them the way the real one threads replies. */
const setup = async (answer: (body: Record<string, unknown>) => Record<string, unknown> | undefined = () => undefined, file?: string) => {
  const sent: Sent[] = [];
  const announcements: Announcement[] = [];
  let next = 100;
  const stateFile = file ?? join(await mkdtemp(join(tmpdir(), "kevin-")), "huddlefm.json");
  const huddleFm: HuddleFm = new HuddleFm({
    openDm: async () => DM,
    post: async (_channel, text) => {
      const ts = `${next++}.000`;
      const body = JSON.parse(text) as Record<string, unknown>;
      sent.push({ ts, body });
      const reply = answer(body);
      if (reply) setImmediate(() => void huddleFm.receive(message({ v: 1, replyTo: ts, ...reply }, ts)));
      return ts;
    },
  }, HFM, stateFile, { immediateReplyMs: 30, replyTimeoutMs: 200, rejoinIntervalMs: 10_000 });
  await huddleFm.load();
  huddleFm.onAnnouncement = async (announcement) => void announcements.push(announcement);
  return { huddleFm, sent, announcements, stateFile };
};

let eventTs = 1;
const message = (body: Record<string, unknown>, threadTs?: string) => ({
  channel: DM,
  user: HFM,
  ts: `9${eventTs++}.000`,
  thread_ts: threadTs,
  text: JSON.stringify(body),
});
const event = (name: string, payload: Record<string, unknown> = {}) => message({ v: 1, type: "event", channel: "CHUDDLE", event: name, payload });

const origin = { channel: "CHUDDLE", thread_ts: "1.1", requester: "UASKER", request: "Kevin, play something" };

const status = {
  state: "playing",
  volumePercent: 40,
  playbackSeconds: 12.4,
  autoplay: "related",
  loopMode: "off",
  yourCapabilities: ["add", "skip"],
  nowPlaying: { id: "t1", title: "Song", artist: "Artist" },
  queue: [{ position: 1, id: "t2", title: "Next", artist: "Band" }],
  queueLimit: 50,
};

const granted = async (answer?: (body: Record<string, unknown>) => Record<string, unknown> | undefined) => {
  const context = await setup(answer);
  await context.huddleFm.requestControl({ channel: "CHUDDLE", origin });
  const request = context.sent[0]!;
  await context.huddleFm.receive(message({ v: 1, replyTo: request.ts, ok: true, type: "grant_accepted", permissions: ["add", "skip"], events: [], ...status }, request.ts));
  return context;
};

describe("Slack-safe protocol text", () => {
  it("round-trips characters Slack would rewrite", () => {
    const value = { v: 1, type: "add", reference: "https://youtu.be/x?a=1&b=<2>", query: "Simon & Garfunkel @here *bold*", seconds: -12.5 };
    const text = slackSafeJson(value);
    expect(text).not.toMatch(/[&<>@*]|https:|youtu\.be/);
    expect(text).toContain("-12.5");
    expect(JSON.parse(text)).toEqual(value);
  });

  it("parses replies after Slack escaped and linked them", () => {
    expect(decodeSlackText("&lt;b&gt; &amp; <https://x.test/a?b=1&amp;c=2> <http://x.test|x.test>")).toBe("<b> & https://x.test/a?b=1&c=2 x.test");
    expect(parseHuddleFmText("{\"v\":1,\"ok\":true,\"title\":\"A &amp; B\",\"url\":\"<https://x.test>\"}")).toEqual({ v: 1, ok: true, title: "A & B", url: "https://x.test" });
    expect(parseHuddleFmText("hello")).toBeUndefined();
    expect(parseHuddleFmText("{\"v\":2}")).toBeUndefined();
  });
});

describe("HuddleFm", () => {
  it("only takes protocol DMs from the HuddleFM user", async () => {
    const { huddleFm } = await setup();
    expect(huddleFm.accepts({ channel: DM, user: HFM, ts: "1" })).toBe(true);
    expect(huddleFm.accepts({ channel: DM, user: "USOMEONE", ts: "1" })).toBe(false);
    expect(huddleFm.accepts({ channel: "CHUDDLE", user: HFM, ts: "1" })).toBe(false);
  });

  it("requests control, then hands the host's approval to Kevin to announce", async () => {
    const { huddleFm, sent, announcements } = await setup();
    const result = await huddleFm.requestControl({ channel: "CHUDDLE", origin });
    expect(result).toMatchObject({ ok: true, status: "pending_host_approval" });
    expect(sent[0]!.body).toMatchObject({ v: 1, type: "request_control", channel: "CHUDDLE", events: ["playback.state", "track", "queue", "volume", "session"] });
    expect(sent[0]!.body.permissions).not.toContain("end-session");
    expect(huddleFm.quickContext("CHUDDLE")).toEqual([{ huddleChannel: "CHUDDLE", kevinControl: "pending" }]);

    await huddleFm.receive(message({ v: 1, replyTo: sent[0]!.ts, ok: true, type: "grant_accepted", permissions: ["add", "skip"], ...status }, sent[0]!.ts));
    expect(announcements).toMatchObject([{ event: "grant_accepted", origin, huddleChannel: "CHUDDLE", detail: { permissions: ["add", "skip"] } }]);
    expect(huddleFm.quickContext("CHUDDLE")).toMatchObject([{ kevinControl: "granted", nowPlaying: { title: "Song" } }]);
  });

  it("reports an immediate refusal and forgets the request", async () => {
    const { huddleFm, announcements } = await setup(() => ({ ok: false, error: "session_not_found" }));
    expect(await huddleFm.requestControl({ channel: "CHUDDLE", origin })).toMatchObject({ ok: false, error: "session_not_found" });
    expect(huddleFm.sessionsFor("CHUDDLE")).toEqual([]);
    expect(announcements).toEqual([]);
  });

  it("announces a declined request and drops it", async () => {
    const { huddleFm, sent, announcements } = await setup();
    await huddleFm.requestControl({ channel: "CHUDDLE", origin });
    await huddleFm.receive(message({ v: 1, replyTo: sent[0]!.ts, ok: true, type: "grant_declined" }, sent[0]!.ts));
    expect(announcements).toMatchObject([{ event: "grant_declined" }]);
    expect(huddleFm.sessionsFor("CHUDDLE")).toEqual([]);
  });

  it("refuses commands without a grant and routes them to the controlled session", async () => {
    const { huddleFm } = await setup();
    expect(await huddleFm.command("skip", {}, { current: "CHUDDLE" })).toMatchObject({ ok: false, error: "not_granted" });

    const context = await granted((body) => body.type === "skip" ? { ok: true, type: "skip", skipped: { title: "Song" } } : undefined);
    const result = await context.huddleFm.command("skip", { reference: "ignored" }, { current: "DSOMEONE" });
    expect(result).toMatchObject({ ok: true, type: "skip", huddleChannel: "CHUDDLE" });
    expect(context.sent.at(-1)!.body).toEqual({ v: 1, type: "skip", channel: "CHUDDLE" });
  });

  it("gives Kevin live status and recent activity as context", async () => {
    const { huddleFm } = await granted((body) => body.type === "status" ? { ok: true, type: "status", ...status } : undefined);
    await huddleFm.receive(event("track.started", { id: "t1", title: "Song", artist: "Artist" }));
    const [session] = await huddleFm.context("CHUDDLE");
    expect(session).toMatchObject({
      huddleChannel: "CHUDDLE",
      kevinControl: "granted",
      state: "playing",
      nowPlaying: { title: "Song" },
      queueLength: 1,
      playbackSeconds: 12,
      recentActivity: [{ event: "track.started", title: "Song" }],
    });
    expect(await huddleFm.context("COTHER")).toEqual([]);
  });

  it("matches a reply that arrives before the post call returns", async () => {
    const sent: string[] = [];
    let huddleFm!: HuddleFm;
    huddleFm = new HuddleFm({
      openDm: async () => DM,
      post: async () => {
        const ts = "5.000";
        sent.push(ts);
        await huddleFm.receive(message({ v: 1, replyTo: ts, ok: true, type: "status", ...status }, ts));
        return ts;
      },
    }, HFM, join(await mkdtemp(join(tmpdir(), "kevin-")), "huddlefm.json"), { replyTimeoutMs: 50 });
    expect(await huddleFm.command("status", {}, { channel: "CHUDDLE" })).toMatchObject({ ok: true, state: "playing" });
  });

  it("drops a grant HuddleFM no longer honours", async () => {
    const { huddleFm } = await granted(() => ({ ok: false, error: "not_granted" }));
    await huddleFm.command("pause", {}, { current: "CHUDDLE" });
    expect(huddleFm.sessionsFor("CHUDDLE")).toEqual([]);
  });

  it("announces the end of the session", async () => {
    const { huddleFm, announcements } = await granted();
    await huddleFm.receive(event("session.ended"));
    expect(announcements.at(-1)).toMatchObject({ event: "session.ended", origin });
    expect(huddleFm.sessionsFor("CHUDDLE")).toEqual([]);
  });

  it("notices when someone else skips Kevin's pick, but not His own skips", async () => {
    const { huddleFm, announcements } = await granted((body) => {
      if (body.type === "add") return { ok: true, type: "add", added: [{ id: "k1", title: "Kevin Song", artist: "Him" }, { id: "k2", title: "Other", artist: "Him" }] };
      if (body.type === "skip") return { ok: true, type: "skip" };
    });
    const pickOrigin = { channel: "CHUDDLE", requester: "UASKER" };
    await huddleFm.command("add", { reference: "ref_1" }, { current: "CHUDDLE", origin: pickOrigin });
    await huddleFm.command("skip", {}, { current: "CHUDDLE" });
    await huddleFm.receive(event("track.skipped", { id: "k1", title: "Kevin Song" }));
    expect(announcements.map(({ event: name }) => name)).toEqual(["grant_accepted"]);

    await huddleFm.receive(event("queue.removed", { id: "k2", title: "Other", reason: "failed" }));
    expect(announcements.at(-1)).toMatchObject({ event: "kevin_pick_failed", origin: pickOrigin, detail: { title: "Other" } });
  });

  it("keeps grants across a Kevin restart", async () => {
    const { stateFile } = await granted();
    const restarted = await setup(undefined, stateFile);
    expect(restarted.huddleFm.quickContext("CHUDDLE")).toMatchObject([{ kevinControl: "granted" }]);
  });

  it("asks for control again after HuddleFM restarts", async () => {
    const { huddleFm, sent } = await granted();
    await huddleFm.receive(event("session.suspended"));
    expect(huddleFm.sessionsFor("CHUDDLE")).toEqual([]);
    expect(sent).toHaveLength(1);
    huddleFm.stop();
  });
});
