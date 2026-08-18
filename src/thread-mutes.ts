import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

export class ThreadMutes {
  private muted = new Set<string>();
  private subscribed = new Set<string>();
  private writes = Promise.resolve();

  constructor(private file: string) {}

  async load() {
    try {
      const state = JSON.parse(await readFile(this.file, "utf8")) as string[] | { muted: string[]; subscribed: string[] };
      this.muted = new Set(Array.isArray(state) ? state : state.muted);
      this.subscribed = new Set(Array.isArray(state) ? [] : state.subscribed);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    return this;
  }

  has(key: string) {
    return this.muted.has(key);
  }

  isSubscribed(key: string) {
    return this.subscribed.has(key);
  }

  async mute(key: string) {
    this.muted.add(key);
    await this.save();
  }

  async subscribe(key: string) {
    const changed = !this.subscribed.has(key) || this.muted.has(key);
    this.subscribed.add(key);
    this.muted.delete(key);
    if (!changed) return;
    await this.save();
  }

  private async save() {
    const write = this.writes.then(async () => {
      await mkdir(dirname(this.file), { recursive: true });
      const temp = `${this.file}.${process.pid}.tmp`;
      await writeFile(temp, JSON.stringify({ muted: [...this.muted], subscribed: [...this.subscribed] }, null, 2), { mode: 0o600 });
      await rename(temp, this.file);
    });
    this.writes = write.then(() => undefined, () => undefined);
    await write;
  }
}
