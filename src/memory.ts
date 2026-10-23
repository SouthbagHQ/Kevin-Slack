import { randomUUID } from "node:crypto";
import { constants, copyFile, mkdir, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { createLogger, preview, timer } from "./logger.js";

export type Memory = { id: string; content: string; createdAt: string; updatedAt?: string };
/** What save_memory hands back: the record, plus a nudge when it duplicates or overlaps others. */
export type SavedMemory = Memory & { duplicate?: true; related?: ReturnType<typeof promptMemory>[]; note?: string };
/** One record a tidy pass keeps: its new text and the IDs of the records it replaces. */
export type Consolidated = { content: string; from: string[] };

/** What a conversation is about, for picking the memories worth showing: its words and the Slack IDs in it. */
export type MemoryFocus = { text?: string; ids?: Iterable<string | undefined> };

export const MAX_MEMORY_CHARS = 1_000;

const log = createLogger("memory");

const STOPWORDS = new Set("the and for are but not you your with this that have has had was were what when where who why how can could would should will just about from into than then them they their there here our out all any some its it's his her him she he kevin slack user does did don't doesn't".split(" "));
const SLACK_ID = /\b[UWCGDS][A-Z0-9]{6,}\b/g;
const BACKUPS_KEPT = 3;

/** The person a memory is mainly about: the first Slack user ID in it. */
export const memorySubject = (memory: Pick<Memory, "content">) => memory.content.match(/\b[UW][A-Z0-9]{6,}\b/)?.[0];

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
 * Scores every memory against a focus: a Slack ID the conversation mentions
 * counts most, then shared words (rarer words count more), with a small nudge
 * toward recently touched records. Highest first; ties keep store order.
 */
export const rankMemories = (memories: Memory[], focus: MemoryFocus) => {
  const ids = new Set([...(focus.ids ?? [])].filter((id): id is string => Boolean(id)));
  for (const id of slackIds(focus.text ?? "")) ids.add(id);
  const query = terms(focus.text ?? "");
  const indexed = memories.map((memory) => ({ memory, terms: terms(memory.content), ids: slackIds(memory.content) }));
  const frequency = new Map<string, number>();
  for (const { terms: words } of indexed) for (const word of words) if (query.has(word)) frequency.set(word, (frequency.get(word) ?? 0) + 1);
  const byAge = [...memories].sort((a, b) => touched(a).localeCompare(touched(b)));
  const recency = new Map(byAge.map((memory, index) => [memory.id, memories.length > 1 ? index / (memories.length - 1) : 1]));
  return indexed
    .map(({ memory, terms: words, ids: mentioned }, index) => {
      let score = 0;
      for (const id of mentioned) if (ids.has(id)) score += 4;
      for (const word of words) if (query.has(word)) score += Math.log(1 + memories.length / frequency.get(word)!);
      return { memory, score, recency: recency.get(memory.id) ?? 0, index };
    })
    .sort((a, b) => b.score - a.score || b.recency - a.recency || a.index - b.index);
};

/** The shape memories take in a prompt: no timestamps beyond the day it was last touched. */
export const promptMemory = (memory: Memory) => ({ id: memory.id, content: memory.content, ...(touched(memory) ? { date: touched(memory).slice(0, 10) } : {}) });

/**
 * The memories that fit in a prompt. Under the budget, all of them; over it,
 * the ones that bear on the focus first, then the most recent, in store order.
 */
export const selectMemories = (memories: Memory[], focus: MemoryFocus, budgetChars: number) => {
  const size = (memory: Memory) => memory.content.length + memory.id.length + 40;
  const total = memories.reduce((sum, memory) => sum + size(memory), 0);
  if (total <= budgetChars) return { memories, omitted: 0 };
  const ranked = rankMemories(memories, focus);
  const chosen = new Set<string>();
  let used = 0;
  const take = (memory: Memory) => {
    if (chosen.has(memory.id) || used + size(memory) > budgetChars) return;
    chosen.add(memory.id);
    used += size(memory);
  };
  // Relevant records get at most two thirds of the room so recent context always has some.
  for (const { memory, score } of ranked) if (score > 0 && used + size(memory) <= budgetChars * 0.66) take(memory);
  for (const memory of [...memories].sort((a, b) => touched(b).localeCompare(touched(a)))) take(memory);
  const selected = memories.filter((memory) => chosen.has(memory.id));
  return { memories: selected, omitted: memories.length - selected.length };
};

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
  /** Bumped on every change that reaches the disk, so a tidy pass can tell whether there is anything new. */
  version = 0;
  /** The file's contents, read once; every write goes through here, so it stays current. */
  private cache?: Promise<Memory[]>;

  constructor(private file: string) {}

  async list() {
    return [...(await this.load())];
  }

  /** The memories most related to a query, for the search tool. */
  async search(query: string, limit = 10) {
    const memories = await this.load();
    return rankMemories(memories, { text: query })
      .filter(({ score }) => score > 0)
      .slice(0, Math.max(1, Math.min(limit, 25)))
      .map(({ memory }) => promptMemory(memory));
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
      const subject = memorySubject(memory);
      // Records on the same person, or with mostly the same words: one record per subject is the goal.
      const related = memories
        .map((item) => ({ item, overlap: similarity(words, terms(item.content)) + (subject && memorySubject(item) === subject ? 1 : 0) }))
        .filter(({ overlap }) => overlap >= 0.5)
        .sort((a, b) => b.overlap - a.overlap)
        .slice(0, 3)
        .map(({ item }) => promptMemory(item));
      memories.push(memory);
      log.info("Saved memory", { id: memory.id, total: memories.length, related: related.length || undefined, content: preview(memory.content, 160) });
      return {
        result: related.length ? { ...memory, related, note: "Saved, but these records already cover the same person or subject. Next time, fold new facts into the existing record with edit_memory instead of adding another." } : memory,
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

  /**
   * Replaces a batch of records with their consolidated versions in one
   * write. Records not cited by any replacement are dropped. Nothing happens
   * if any record in the batch changed since it was read.
   */
  async consolidate(batch: Memory[], replacements: Consolidated[]) {
    return this.write<{ applied: boolean; before?: number; after?: number }>((memories) => {
      const current = new Map(memories.map((memory) => [memory.id, memory]));
      if (batch.some((memory) => current.get(memory.id)?.content !== memory.content)) {
        log.info("Memory consolidation skipped; records changed meanwhile", { batch: batch.length });
        return { result: { applied: false }, changed: false };
      }
      const ids = new Set(batch.map(({ id }) => id));
      const now = new Date().toISOString();
      const placed = new Map<string, Memory>();
      for (const { content, from } of replacements) {
        const sources = from.map((id) => current.get(id)!);
        const [first] = sources;
        const text = validContent(content);
        const unchanged = sources.length === 1 && first!.content === text;
        const createdAt = sources.map((source) => source.createdAt).sort()[0]!;
        placed.set(first!.id, unchanged ? first! : { id: first!.id, content: text, createdAt, updatedAt: now });
      }
      const next = memories.flatMap((memory) => (ids.has(memory.id) ? (placed.has(memory.id) ? [placed.get(memory.id)!] : []) : [memory]));
      const changed = next.length !== memories.length || next.some((memory, index) => memory !== memories[index]);
      memories.splice(0, memories.length, ...next);
      return { result: { applied: true, before: batch.length, after: placed.size }, changed };
    });
  }

  /** Copies the file aside, at most once a day so the day's copy is its earliest state, keeping the last few. */
  async backup() {
    const stamp = new Date().toISOString().slice(0, 10);
    const target = `${this.file}.bak-${stamp}`;
    await this.writes;
    try {
      await copyFile(this.file, target, constants.COPYFILE_EXCL);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "ENOENT") return undefined;
      if (code === "EEXIST") return target;
      throw error;
    }
    const prefix = `${basename(this.file)}.bak-`;
    const backups = (await readdir(dirname(this.file))).filter((name) => name.startsWith(prefix)).sort();
    for (const name of backups.slice(0, -BACKUPS_KEPT)) await rm(join(dirname(this.file), name), { force: true });
    log.info("Backed up memories", { backup: target });
    return target;
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
      this.version++;
      log.debug("Wrote memory file", { file: this.file, count: memories.length, bytes: body.length, ms: elapsed() });
      return result;
    });
    // The awaiting caller reports the failure; this keeps the write chain alive.
    this.writes = write.then(() => undefined, (error) => log.debug("Memory write rejected", { file: this.file, error: error instanceof Error ? error.message : String(error) }));
    return write;
  }
}
