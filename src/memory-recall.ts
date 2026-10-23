import { cosine, type Embedder } from "./embeddings.js";
import { createLogger, timer } from "./logger.js";
import { promptMemory, rankMemories, type Memory, type MemoryFocus, type MemoryStore } from "./memory.js";

const log = createLogger("memory-recall");

export type RecallOptions = {
  /** Most records a prompt carries. */
  limit: number;
  /** Most characters of records a prompt carries. */
  budgetChars: number;
  /** Cosine similarity at which a record counts as related to the conversation. */
  minSimilarity: number;
};

export type Recalled = { memories: Memory[]; total: number; mode: "semantic" | "keyword" };

const DEFAULTS: RecallOptions = { limit: 25, budgetChars: 8_000, minSimilarity: 0.35 };
const EMBED_BATCH = 96;
const QUERY_CHARS = 2_000;
const QUERY_TIMEOUT_MS = 4_000;
/** After an embedding failure, keyword recall carries on alone for this long. */
const PAUSE_MS = 60_000;
/** Without embeddings, this much keyword overlap makes a record relevant (about one distinctive shared word); with them, twice as much. */
const MIN_LEXICAL = 2;

const size = (memory: Memory) => memory.content.length + memory.id.length + 40;

/**
 * Picks the memories that bear on a conversation. Kevin keeps everything;
 * this decides what He is reminded of. A record is relevant when it names
 * someone or somewhere in play, when its meaning is close to the
 * conversation (embeddings), or when it shares distinctive words with it.
 * Embedding trouble falls back to keywords and IDs, never to a failed turn.
 */
export class MemoryRecall {
  private vectors = new Map<string, { content: string; vector: Float32Array }>();
  private syncing: Promise<unknown> = Promise.resolve();
  private pausedUntil = 0;
  private options: RecallOptions;

  constructor(private store: Pick<MemoryStore, "list">, private embedder?: Embedder, options: Partial<RecallOptions> = {}) {
    this.options = { ...DEFAULTS, ...options };
  }

  private get embedding() {
    return Boolean(this.embedder) && Date.now() >= this.pausedUntil;
  }

  private pause(error: unknown, what: string) {
    this.pausedUntil = Date.now() + PAUSE_MS;
    log.warn(`${what} failed; using keyword recall for a minute`, { error: error instanceof Error ? error.message : String(error) });
  }

  /** Embeds every record that has no vector for its current text; runs one at a time so turns do not embed the same records twice. */
  prepare() {
    const run = this.syncing.then(() => this.sync());
    this.syncing = run.catch(() => undefined);
    return run;
  }

  private async sync() {
    const memories = await this.store.list();
    if (!this.embedding) return memories;
    const live = new Set(memories.map(({ id }) => id));
    for (const id of this.vectors.keys()) if (!live.has(id)) this.vectors.delete(id);
    const missing = memories.filter((memory) => this.vectors.get(memory.id)?.content !== memory.content);
    if (!missing.length) return memories;
    const elapsed = timer();
    try {
      for (let start = 0; start < missing.length; start += EMBED_BATCH) {
        const batch = missing.slice(start, start + EMBED_BATCH);
        const vectors = await this.embedder!.embed(batch.map(({ content }) => content));
        batch.forEach((memory, index) => this.vectors.set(memory.id, { content: memory.content, vector: vectors[index]! }));
      }
      log.info("Embedded memories", { embedded: missing.length, total: memories.length, ms: elapsed() });
    } catch (error) {
      this.pause(error, "Embedding memories");
    }
    return memories;
  }

  /** The focus as vectors: the message at hand, and the conversation around it. */
  private async queryVectors(focus: MemoryFocus) {
    if (!this.embedding) return [];
    const inputs = [focus.primary, focus.text].map((text) => text?.trim().slice(0, QUERY_CHARS)).filter((text): text is string => Boolean(text));
    if (!inputs.length) return [];
    try {
      return await this.embedder!.embed([...new Set(inputs)], QUERY_TIMEOUT_MS);
    } catch (error) {
      this.pause(error, "Embedding the conversation");
      return [];
    }
  }

  /** Every record scored against a focus, most relevant first, with whether it clears the bar. */
  private async score(focus: MemoryFocus, minSimilarity: number, minLexical = MIN_LEXICAL) {
    const [memories, queries] = await Promise.all([this.prepare(), this.queryVectors(focus)]);
    const semantic = queries.length > 0;
    const scored = rankMemories(memories, focus).map(({ memory, idHits, lexical }) => {
      const vector = this.vectors.get(memory.id);
      // The message itself counts fully; the wider conversation a little less.
      const similarity = semantic && vector ? Math.max(...queries.map((query, index) => cosine(query, vector.vector) * (index === 0 ? 1 : 0.9))) : 0;
      const relevant = idHits > 0 || (semantic ? similarity >= minSimilarity || lexical >= minLexical * 2 : lexical >= minLexical);
      return { memory, similarity, relevant, rank: similarity + 0.2 * Math.min(idHits, 2) + 0.03 * Math.min(lexical, 10) };
    });
    scored.sort((a, b) => b.rank - a.rank);
    return { scored, total: memories.length, mode: semantic ? "semantic" as const : "keyword" as const };
  }

  /** The records worth reminding Kevin of in this conversation, most relevant first. */
  async relevant(focus: MemoryFocus): Promise<Recalled> {
    const elapsed = timer();
    const { scored, total, mode } = await this.score(focus, this.options.minSimilarity);
    const memories: Memory[] = [];
    let used = 0;
    for (const { memory, relevant } of scored) {
      if (!relevant || memories.length >= this.options.limit) continue;
      if (used + size(memory) > this.options.budgetChars) continue;
      memories.push(memory);
      used += size(memory);
    }
    log.debug("Recalled memories", {
      mode,
      shown: memories.length,
      total,
      topSimilarity: scored.length && mode === "semantic" ? Math.max(...scored.map(({ similarity }) => similarity)).toFixed(3) : undefined,
      ms: elapsed(),
    });
    return { memories, total, mode };
  }

  /** The search tool: a looser bar than the prompt, since Kevin asked. */
  async search(query: string, limit = 10) {
    // Any shared word counts here.
    const { scored } = await this.score({ primary: query }, this.options.minSimilarity - 0.1, Number.MIN_VALUE);
    return scored
      .filter(({ relevant }) => relevant)
      .slice(0, Math.max(1, Math.min(Number(limit) || 10, 25)))
      .map(({ memory }) => promptMemory(memory));
  }
}
