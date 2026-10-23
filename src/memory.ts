import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { createLogger, preview, timer } from "./logger.js";

export type Memory = { id: string; content: string; createdAt: string; updatedAt?: string };
/** What save_memory hands back: the record, plus a nudge when it duplicates or overlaps others. */
export type SavedMemory = Memory & { duplicate?: true; similar?: ReturnType<typeof promptMemory>[]; note?: string };

/**
 * What a conversation is about, for picking the memories worth showing: the
 * message at hand, its surrounding text, and the Slack IDs in play.
 */
export type MemoryFocus = { primary?: string; text?: string; ids?: Iterable<string | undefined> };

export const MAX_MEMORY_CHARS = 1_000;

const log = createLogger("memory");

const STOPWORDS = new Set("the and for are but not you your with this that have has had was were what when where who why how can could would should will just about from into than then them they their there here our out all any some its it's his her him she he kevin slack user does did don't doesn't".split(" "));
const SLACK_ID = /\b[UWCGDS][A-Z0-9]{6,}\b/g;

const terms = (text: string) => new Set(text.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter((word) => word.length > 2 && !STOPWORDS.has(word)));
const slackIds = (text: string) => new Set(text.match(SLACK_ID) ?? []);
/** Same words in the same order, ignoring case, spacing, and punctuation. */
const normalized = (text: string) => [...text.toLowerCase().matchAll(/[\p{L}\p{N}]+/gu)].map(([word]) => word).join(" ");
const touched = (memory: Memory) => memory.updatedAt ?? memory.createdAt ?? "";

/** Token overlap between two memories, 0 to 1. */
const similarity = (a: Set<string>, b: Set<string>) => {
  if (!a.size || !b.size) return 0;
  let shared = 0;
  for (const word of a) if (b.has(word)) shared++;
  return shared / (a.size + b.size - shared);
};

/**
 * Scores every memory against a focus by keywords: a Slack ID the
 * conversation mentions counts most (`idHits`), then shared words, rarer
 * words counting more (`lexical`). Highest first; ties go to recently touched
 * records, then store order.
 */
export const rankMemories = (memories: Memory[], focus: MemoryFocus) => {
  const text = [focus.primary, focus.text].filter(Boolean).join("\n");
  const ids = new Set([...(focus.ids ?? [])].filter((id): id is string => Boolean(id)));
  for (const id of slackIds(text)) ids.add(id);
  const query = terms(text);
  const indexed = memories.map((memory) => ({ memory, terms: terms(memory.content), ids: slackIds(memory.content) }));
  const frequency = new Map<string, number>();
  for (const { terms: words } of indexed) for (const word of words) if (query.has(word)) frequency.set(word, (frequency.get(word) ?? 0) + 1);
  const byAge = [...memories].sort((a, b) => touched(a).localeCompare(touched(b)));
  const recency = new Map(byAge.map((memory, index) => [memory.id, memories.length > 1 ? index / (memories.length - 1) : 1]));
  return indexed
    .map(({ memory, terms: words, ids: mentioned }, index) => {
      let idHits = 0;
      let lexical = 0;
      for (const id of mentioned) if (ids.has(id)) idHits++;
      for (const word of words) if (query.has(word)) lexical += Math.log(1 + memories.length / frequency.get(word)!);
      return { memory, score: idHits * 4 + lexical, idHits, lexical, recency: recency.get(memory.id) ?? 0, index };
    })
    .sort((a, b) => b.score - a.score || b.recency - a.recency || a.index - b.index);
};

/** The shape memories take in a prompt: no timestamps beyond the day it was last touched. */
export const promptMemory = (memory: Memory) => ({ id: memory.id, content: memory.content, ...(touched(memory) ? { date: touched(memory).slice(0, 10) } : {}) });

const validContent = (content: unknown) => {
  if (typeof content !== "string" || !content.trim()) throw new Error("Memory content must be a non-empty string");
  const trimmed = content.trim().replace(/\s+/g, " ");
  if (trimmed.length > MAX_MEMORY_CHARS) throw new Error(`Memory content is ${trimmed.length} characters; keep it under ${MAX_MEMORY_CHARS} by splitting or condensing it`);
  return trimmed;
};

const isMemory = (value: unknown): value is Memory => {
  const record = value as Partial<Memory> | null;
  return Boolean(record) && typeof record!.id === "string" && typeof record!.content === "string" && typeof record!.createdAt === "string";
};

export class MemoryStore {
  private writes = Promise.resolve();
  /** The file's contents, read once; every write goes through here, so it stays current. */
  private cache?: Promise<Memory[]>;

  constructor(private file: string) {}

  async list() {
    return [...(await this.load())];
  }

  /** Resolves once every queued write has reached the disk. */
  flush() {
    return this.writes;
  }

  private load() {
    this.cache ??= this.read().catch((error) => {
      this.cache = undefined;
      throw error;
    });
    return this.cache;
  }

  private async read() {
    const elapsed = timer();
    let body: string;
    try {
      body = await readFile(this.file, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        log.debug("No memory file yet", { file: this.file });
        return [];
      }
      log.failure("Reading memories failed", error, { file: this.file, ms: elapsed() });
      throw error;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(body);
    } catch (error) {
      // A broken file would otherwise fail every reply; keep it aside and carry on with no memories.
      const backup = `${this.file}.corrupt-${Date.now()}`;
      await rename(this.file, backup).catch(() => undefined);
      log.failure("Memory file is not valid JSON; moved it aside and started empty", error, { file: this.file, backup, bytes: body.length });
      return [];
    }
    const records = Array.isArray(parsed) ? parsed : [];
    const memories = records.filter(isMemory);
    if (memories.length !== records.length || !Array.isArray(parsed)) log.warn("Ignored malformed memory records", { file: this.file, dropped: records.length - memories.length, array: Array.isArray(parsed) });
    log.info("Loaded memories", { file: this.file, count: memories.length, ms: elapsed() });
    return memories;
  }

  async save(content: string) {
    const text = validContent(content);
    return this.write<SavedMemory>((memories) => {
      const key = normalized(text);
      const existing = memories.find((item) => normalized(item.content) === key);
      if (existing) {
        log.info("Memory save skipped; identical record exists", { id: existing.id, content: preview(text, 160) });
        return { result: { ...existing, duplicate: true as const, note: "An identical memory already exists; nothing was saved." }, changed: false };
      }
      const memory = { id: randomUUID(), content: text, createdAt: new Date().toISOString() };
      const words = terms(text);
      const similar = memories
        .map((item) => ({ item, overlap: similarity(words, terms(item.content)) }))
        .filter(({ overlap }) => overlap >= 0.5)
        .sort((a, b) => b.overlap - a.overlap)
        .slice(0, 3)
        .map(({ item }) => promptMemory(item));
      memories.push(memory);
      log.info("Saved memory", { id: memory.id, total: memories.length, similar: similar.length || undefined, content: preview(memory.content, 160) });
      return {
        result: similar.length ? { ...memory, similar, note: "Saved. These existing memories look like the same subject; merge them with edit_memory if they overlap." } : memory,
        changed: true,
      };
    });
  }

  async edit(id: string, content: string) {
    const text = validContent(content);
    return this.write((memories) => {
      const memory = memories.find((item) => item.id === id);
      if (!memory) {
        log.warn("Memory edit rejected; unknown ID", { id, total: memories.length });
        throw new Error(`Memory ${id} not found`);
      }
      if (memory.content === text) return { result: memory, changed: false };
      const before = memory.content;
      memory.content = text;
      memory.updatedAt = new Date().toISOString();
      log.info("Edited memory", { id, before: preview(before, 120), after: preview(memory.content, 160) });
      return { result: memory, changed: true };
    });
  }

  async delete(id: string) {
    return this.write((memories) => {
      const index = memories.findIndex((item) => item.id === id);
      if (index < 0) {
        log.warn("Memory delete rejected; unknown ID", { id, total: memories.length });
        throw new Error(`Memory ${id} not found`);
      }
      const [removed] = memories.splice(index, 1);
      log.info("Deleted memory", { id, total: memories.length, content: preview(removed!.content, 160) });
      return { result: { ok: true, deleted: removed }, changed: true };
    });
  }

  /** Applies a change to a copy, persists it, and only then makes it the cached state. */
  private write<T>(change: (memories: Memory[]) => { result: T; changed: boolean }) {
    const write = this.writes.then(async () => {
      const elapsed = timer();
      const memories = (await this.load()).map((memory) => ({ ...memory }));
      const { result, changed } = change(memories);
      if (!changed) return result;
      await mkdir(dirname(this.file), { recursive: true });
      const temp = `${this.file}.${process.pid}.tmp`;
      const body = JSON.stringify(memories, null, 2);
      await writeFile(temp, body, { mode: 0o600 });
      await rename(temp, this.file);
      this.cache = Promise.resolve(memories);
      log.debug("Wrote memory file", { file: this.file, count: memories.length, bytes: body.length, ms: elapsed() });
      return result;
    });
    // The awaiting caller reports the failure; this keeps the write chain alive.
    this.writes = write.then(() => undefined, (error) => log.debug("Memory write rejected", { file: this.file, error: error instanceof Error ? error.message : String(error) }));
    return write;
  }
}
