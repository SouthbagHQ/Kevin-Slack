import { describe, expect, it, vi } from "vitest";
import { ConversationQueue } from "../src/conversation-queue.js";

describe("ConversationQueue", () => {
  it("merges messages from the active sender into one follow-up batch", async () => {
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => release = resolve);
    const batches: string[][] = [];
    const process = vi.fn(async ({ values }: { values: string[] }) => {
      batches.push(values);
      if (batches.length === 1) await blocked;
    });
    const queue = new ConversationQueue(process, { concurrency: 2, debounceMs: 1, maxBatchMessages: 20, maxPendingBatches: 50 });

    queue.enqueue({ key: "thread", sender: "U1", priority: 2, value: "one" });
    await vi.waitFor(() => expect(process).toHaveBeenCalledTimes(1));
    queue.enqueue({ key: "thread", sender: "U1", priority: 2, value: "two" });
    queue.enqueue({ key: "thread", sender: "U1", priority: 2, value: "three" });
    release();

    await vi.waitFor(() => expect(process).toHaveBeenCalledTimes(2));
    expect(batches).toEqual([["one"], ["two", "three"]]);
  });

  it("processes separate conversations concurrently but preserves conversation order", async () => {
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => release = resolve);
    const started: string[] = [];
    const queue = new ConversationQueue<string>(async ({ values }) => {
      started.push(values[0]!);
      if (values[0] === "a") await blocked;
    }, { concurrency: 2, debounceMs: 1, maxBatchMessages: 20, maxPendingBatches: 50 });

    queue.enqueue({ key: "A", sender: "U1", priority: 0, value: "a" });
    queue.enqueue({ key: "B", sender: "U2", priority: 2, value: "b" });
    await vi.waitFor(() => expect(started).toContain("b"));
    expect(started).toHaveLength(2);
    release();
  });

  it("bounds a flood while retaining its newest messages", async () => {
    const batches: { values: string[]; omitted: number }[] = [];
    const queue = new ConversationQueue<string>(async (batch) => void batches.push(batch), {
      concurrency: 1, debounceMs: 1, maxBatchMessages: 2, maxPendingBatches: 50,
    });

    queue.enqueue({ key: "thread", sender: "U1", priority: 0, value: "old" });
    queue.enqueue({ key: "thread", sender: "U1", priority: 0, value: "newer" });
    queue.enqueue({ key: "thread", sender: "U1", priority: 0, value: "newest" });

    await vi.waitFor(() => expect(batches).toHaveLength(1));
    expect(batches[0]).toEqual({ values: ["newer", "newest"], omitted: 1 });
  });

  it("runs direct work before queued auto work", async () => {
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => release = resolve);
    const started: string[] = [];
    const queue = new ConversationQueue<string>(async ({ values }) => {
      started.push(values[0]!);
      if (values[0] === "busy") await blocked;
    }, { concurrency: 1, debounceMs: 1, maxBatchMessages: 20, maxPendingBatches: 50 });

    queue.enqueue({ key: "busy", sender: "U1", priority: 0, value: "busy" });
    await vi.waitFor(() => expect(started).toEqual(["busy"]));
    queue.enqueue({ key: "auto", sender: "U2", priority: 0, value: "auto" });
    queue.enqueue({ key: "ping", sender: "U3", priority: 2, value: "ping" });
    await new Promise((resolve) => setTimeout(resolve, 5));
    release();

    await vi.waitFor(() => expect(started).toHaveLength(3));
    expect(started).toEqual(["busy", "ping", "auto"]);
  });
});
