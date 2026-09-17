import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { createLogger, timer } from "./logger.js";

const log = createLogger("channel-modes");

export class ChannelModes {
  private enabled = new Set<string>();
  private writes = Promise.resolve();

  constructor(private file: string) {}

  async load() {
    try {
      this.enabled = new Set(JSON.parse(await readFile(this.file, "utf8")) as string[]);
      log.info("Loaded channel auto modes", { file: this.file, enabled: this.list() });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        log.failure("Reading channel auto modes failed", error, { file: this.file });
        throw error;
      }
      log.info("No channel auto-mode file yet; starting with auto mode off", { file: this.file });
    }
    return this;
  }

  isEnabled(channel: string) {
    return this.enabled.has(channel);
  }

  list() {
    return [...this.enabled];
  }

  async set(channel: string, enabled: boolean) {
    const changed = this.enabled.has(channel) !== enabled;
    enabled ? this.enabled.add(channel) : this.enabled.delete(channel);
    const write = this.writes.then(async () => {
      const elapsed = timer();
      await mkdir(dirname(this.file), { recursive: true });
      const temp = `${this.file}.${process.pid}.tmp`;
      await writeFile(temp, JSON.stringify(this.list(), null, 2), { mode: 0o600 });
      await rename(temp, this.file);
      log.info("Channel auto mode set", { channel, enabled, changed, totalEnabled: this.enabled.size, ms: elapsed() });
    });
    // The awaiting caller reports the failure; this keeps the write chain alive.
    this.writes = write.then(() => undefined, (error) => log.debug("Channel auto-mode write rejected", { file: this.file, channel, enabled, error: error instanceof Error ? error.message : String(error) }));
    await write;
  }
}
