import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { createLogger, timer } from "./logger.js";

const log = createLogger("thread-mutes");

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
      log.info("Loaded thread state", { file: this.file, muted: this.muted.size, subscribed: this.subscribed.size, legacyFormat: Array.isArray(state) });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        log.failure("Reading thread state failed", error, { file: this.file });
        throw error;
      }
      log.info("No thread-state file yet", { file: this.file });
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
    log.info("Thread muted", { thread: key, muted: this.muted.size });
    await this.save();
  }

  async subscribe(key: string) {
    const changed = !this.subscribed.has(key) || this.muted.has(key);
    const unmuted = this.muted.delete(key);
    this.subscribed.add(key);
    if (!changed) {
      log.trace("Thread already subscribed", { thread: key });
      return;
    }
    log.info("Thread subscribed", { thread: key, unmuted, subscribed: this.subscribed.size });
    await this.save();
  }

  private async save() {
    const write = this.writes.then(async () => {
      const elapsed = timer();
      await mkdir(dirname(this.file), { recursive: true });
      const temp = `${this.file}.${process.pid}.tmp`;
      await writeFile(temp, JSON.stringify({ muted: [...this.muted], subscribed: [...this.subscribed] }, null, 2), { mode: 0o600 });
      await rename(temp, this.file);
      log.debug("Wrote thread state", { file: this.file, muted: this.muted.size, subscribed: this.subscribed.size, ms: elapsed() });
    });
    // The awaiting caller reports the failure; this keeps the write chain alive.
    this.writes = write.then(() => undefined, (error) => log.debug("Thread-state write rejected", { file: this.file, error: error instanceof Error ? error.message : String(error) }));
    await write;
  }
}
