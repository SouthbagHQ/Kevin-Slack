import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { createLogger, preview, timer } from "./logger.js";

export type Memory = { id: string; content: string; createdAt: string; updatedAt?: string };

const log = createLogger("memory");

export class MemoryStore {
  private writes = Promise.resolve();

  constructor(private file: string) {}

  async list() {
    const elapsed = timer();
    try {
      const memories = JSON.parse(await readFile(this.file, "utf8")) as Memory[];
      log.debug("Loaded memories", { file: this.file, count: memories.length, ms: elapsed() });
      return memories;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        log.debug("No memory file yet", { file: this.file });
        return [];
      }
      log.failure("Reading memories failed", error, { file: this.file, ms: elapsed() });
      throw error;
    }
  }

  async save(content: string) {
    return this.write((memories) => {
      const memory = { id: randomUUID(), content: content.trim(), createdAt: new Date().toISOString() };
      memories.push(memory);
      log.info("Saved memory", { id: memory.id, total: memories.length, content: preview(memory.content, 160) });
      return memory;
    });
  }

  async edit(id: string, content: string) {
    return this.write((memories) => {
      const memory = memories.find((item) => item.id === id);
      if (!memory) {
        log.warn("Memory edit rejected; unknown ID", { id, total: memories.length });
        throw new Error(`Memory ${id} not found`);
      }
      const before = memory.content;
      memory.content = content.trim();
      memory.updatedAt = new Date().toISOString();
      log.info("Edited memory", { id, before: preview(before, 120), after: preview(memory.content, 160) });
      return memory;
    });
  }

  private write<T>(change: (memories: Memory[]) => T) {
    const write = this.writes.then(async () => {
      const elapsed = timer();
      const memories = await this.list();
      const result = change(memories);
      await mkdir(dirname(this.file), { recursive: true });
      const temp = `${this.file}.${process.pid}.tmp`;
      const body = JSON.stringify(memories, null, 2);
      await writeFile(temp, body, { mode: 0o600 });
      await rename(temp, this.file);
      log.debug("Wrote memory file", { file: this.file, count: memories.length, bytes: body.length, ms: elapsed() });
      return result;
    });
    // The awaiting caller reports the failure; this keeps the write chain alive.
    this.writes = write.then(() => undefined, (error) => log.debug("Memory write rejected", { file: this.file, error: error instanceof Error ? error.message : String(error) }));
    return write;
  }
}
