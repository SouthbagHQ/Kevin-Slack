import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

export type Memory = { id: string; content: string; createdAt: string };

export class MemoryStore {
  private writes = Promise.resolve();

  constructor(private file: string) {}

  async list() {
    try {
      return JSON.parse(await readFile(this.file, "utf8")) as Memory[];
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
  }

  async save(content: string) {
    const write = this.writes.then(async () => {
      const memories = await this.list();
      const memory = { id: randomUUID(), content: content.trim(), createdAt: new Date().toISOString() };
      memories.push(memory);
      await mkdir(dirname(this.file), { recursive: true });
      const temp = `${this.file}.${process.pid}.tmp`;
      await writeFile(temp, JSON.stringify(memories, null, 2), { mode: 0o600 });
      await rename(temp, this.file);
      return memory;
    });
    this.writes = write.then(() => undefined, () => undefined);
    return write;
  }
}
